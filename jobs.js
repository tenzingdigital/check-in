// jobs.js — the nightly maintenance that pg_cron used to run.
/* ============================================================================

   Supabase shipped pg_cron, so the four maintenance functions were scheduled
   inside the database itself. Render's managed Postgres does not offer
   pg_cron, so the schedule moves out to a Render Cron Job that runs this file:

     node jobs.js

   Same functions, same order, same idempotence — only the thing holding the
   clock has changed. Each function is safe to run twice and safe to miss and
   run late; close_out_compliance_days() explicitly backfills any day it
   missed, which is what makes an external scheduler acceptable here.

   `close-out` is the one that is not optional. Without it, daily_compliance
   only ever gains rows from record_checkin() — the positive path — so nobody
   is ever recorded as having missed a day and the register silently stops
   proving compliance at all. If you cut this cron job to save a dollar, that
   is the thing you are cutting.
   ========================================================================= */

const { closePool, withOwner, withOwnerIn } = require('./database');
const tenancy = require('./lib/tenancy');

// Order matters only in that close-out runs first: it writes the negative rows
// for the day just ended, and the purges below must not race ahead of a day
// that has not been closed yet.
// Per-tenant jobs: run inside each centre's schema (search_path), so every
// unqualified name here resolves to that centre's copy. Since migration 020
// the nightly run visits every open tenant, the legacy one (public) included.
//
// The third element marks a job that only makes sense for a centre that may
// still record: a trial or an active contract. A centre that may not write —
// an expired trial, a suspended contract — gets the purges below and nothing
// else. See `live` in main().
//
// This is not a micro-optimisation. Measured on an abandoned sample trial,
// one nightly run wrote 60 rows into daily_compliance and 30 into the
// overnight snapshot: the register dutifully recording, every night, that
// thirty fictional people had missed their check-in in a centre nobody will
// open again. The purges must keep running regardless — retention is a
// promise in the DPA, and they only ever delete.
const LIVE_ONLY = true;

const TENANT_JOBS = [
  ["close-out-compliance-days", "select close_out_compliance_days()", LIVE_ONLY],
  // Who was off site at midnight, for the night just ended (migration 027).
  ["snapshot-overnight-absences", "select snapshot_overnight_absences()", LIVE_ONLY],
  ["purge-expired-gate-events", "select purge_expired_gate_events()"],
  ["purge-expired-checkin-events", "select purge_expired_checkin_events()"],
  ["purge-expired-compliance", "select purge_expired_compliance()"],
  ["purge-expired-audit", "select purge_expired_audit()"],
  ["purge-expired-job-runs", "select purge_expired_job_runs()"],
  ["purge-expired-roll-calls", "select purge_expired_roll_calls()"],
  ["purge-resident-views", "select purge_resident_views()"],
  ["purge-expired-visits", "select purge_expired_visits()"],
  ["purge-expired-overnight-absences", "select purge_expired_overnight_absences()"],
  ["purge-expired-authorised-absences", "select purge_expired_authorised_absences()"],
  ["purge-expired-breach-reports", "select purge_expired_breach_reports()"],
  // app_settings (one row) and a small residents table can carry the
  // planner's default guess of ~300 rows forever. Cross-joined into every
  // view, that guess is how a 200-row query was costed at 85,000 rows and
  // JIT-compiled on every run (docs/KNOWN-ISSUES.md 19d). Cheap, nightly.
  ["analyze-small-tables", "analyze app_settings, residents, profiles, daily_compliance", LIVE_ONLY],
];

// Platform jobs: shared tables, run once.
const PLATFORM_JOBS = [
  ["purge-expired-sessions", "select auth.purge_expired_sessions()"],
  ["purge-expired-password-resets", "select auth.purge_expired_password_resets()"],
  ["purge-expired-login-events", "select auth.purge_expired_login_events()"],
  ["purge-expired-mfa", "select auth.purge_expired_mfa()"],
  ["expire-lapsed-trials", "select public.expire_lapsed_trials()"],
  // Self-serve trial requests: unconfirmed ones are rubbish after a day,
  // confirmed ones are kept a fortnight so support can answer "I signed up and
  // nothing arrived", then go. Neither holds resident data (migration 034).
  ["sweep-signup-requests", "select public.sweep_signup_requests()"],
];

// Every run leaves a row, so v_system_health can say when close-out last
// succeeded and a terminal can show a banner when it is late. A failure to
// record the row is logged, never fatal.
async function record(client, name, ok, result) {
  try {
    await client.query(
      "insert into job_runs (job, ok, result) values ($1, $2, $3)",
      [name, ok, String(result ?? "").slice(0, 500)],
    );
  } catch (err) {
    console.error(`[jobs] could not record ${name}: ${err.message}`);
  }
}

