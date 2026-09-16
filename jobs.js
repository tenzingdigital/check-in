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

   Three crons run this file (render.yaml):
     hut-nightly   00:30 UTC daily      node jobs.js          close-out, purges, snapshots, the one nightly email
     hut-weekly    09:00 and 10:00 UTC  node jobs.js weekly   the Sunday Weekly Register Update, once, at 10:00 site time
     hut-evening   21:00 and 22:00 UTC  node jobs.js evening  the 22:00 guardian alert, once, at 22:00 site time
     node jobs.js weekly --force    by hand: resend a missed Sunday return (still once per day)
     node jobs.js evening --force   by hand: send the 22:00 alert now (still once per day)
   Two hours each for the weekly and evening runs because Render's cron is
   UTC and the site's clock is not: the first run at or after the hour sends,
   the other records why it did not.

   `close-out` is the one that is not optional. Without it, daily_compliance
   only ever gains rows from record_checkin() — the positive path — so nobody
   is ever recorded as having missed a day and the register silently stops
   proving compliance at all. If you cut this cron job to save a dollar, that
   is the thing you are cutting.
   ========================================================================= */

const { closePool, withOwner, withOwnerIn } = require('./database');
const tenancy = require('./lib/tenancy');
const prefs = require('./lib/emailPrefs');

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
  // Who was off site at midnight (migration 027). The last SEVEN nights, not
  // just the one that ended: the function only ever did one night and could
  // not backfill, unlike its sibling close_out_compliance_days(), so a night
  // the scheduler missed stayed missing forever. That matters because a gap is
  // indistinguishable from "everyone was present" -- weekly_absence_spans()
  // groups by consecutive nights, so one hole splits a real absence in two and
  // the Sunday email then tells head office a resident came back on a day they
  // were still away. Re-running a night already recorded is free: the insert is
  // `on conflict do nothing`.
  ["snapshot-overnight-absences",
   `select coalesce(sum(public.snapshot_overnight_absences(g.d::date)), 0)::int
      from generate_series((public.site_today() - 7)::timestamp,
                           (public.site_today() - 1)::timestamp,
                           interval '1 day') g(d)`,
   LIVE_ONLY],
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
  // Appendix 5 arrangements go with the register they belong to (053).
  ["purge-supervision-arrangements", "select purge_supervision_arrangements()"],
  // The nightly record of children on site with no guardian, likewise (054).
  ["purge-guardian-gaps", "select purge_guardian_gaps()"],
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

// The emails the jobs send. lib/mail.js sends; each composer below shapes
// one message; lib/emailPrefs.js (required at the top) mints the per-person
// footer link and the List-Unsubscribe headers that go with it.
const mail = require('./lib/mail');

// The Sunday Weekly Register Update (migration 035): on a Sunday, after
// Saturday night's snapshot, the staff ticked to receive it (migration 037)
// are emailed counts and a link, never a resident name (migration 038 — see
// lib/weeklyReport.js compose()) in the body; the Word attachment (052) is
// the exception, where the centre has turned it on. The rows come from
// weekly_register_rows_unchecked(), the owner's copy: the checked one asks
// is_supervisor(), which a job is not.
const weekly = require('./lib/weeklyReport');
const safeguarding = require('./lib/safeguardingAlert');
const guardian = require('./lib/guardianAlert');
const nightly = require('./lib/nightlyEmail');

// The cron process has no request to build a link from, so it reads
// PUBLIC_URL directly (see render.yaml). Unset — a misconfigured deploy — is
// not the job's problem to fix: compose() sends the email regardless, with
// the link left out and a sentence naming Admin → Reports instead. Never a
// relative or broken link.
//
// `params` lands the reader on the report the email is about, for the nights
// it is about (admin.html reads tab/report/from/to — see readDeepLink()
// there). An email that says "11 children" and then opens on a screen
// defaulting to the last seven days makes the reader re-enter the dates the
// email already knew, at 1am, which is how the wrong night gets looked at.
// Nothing here is a credential: the link is to a screen that still demands a
// login, and the report behind it still demands a reason and is still
// audited.
function reportLink(params) {
  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return null;
  const query = params ? `?${new URLSearchParams(params)}` : '';
  return `${configured}/admin.html${query}`;
}

