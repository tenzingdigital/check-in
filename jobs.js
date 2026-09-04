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

const { closePool, withOwner } = require('./database');

// Order matters only in that close-out runs first: it writes the negative rows
// for the day just ended, and the purges below must not race ahead of a day
// that has not been closed yet.
const JOBS = [
  ["close-out-compliance-days", "select public.close_out_compliance_days()"],
  ["purge-expired-gate-events", "select public.purge_expired_gate_events()"],
  ["purge-expired-checkin-events", "select public.purge_expired_checkin_events()"],
  ["purge-expired-compliance", "select public.purge_expired_compliance()"],
  ["purge-expired-sessions", "select auth.purge_expired_sessions()"],
  ["purge-expired-password-resets", "select auth.purge_expired_password_resets()"],
  ["expire-lapsed-trials", "select public.expire_lapsed_trials()"],
  ["purge-expired-login-events", "select auth.purge_expired_login_events()"],
  ["purge-expired-audit", "select public.purge_expired_audit()"],
  ["purge-expired-job-runs", "select public.purge_expired_job_runs()"],
  // Autovacuum never analyses a table with fewer than ~50 changed rows, so
  // app_settings (one row) and a small residents table can carry the
  // planner's default guess of ~300 rows forever. Cross-joined into every
  // view, that guess is how a 200-row query was costed at 85,000 rows and
  // JIT-compiled on every run (docs/KNOWN-ISSUES.md 19d). Cheap, nightly.
  ["analyze-small-tables", "analyze public.app_settings, public.residents, public.profiles, public.daily_compliance"],
];

// Every run leaves a row, so v_system_health can say when close-out last
// succeeded and a terminal can show a banner when it is late. A failure to
// record the row is logged, never fatal.
async function record(name, ok, result) {
  try {
    await withOwner((client) => client.query(
      "insert into public.job_runs (job, ok, result) values ($1, $2, $3)",
      [name, ok, String(result ?? "").slice(0, 500)],
    ));
  } catch (err) {
    console.error(`[jobs] could not record ${name}: ${err.message}`);
  }
}

async function main() {
  let failed = 0;

  for (const [name, sql] of JOBS) {
    const started = Date.now();
    try {
      const result = await withOwner((client) => client.query(sql));
      const value = Object.values(result.rows[0] ?? {})[0];
      console.log(`[jobs] ${name}: ok (${value ?? "done"}) in ${Date.now() - started}ms`);
      await record(name, true, value);
    } catch (err) {
      // Keep going. These jobs are independent, and a failure in one purge
      // must not stop close-out from running — the register is the thing that
      // matters, retention is the thing that can wait a day.
      failed += 1;
      console.error(`[jobs] ${name}: FAILED — ${err.message}`);
      await record(name, false, err.message);
    }
  }

  await closePool();
  // A non-zero exit marks the run red in Render's dashboard, which is the only
  // way anyone finds out a maintenance job has been failing quietly.
  process.exit(failed ? 1 : 0);
}

main();
