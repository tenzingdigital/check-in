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
const TENANT_JOBS = [
  ["close-out-compliance-days", "select close_out_compliance_days()"],
  // Who was off site at midnight, for the night just ended (migration 027).
  ["snapshot-overnight-absences", "select snapshot_overnight_absences()"],
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
  ["analyze-small-tables", "analyze app_settings, residents, profiles, daily_compliance"],
];

// Platform jobs: shared tables, run once.
const PLATFORM_JOBS = [
  ["purge-expired-sessions", "select auth.purge_expired_sessions()"],
  ["purge-expired-password-resets", "select auth.purge_expired_password_resets()"],
  ["purge-expired-login-events", "select auth.purge_expired_login_events()"],
  ["purge-expired-mfa", "select auth.purge_expired_mfa()"],
  ["expire-lapsed-trials", "select public.expire_lapsed_trials()"],
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

async function main() {
  let failed = 0;

  const { rows: tenants } = await withOwner((client) => client.query(
    "select slug, status from public.tenants where status <> 'closed' order by created_at"));

  for (const t of tenants) {
    let schema;
    try { schema = tenancy.schemaForSlug(t.slug); } catch (err) { console.error(`[jobs] ${t.slug}: ${err.message}`); failed += 1; continue; }
    const label = t.slug === tenancy.LEGACY_SLUG ? "" : `${t.slug} · `;
    for (const [name, sql] of TENANT_JOBS) {
      if (!(await runJob(schema, label, name, sql))) failed += 1;
      if (name === 'close-out-compliance-days' && !(await notifyThresholds(schema, label))) failed += 1;
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

module.exports = { notifyThresholds };
if (require.main === module) main().catch((err) => {
  console.error("[jobs] fatal:", err);
  process.exit(1);
});