// When the Sunday return may go. Four things, in this order, each recorded
// in job_runs when it stops the run: it is Sunday at the site; it is 10:00
// or later there (the centre manager reviews it over Sunday-morning coffee,
// not at 01:30, and by 10:00 the night workers who left on Saturday are
// back and read as such); Saturday night's snapshot ran, since a week
// missing its last night would quietly omit it; and nothing has already
// gone today (checked by the caller, not here — see weeklyRegister()).
// `force` — `node jobs.js weekly --force` by hand, and the tests — is "send
// now regardless of when" and skips the first three; it never skips the
// fourth. Run again the same day and "already sent today" still stops it, so
// re-running --force cannot double-send; run it on any other day and it is
// the recovery for a Sunday return that was missed.
function sendGate({ dow, localHour, snapshotOk, force = false }) {
  if (force) return null;
  if (dow !== 7) return 'not Sunday';
  if (localHour < 10) return 'before 10:00';
  if (!snapshotOk) return 'snapshot not run';
  return null;
}

async function weeklyRegister(schema, label, { force = false } = {}) {
  const name = 'weekly-register-email';
  const started = Date.now();
  try {
    const summary = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select weekly_report_email as on, weekly_report_attach_document as attach, site_name, local_timezone,
                to_char(site_today(), 'YYYY-MM-DD') as today, extract(isodow from site_today())::int as dow,
                extract(hour from now() at time zone local_timezone)::int as local_hour
           from app_settings where id`);
      if (!s || !s.on) { await record(client, name, true, 'off'); return 'off'; }
      // Recipients are the staff ticked to receive it (migration 037), not a
      // setting: every address is a known person with a login.
      const staff = await weekly.recipients(client);
      if (!staff.length) { await record(client, name, true, 'no recipients'); return 'no recipients'; }
      const { rows: snap } = await client.query(
        `select 1 from job_runs
          where job = 'snapshot-overnight-absences' and ok
            and (ran_at at time zone $1)::date = $2::date limit 1`,
        [s.local_timezone, s.today]);
      const stop = sendGate({ dow: s.dow, localHour: s.local_hour, snapshotOk: snap.length > 0, force });
      if (stop) { await record(client, name, true, stop); return stop; }
      // Idempotence: a second run today (an operator re-running `node
      // jobs.js` after some other step failed) must not email head office
      // twice. A successful send's result always ends "emailed" (see below);
      // 'off', 'no recipients' and the calendar/clock/snapshot gates do not
      // match, so they never block a later run once the condition that
      // produced them changes.
      // `force` bypasses the calendar, clock and snapshot gates in sendGate()
      // above (its documented job, for manual and test runs) — it does NOT
      // bypass this. A forced run is still a real send with a real
      // duplicate-email risk if run twice, and the guard being real under
      // force is also what makes it possible to test without waiting for an
      // actual Sunday.
      // Match a run that actually DELIVERED to somebody. The old pattern was
      // `result ~ 'emailed$'`, which "12 rows, 0/3 emailed" also matches —
      // mail.send() never throws, it returns {delivered:false} — so a total
      // delivery failure recorded ok, blocked every retry that day, and left
      // system health green while the statutory Sunday return did not go.
      // `[1-9]\d*/` is "at least one delivered".
      const { rows: already } = await client.query(
        `select 1 from job_runs
           where job = $1 and ok and result ~ '[1-9][0-9]*/[0-9]+ emailed$'
             and (ran_at at time zone $2)::date = $3::date
           limit 1`,
        [name, s.local_timezone, s.today]);
      if (already.length) { await record(client, name, true, 'already sent today'); return 'already sent today'; }
      const slug = await prefs.slugForSchema(client, schema);
      const { from, to } = weekly.lastWeek(s.today);
      const { rows } = await client.query('select * from weekly_register_rows_unchecked($1, $2)', [from, to]);
      const doc = s.attach ? weekly.document({ siteName: s.site_name, from, to, rows, generatedOn: s.today }) : null;
      let delivered = 0;
      for (const r of staff) {
        // One compose per person: the footer link is theirs alone.
        const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'weekly_report' });
        const { subject, text, html } = weekly.compose({
          siteName: s.site_name, from, to, rows,
          link: reportLink({ tab: 'reports', report: 'weekly', from, to }),
          unsubscribe, attached: !!doc,
        });
        const out = await mail.send({
          to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe),
          ...(doc ? { attachments: [{ filename: doc.filename, content: doc.buffer, contentType: doc.contentType }] } : {}),
        });
        if (out.delivered) delivered += 1;
      }
      // A partial or total delivery failure is not a successful run. Recording
      // ok=false is what puts it in front of somebody: v_system_health reads
      // these rows, and a Sunday return that reached nobody is exactly the
      // quiet failure the health banner exists for.
      const result = `${rows.length} rows, ${delivered}/${staff.length} emailed`;
      const allDelivered = delivered === staff.length;
      await record(client, name, allDelivered, result);
      if (!allDelivered) {
        console.error(`[jobs] ${name}: ${staff.length - delivered} of ${staff.length} recipients did not receive the weekly register`);
      }
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

