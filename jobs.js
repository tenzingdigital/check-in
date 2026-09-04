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
  ["purge-expired-gate-events", "select purge_expired_gate_events()"],
  ["purge-expired-checkin-events", "select purge_expired_checkin_events()"],
  ["purge-expired-compliance", "select purge_expired_compliance()"],
  ["purge-expired-audit", "select purge_expired_audit()"],
  ["purge-expired-job-runs", "select purge_expired_job_runs()"],
  ["purge-expired-roll-calls", "select purge_expired_roll_calls()"],
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

main().catch((err) => {
  console.error("[jobs] fatal:", err);
  process.exit(1);
});