// One job, inside one schema, in its own transaction — a failed purge in one
// centre must not stop close-out in the next. The job_runs row is written in
// the same schema, so each centre's v_system_health reads its own.
async function runJob(schema, label, name, sql) {
  const started = Date.now();
  try {
    const value = await withOwnerIn(schema, async (client) => {
      const result = await client.query(sql);
      const v = Object.values(result.rows[0] ?? {})[0];
      await record(client, name, true, v);
      return v;
    });
    console.log(`[jobs] ${label}${name}: ok (${value ?? "done"}) in ${Date.now() - started}ms`);
    return true;
  } catch (err) {
    console.error(`[jobs] ${label}${name}: FAILED — ${err.message}`);
    await withOwnerIn(schema, (client) => record(client, name, false, err.message)).catch(() => {});
    return false;
  }
}

// The House Rules reminder (migration 032): after close-out, where the
// centre has turned it on and email is configured, every active supervisor
// and administrator gets the list of residents at or over a figure. Sent
// only on nights there is anyone to list. The app states facts; the
// letter is the manager's.
const mail = require('./lib/mail');
async function notifyThresholds(schema, label) {
  const name = 'notify-thresholds-email';
  const started = Date.now();
  try {
    const summary = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select notify_thresholds_email as on, site_name, warn_after_consecutive_nights as nights,
                absence_window_limit as win_limit, absence_window_days as win_days from app_settings where id`);
      if (!s || !s.on) { await record(client, name, true, 'off'); return 'off'; }
      // The register views filter on is_staff(), which the nightly job is
      // not; the same two figures are computed here from the ledger, with
      // the definitions of migration 015 (closed, required, not presented;
      // the streak counts days after the latest presented day).
      const { rows } = await client.query(
        `with t as (
           select btrim(r.first_name) || ' ' || btrim(r.last_name) as full_name, room_label_of(r.room_id) as room_label,
                  (select count(*)::int from daily_compliance x
                    where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
                      and x.compliance_date > coalesce((select max(y.compliance_date) from daily_compliance y
                                                         where y.resident_id = r.id and y.required and y.presented and y.closed_at is not null), '1900-01-01'::date)) as consecutive_missed,
                  (select count(*)::int from daily_compliance x
                    where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
                      and x.compliance_date > site_today() - $3::int) as absent_in_window
             from residents r where r.status = 'active')
         select * from t where consecutive_missed >= $1 or absent_in_window >= $2
         order by consecutive_missed desc, absent_in_window desc, full_name`, [s.nights, s.win_limit, s.win_days]);
      if (!rows.length) { await record(client, name, true, 'nobody at a figure'); return 'nobody'; }
      const { rows: to } = await client.query(
        `select u.email, p.full_name from profiles p join auth.users u on u.id = p.id
          where p.active and p.role in ('supervisor', 'admin') and u.email is not null`);
      if (!to.length) { await record(client, name, true, 'no recipients'); return 'no recipients'; }
      const lines = rows.map((r) => `- ${r.full_name}${r.room_label ? ` (${r.room_label})` : ''}: ${r.consecutive_missed} consecutive night${r.consecutive_missed === 1 ? '' : 's'}, ${r.absent_in_window} of ${s.win_limit} days in ${s.win_days}`);
      const text = `${s.site_name || 'CheckSteady'}: ${rows.length} resident${rows.length === 1 ? '' : 's'} at or over a House Rules figure after last night's close-out.\n\n` +
        `Figures in Settings: ${s.nights} consecutive nights; ${s.win_limit} days absent in ${s.win_days}.\n\n${lines.join('\n')}\n\n` +
        `The app records the facts; whether a letter or a breach report follows is the manager's decision. ` +
        `Authorised absences are already left out. Details under Admin → Absences.`;
      let delivered = 0;
      for (const r of to) {
        const out = await mail.send({ to: r.email, subject: `${s.site_name || 'CheckSteady'}: ${rows.length} at a House Rules figure`, text });
        if (out.delivered) delivered += 1;
      }
      await record(client, name, true, `${rows.length} listed, ${delivered}/${to.length} emailed`);
      return `${rows.length} listed, ${delivered}/${to.length} emailed`;
    });
    console.log(`[jobs] ${label}${name}: ok (${summary}) in ${Date.now() - started}ms`);
    return true;
  } catch (err) {
    console.error(`[jobs] ${label}${name}: FAILED — ${err.message}`);
    await withOwnerIn(schema, (client) => record(client, name, false, err.message)).catch(() => {});
    return false;
  }
}