// When the 22:00 guardian alert may go: at 22:00 site time or later. One
// gate, because the other things the Sunday return waits for do not apply —
// it is every day, and it reads the gate as it stands rather than a
// snapshot. 22:00 is when a child left for the evening has plainly been left
// overnight, and early enough that a manager can still go to a door. `force`
// (`node jobs.js evening --force`, and the tests) skips the clock and only
// the clock: "already sent today" is checked by the caller and still stops
// a second run, so a forced run cannot double-send.
function eveningGate({ localHour, force = false }) {
  if (force) return null;
  if (localHour < 22) return 'before 22:00';
  return null;
}

// The 22:00 guardian alert (054). A household with children on site, every
// guardian signed OUT at the gate and no supervision arrangement running is
// the one fact in this app a count cannot serve: somebody has to go to a
// door tonight, and needs to know which. So this is the one email that
// names residents in its body (lib/guardianAlert.js says why, and
// docs/GDPR.md records it), and it goes only to the staff ticked for the
// safeguarding alert — supervisors and admins with a login, whose duty it
// is to act. Behind feature_households, because the fact is defined by
// households, and behind nightly_email, the one switch for both messages.
//
// guardian_gaps_now() is the supervisor's function run as the owner: it
// refuses a guard by identity and lets a caller with none through, exactly
// as email_link_key() (049) does, which is why it is never granted to anon.
async function guardianAlert(schema, label, { force = false } = {}) {
  const name = 'guardian-alert-email';
  const started = Date.now();
  try {
    const summary = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select nightly_email as on, feature_households as households, site_name, local_timezone,
                to_char(site_today(), 'YYYY-MM-DD') as today,
                extract(hour from now() at time zone local_timezone)::int as local_hour
           from app_settings where id`);
      if (!s || !s.on) { await record(client, name, true, 'off'); return 'off'; }
      if (!s.households) { await record(client, name, true, 'households off'); return 'households off'; }
      const staff = await safeguarding.recipients(client);
      if (!staff.length) { await record(client, name, true, 'no recipients'); return 'no recipients'; }
      const stop = eveningGate({ localHour: s.local_hour, force });
      if (stop) { await record(client, name, true, stop); return stop; }
      // Once a day, and "once" means delivered to somebody: the same guard
      // as the weekly return, for the same reasons (see weeklyRegister()).
      // The two cron hours make a second run a certainty, not a mishap.
      const { rows: already } = await client.query(
        `select 1 from job_runs
           where job = $1 and ok and result ~ '[1-9][0-9]*/[0-9]+ emailed$'
             and (ran_at at time zone $2)::date = $3::date
           limit 1`,
        [name, s.local_timezone, s.today]);
      if (already.length) { await record(client, name, true, 'already sent today'); return 'already sent today'; }
      const { rows: gaps } = await client.query('select * from guardian_gaps_now()');
      // A clear evening sends nothing. Unlike the nightly email there is no
      // Sunday nil: a message that names nobody has no door to point at,
      // and job_runs is the evidence the check ran.
      if (!gaps.length) { await record(client, name, true, 'nothing to report'); return 'nothing to report'; }

      const slug = await prefs.slugForSchema(client, schema);
      let delivered = 0;
      for (const r of staff) {
        // One compose per person: the footer link is theirs alone.
        const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'guardian_alert' });
        const { subject, text, html } = guardian.compose({
          siteName: s.site_name,
          gaps,
          link: reportLink({ tab: 'families' }),
          unsubscribe,
          timeZone: s.local_timezone,
        });
        const out = await mail.send({ to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe) });
        if (out.delivered) delivered += 1;
      }
      const result = `${gaps.length} households, ${delivered}/${staff.length} emailed`;
      const allDelivered = delivered === staff.length;
      await record(client, name, allDelivered, result);
      if (!allDelivered) {
        console.error(`[jobs] ${name}: ${staff.length - delivered} of ${staff.length} recipients did not receive the guardian alert`);
      }
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

// The one nightly email (054), "Tonight at <site>". It replaced two: the
// House Rules reminder (032), which went to every supervisor and admin
// after close-out, and the overnight safeguarding alert (041), which went
// to the ticked staff after the snapshot. One message now, after the
// snapshot, to the ticked staff, with four sections in a fixed order — each
// a count and a link, never a name (lib/nightlyEmail.js):
//
//   children on site without a guardian        overnight_guardian_gaps, written below
//   children away overnight without authorisation   overnight_safeguarding_count() (041)
//   check-ins recorded while signed out        checkin_conflict_count() (054)
//   at the House Rules figures                 the thresholds of 032, computed here
//
// An under-18 away overnight with no authorised absence recorded reaches no
// other screen in this app: v_resident_compliance evaluates 'exempt' before
// everything else, so a child never has required_today true, never appears
// under Not seen, and never reaches attention_list(). The source is the In &
// out register — overnight_absences is derived from gate_events (027) —
// because children are not on the daily register at all.
//
// Sent on any night something is non-zero, and every Sunday regardless, so
// a week of silence is never mistaken for a job that stopped. job_runs
// records every run either way; the mail is a convenience and never the
// only evidence.
async function nightlyEmail(schema, label) {
  const name = 'nightly-email';
  const started = Date.now();
  try {
    const summary = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select nightly_email as on, site_name, local_timezone,
                warn_after_consecutive_nights as nights, absence_window_limit as win_limit, absence_window_days as win_days,
                to_char(site_today() - 1, 'YYYY-MM-DD') as night,
                to_char(site_today(), 'YYYY-MM-DD') as today,
                extract(isodow from site_today())::int as dow
           from app_settings where id`);
      if (!s) { await record(client, name, true, 'no settings'); return 'no settings'; }

      // The night's record of children on site with no guardian, for the
      // Children-without-a-guardian report, taken before any switch is
      // read: the report is kept whether or not anyone is emailed about it.
      // A re-run is free (on conflict do nothing).
      await client.query('select snapshot_guardian_gaps($1::date)', [s.night]);

      if (!s.on) { await record(client, name, true, 'off'); return 'off'; }
      const staff = await safeguarding.recipients(client);
      if (!staff.length) { await record(client, name, true, 'no recipients'); return 'no recipients'; }

      // Same idempotence shape as the weekly return, and for the same reason:
      // an operator re-running `node jobs.js` must not send twice. "at least
      // one delivered" rather than merely "ran", so a night that reached
      // nobody retries instead of recording itself as done.
      const { rows: already } = await client.query(
        `select 1 from job_runs
           where job = $1 and ok and result ~ '[1-9][0-9]*/[0-9]+ emailed$'
             and (ran_at at time zone $2)::date = $3::date
           limit 1`,
        [name, s.local_timezone, s.today]);
      if (already.length) { await record(client, name, true, 'already sent today'); return 'already sent today'; }

      const { rows: [gaps] } = await client.query('select count(*)::int as n from overnight_guardian_gaps where night = $1::date', [s.night]);
      const { rows: [away] } = await client.query('select overnight_safeguarding_count($1::date) as n', [s.night]);
      const { rows: [conflicts] } = await client.query('select checkin_conflict_count($1::date) as n', [s.night]);
      // The register views filter on is_staff(), which the nightly job is
      // not; the same two figures are computed here from the ledger, with
      // the definitions of migration 015 (closed, required, not presented;
      // the streak counts days after the latest presented day).
      const { rows: figures } = await client.query(
        `with t as (
           select (select count(*)::int from daily_compliance x
                    where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
                      and x.compliance_date > coalesce((select max(y.compliance_date) from daily_compliance y
                                                         where y.resident_id = r.id and y.required and y.presented and y.closed_at is not null), '1900-01-01'::date)) as consecutive_missed,
                  (select count(*)::int from daily_compliance x
                    where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
                      and x.compliance_date > site_today() - $3::int) as absent_in_window
             from residents r where r.status = 'active')
         select * from t where consecutive_missed >= $1 or absent_in_window >= $2`, [s.nights, s.win_limit, s.win_days]);
      const counts = {
        guardian_gaps: Number(gaps.n) || 0,
        children_away: Number(away.n) || 0,
        conflicts: Number(conflicts.n) || 0,
        at_figures: figures.length,
      };
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      if (!total && s.dow !== 7) { await record(client, name, true, 'nothing to report'); return 'nothing to report'; }

      // Each link lands on the page that has the names, for the night the
      // count is about — see reportLink() above.
      const links = {
        families: reportLink({ tab: 'families' }),
        overnight: reportLink({ tab: 'reports', report: 'overnight', from: s.night, to: s.night }),
        conflicts: reportLink({ tab: 'reports', report: 'checkin-conflicts', from: s.night, to: s.night }),
        absences: reportLink({ tab: 'absences', from: s.night, to: s.night }),
      };
      const slug = await prefs.slugForSchema(client, schema);
      let delivered = 0;
      for (const r of staff) {
        // One compose per person: the footer link is theirs alone.
        const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'nightly' });
        const { subject, text, html } = nightly.compose({ siteName: s.site_name, night: s.night, counts, links, unsubscribe });
        const out = await mail.send({ to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe) });
        if (out.delivered) delivered += 1;
      }
      const result = `${total} to look at, ${delivered}/${staff.length} emailed`;
      const allDelivered = delivered === staff.length;
      await record(client, name, allDelivered, result);
      if (!allDelivered) {
        console.error(`[jobs] ${name}: ${staff.length - delivered} of ${staff.length} recipients did not receive the nightly email`);
      }
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

