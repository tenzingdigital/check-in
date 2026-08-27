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
];

async function main() {
  let failed = 0;

  for (const [name, sql] of JOBS) {
    const started = Date.now();
    try {
      const result = await withOwner((client) => client.query(sql));
      const value = Object.values(result.rows[0] ?? {})[0];
      console.log(`[jobs] ${name}: ok (${value ?? "done"}) in ${Date.now() - started}ms`);
    } catch (err) {
      // Keep going. These jobs are independent, and a failure in one purge
      // must not stop close-out from running — the register is the thing that
      // matters, retention is the thing that can wait a day.
      failed += 1;
      console.error(`[jobs] ${name}: FAILED — ${err.message}`);
    }
  }

  await closePool();
  // A non-zero exit marks the run red in Render's dashboard, which is the only
  // way anyone finds out a maintenance job has been failing quietly.
  process.exit(failed ? 1 : 0);
}

main();