// The Sunday Weekly Register Update (migration 035): on a Sunday, after
// Saturday night's snapshot, the staff ticked to receive it (migration 037)
// are emailed the week's absences, weekend updates, removals and room
// updates as plain text. The rows come from weekly_register_rows_unchecked(),
// the owner's copy: the checked one asks is_supervisor(), which a job is not.
const weekly = require('./lib/weeklyReport');
async function weeklyRegister(schema, label, { force = false } = {}) {
  const name = 'weekly-register-email';
  const started = Date.now();
  try {
    const summary = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select weekly_report_email as on, site_name, local_timezone,
                to_char(site_today(), 'YYYY-MM-DD') as today, extract(isodow from site_today())::int as dow
           from app_settings where id`);
      if (!s || !s.on) { await record(client, name, true, 'off'); return 'off'; }
      // Recipients are the staff ticked to receive it (migration 037), not a
      // setting: every address is a known person with a login.
      const { rows: staff } = await client.query(
        `select u.email from profiles p join auth.users u on u.id = p.id
          where p.active and p.weekly_report and u.email is not null`);
      if (!staff.length) { await record(client, name, true, 'no recipients'); return 'no recipients'; }
      if (s.dow !== 7 && !force) { await record(client, name, true, 'not Sunday'); return 'not Sunday'; }
      // Idempotence: a second run today (an operator re-running `node
      // jobs.js` after some other step failed) must not email head office
      // twice. A successful send's result always ends "emailed" (see below);
      // 'off', 'no recipients' and 'not Sunday' do not match, so they never
      // block a later run once the condition that produced them changes.
      // `force` bypasses only the Sunday gate above (its documented job, for
      // manual and test runs) — it does NOT bypass this. A forced run is
      // still a real send with a real duplicate-email risk if run twice, and
      // the guard being real under force is also what makes it possible to
      // test without waiting for an actual Sunday.
      const { rows: already } = await client.query(
        `select 1 from job_runs
           where job = $1 and ok and result ~ 'emailed$'
             and (ran_at at time zone $2)::date = $3::date
           limit 1`,
        [name, s.local_timezone, s.today]);
      if (already.length) { await record(client, name, true, 'already sent today'); return 'already sent today'; }
      const { from, to } = weekly.lastWeek(s.today);
      const { rows } = await client.query('select * from weekly_register_rows_unchecked($1, $2)', [from, to]);
      const { subject, text } = weekly.compose({ siteName: s.site_name, from, to, rows });
      let delivered = 0;
      for (const r of staff) {
        const out = await mail.send({ to: r.email, subject, text });
        if (out.delivered) delivered += 1;
      }
      const result = `${rows.length} rows, ${delivered}/${staff.length} emailed`;
      await record(client, name, true, result);
      return result;
    });
    console.log(`[jobs] ${label}${name}: ok (${summary}) in ${Date.now() - started}ms`);
    return true;
  } catch (err) {
    console.error(`[jobs] ${label}${name}: FAILED — ${err.message}`);
    await withOwnerIn(schema, (client) => record(client, name, false, err.message)).catch(() => {});
    return false;
  }
}

async function main() {
  let failed = 0;

  const { rows: tenants } = await withOwner((client) => client.query(
    "select slug, status from public.tenants where status <> 'closed' order by created_at"));

  for (const t of tenants) {
    let schema;
    try { schema = tenancy.schemaForSlug(t.slug); } catch (err) { console.error(`[jobs] ${t.slug}: ${err.message}`); failed += 1; continue; }
    const label = t.slug === tenancy.LEGACY_SLUG ? "" : `${t.slug} · `;

    // The same question public.tenant_may_write() asks of the API, asked here
    // of the night's work: may this centre still record anything? A lapsed
    // trial or a suspended contract may not, so writing its register would be
    // recording days nobody was ever asked to attend. It keeps the purges.
    //
    // Nothing is lost by waiting: close_out_compliance_days() backfills every
    // day it missed, so a centre that later activates has its register closed
    // out from where it left off on the next run.
    const live = t.status === 'trial' || t.status === 'active';
    if (!live) console.log(`[jobs] ${label}${t.status} — purges only`);

    for (const [name, sql, liveOnly] of TENANT_JOBS) {
      if (liveOnly && !live) continue;
      const ok = await runJob(schema, label, name, sql);
      if (!ok) failed += 1;
      if (name === 'close-out-compliance-days' && !(await notifyThresholds(schema, label))) failed += 1;
      if (name === 'snapshot-overnight-absences') {
        // A failed snapshot already counted above; a Sunday email built on a
        // week missing Saturday night would quietly omit it, so the weekly
        // report is skipped rather than sent, and that is not a second
        // failure — only recorded, so the skip is visible in job_runs.
        if (ok) {
          if (!(await weeklyRegister(schema, label))) failed += 1;
        } else {
          console.log(`[jobs] ${label}weekly-register-email: skipped — snapshot-overnight-absences failed`);
          await withOwnerIn(schema, (client) => record(client, 'weekly-register-email', true, 'skipped: snapshot failed')).catch(() => {});
        }
      }
    }
  }

  for (const [name, sql] of PLATFORM_JOBS) {
    if (!(await runJob("public", "", name, sql))) failed += 1;
  }

  await closePool();
  if (failed) {
    console.error(`[jobs] ${failed} job(s) failed`);
    process.exit(1);
  }
}

module.exports = { notifyThresholds, weeklyRegister };
if (require.main === module) main().catch((err) => {
  console.error("[jobs] fatal:", err);
  process.exit(1);
});