async function main(mode = process.argv[2], { keepPool = false, force = process.argv.includes('--force') } = {}) {
  // 'nightly' is accepted as a synonym for no mode at all — the test process
  // calls main() explicitly rather than relying on the argv default, and
  // `main(undefined, ...)` would otherwise re-read process.argv[2] instead of
  // meaning "no mode".
  const isNightly = mode === undefined || mode === 'nightly';
  if (!isNightly && mode !== 'weekly' && mode !== 'evening') throw new Error(`[jobs] unknown mode "${mode}"`);
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

    // 'weekly' mode is the Sunday cron: only the weekly return, for every
    // live tenant, and none of the nightly maintenance around it. 'evening'
    // mode is the 22:00 cron: only the guardian alert, likewise. `force`
    // applies to those two — `node jobs.js weekly --force` is the manual
    // resend of a missed Sunday return, `node jobs.js evening --force` the
    // manual send of the alert; nightly mode ignores it.
    if (mode === 'weekly') {
      if (live && !(await weeklyRegister(schema, label, { force }))) failed += 1;
      continue;
    }
    if (mode === 'evening') {
      if (live && !(await guardianAlert(schema, label, { force }))) failed += 1;
      continue;
    }

    if (!live) console.log(`[jobs] ${label}${t.status} — purges only`);

    for (const [name, sql, liveOnly] of TENANT_JOBS) {
      if (liveOnly && !live) continue;
      const ok = await runJob(schema, label, name, sql);
      if (!ok) failed += 1;
      if (name === 'snapshot-overnight-absences') {
        // A failed snapshot already counted above. The weekly return no
        // longer runs from here at all — see 'weekly' mode above and
        // hut-weekly in render.yaml, which checks this same snapshot itself
        // via sendGate(). Only the nightly email is decided here now.
        if (ok) {
          // The email reads the snapshot the step above just wrote, so it
          // depends on it exactly as the weekly return does: a missing night
          // is indistinguishable from "nobody was away", and an email built
          // on one would say "nothing to report" about a child nobody has
          // seen. Skip and record the skip rather than send that.
          if (!(await nightlyEmail(schema, label))) failed += 1;
        } else {
          console.log(`[jobs] ${label}nightly-email: skipped — snapshot-overnight-absences failed`);
          await withOwnerIn(schema, (client) => record(client, 'nightly-email', true, 'skipped: snapshot failed')).catch(() => {});
        }
      }
    }
  }

  if (isNightly) {
    for (const [name, sql] of PLATFORM_JOBS) {
      if (!(await runJob("public", "", name, sql))) failed += 1;
    }
  }

  if (!keepPool) await closePool();
  if (failed) {
    console.error(`[jobs] ${failed} job(s) failed`);
    if (!keepPool) process.exit(1);
  }
  return failed;
}

module.exports = { weeklyRegister, sendGate, guardianAlert, eveningGate, nightlyEmail, main };
if (require.main === module) main().catch((err) => {
  console.error("[jobs] fatal:", err);
  process.exit(1);
});
