// jobs.js — the nightly maintenance that pg_cron used to run.
/* ============================================================================

   Supabase shipped pg_cron, so the four maintenance functions were scheduled
   inside the database itself. Render's managed Postgres does not offer
   pg_cron, so the schedule moves out to a Render Cron Job that runs this file:

     node jobs.js

   Same functions, same order, same idempotence — only the thing holding the
   clock has changed. Each function is safe to run twice and safe to miss and
   run late; close_out_compliance_days() explicitly backfills any day it
   missed, which is what makes an external scheduler acceptable here. The
   one exception is snapshot_guardian_gaps() (054): it reads the gate as it
   stands and labels the rows "last night", so it may only run in the small
   hours (see snapshotGate()) — run late, it is skipped, not run wrong.

   Two crons run this file (render.yaml):
     hut-nightly   00:30 UTC daily      node jobs.js          close-out, purges, snapshots, the one nightly email
     hut-weekly    09:00 and 10:00 UTC  node jobs.js weekly   the Sunday Weekly Register Update, once, at 10:00 site time
     node jobs.js weekly --force    by hand: resend a missed Sunday return (still once per day)
   Two hours for the weekly run because Render's cron is UTC and the site's
   clock is not: the first run at or after the hour sends, the other records
   why it did not.

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
  // Which households had children on site and no guardian at midnight
  // (054), for the Children-without-a-guardian report. Its own row, not a
  // step inside the nightly email: it reads the gate as it stands and
  // cannot be backfilled, so it must not be lost to an unrelated failure
  // in the step before it or to the email switch being off. Re-running a
  // night already recorded is free (on conflict do nothing) — but only
  // inside the window: main() runs this one through snapshotGate(), since
  // "the gate as it stands" at 15:00 is not last night (see there).
  ["snapshot-guardian-gaps", "select snapshot_guardian_gaps(site_today() - 1)", LIVE_ONLY],
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
// lib/weeklyReport.js compose()) in the body; the Word attachment (052),
// which does carry the names and rooms the body leaves out, goes by default
// since 055 — a centre that wants counts only can still turn it off under
// Settings. The rows come from weekly_register_rows_unchecked(), the
// owner's copy: the checked one asks is_supervisor(), which a job is not.
const weekly = require('./lib/weeklyReport');
const safeguarding = require('./lib/safeguardingAlert');
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

// When the guardian-gap snapshot may be taken: 00:00–05:59 site time. The
// function reads the gate AS IT STANDS and labels the rows site_today() - 1,
// so it is only true of "last night" while the night is still recent: run
// at 00:30 by hut-nightly it is; run at 15:00 by an operator re-running
// `node jobs.js` after some other step failed, it would record the
// afternoon's households as the night before's — false rows in the
// Children-without-a-guardian report, under the night's date, with no way
// to tell them from real ones. Six hours because Render's cron is UTC and
// the site's clock is not, and because a retry a few hours late is still
// a fair picture of the night. Outside the window the step is skipped,
// recorded ok ("outside the snapshot window"), and the nightly email that
// counts it does not go: an email built on a missing night would say
// "nothing to report" about a child nobody has seen. There is no `force`:
// there is nothing a forced run could record that would be true. A 055
// follow-up should make the snapshot as-of-midnight with a seven-night
// backfill like 027's, at which point this gate goes (docs/KNOWN-ISSUES.md).
function snapshotGate({ localHour }) {
  if (Number.isInteger(localHour) && localHour >= 0 && localHour <= 5) return null;
  return 'outside the snapshot window';
}

// The snapshot-guardian-gaps step: the gate above, then the job. Answers
// true (ran), false (failed) or the gate's reason (skipped, recorded ok).
async function snapshotGuardianGaps(schema, label, name, sql) {
  let stop;
  try {
    stop = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select extract(hour from now() at time zone local_timezone)::int as local_hour from app_settings where id`);
      const reason = snapshotGate({ localHour: s?.local_hour });
      if (reason) await record(client, name, true, reason);
      return reason;
    });
  } catch (err) {
    console.error(`[jobs] ${label}${name}: FAILED — ${err.message}`);
    await withOwnerIn(schema, (client) => record(client, name, false, err.message)).catch(() => {});
    return false;
  }
  if (stop) { console.log(`[jobs] ${label}${name}: skipped — ${stop}`); return stop; }
  return runJob(schema, label, name, sql);
}

// Whether a tenant schema may be run at all. public.tenant_schema_gaps()
// (048) names the functions `public` has that a given `t_*` schema does
// not; a schema missing any is behind — provisioned before some migration
// landed and never brought current (docs/KNOWN-ISSUES.md #4). Answers the
// job_runs sentence, or null when the schema is current. A row that is not
// there at all (a tenants row whose schema was never provisioned) is
// behind too: Postgres silently skips a search_path entry that does not
// exist, so every unqualified name would resolve in public.
function schemaBehind(gapsRow) {
  if (!gapsRow) return 'schema not provisioned';
  const missing = Array.isArray(gapsRow.missing_functions) ? gapsRow.missing_functions : [];
  return missing.length ? `schema behind: ${missing.join(', ')}` : null;
}

// What tonight's email says, for one site: the four sections' lines and
// their links, read as the owner on base tables (see the queries). Shared
// by the 00:30 run (nightlyEmail) and "Send tonight's email now" under
// Settings (routes/settings.js), so a test send is the real message and
// not an imitation of it. `s` is the settings row nightlyEmail() selects.
async function nightlyMessage(client, s) {
  // Room label as v_resident_room writes it (016/018): the view filters on
  // is_staff(), which the owner is not, so the label is spelled out here.
  const ROOM = `(select b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number
                   from rooms rm join buildings b on b.id = rm.building_id where rm.id = r.room_id)`;

  // 1. Children on site without a guardian: the snapshot's own
  // households, named and roomed as the register reads today —
  // routes/reports.js REPORTS['guardian-gaps'] does the same, for a
  // staff reader with the household_label view; this is that shape on
  // base tables, for the owner, who has no such view to read.
  const { rows: gapRows } = await client.query(
    `with s as (select local_timezone as tz, adult_age_years as adult from app_settings where id)
     select
       -- coalesce: a household whose last active member departed between
       -- the snapshot step and this one would otherwise read "null family".
       coalesce((select string_agg(distinct btrim(r.last_name), ' / ' order by btrim(r.last_name)) from residents r
          where r.household_id = g.household_id and r.status = 'active') || ' family', 'Household') as household,
       (select string_agg(distinct rl, ', ' order by rl) from (select ${ROOM} as rl from residents r
          where r.household_id = g.household_id and r.status = 'active' and r.room_id is not null) x) as room,
       (select string_agg(btrim(r.first_name) || ' ' || btrim(r.last_name) || ' (' || date_part('year', age(r.date_of_birth))::int || ')', ', ' order by r.date_of_birth)
          from residents r
         where r.household_id = g.household_id and r.status = 'active'
           and r.date_of_birth > current_date - make_interval(years => s.adult)) as children,
       -- The household's adults, named: the gap means every one of them was
       -- off site at the snapshot (guardians_on_site = 0), so this list is
       -- who was out (17 Sep 2026, the owner: names of the adults too).
       (select string_agg(btrim(r.first_name) || ' ' || btrim(r.last_name), ', ' order by r.last_name, r.first_name)
          from residents r
         where r.household_id = g.household_id and r.status = 'active'
           and r.date_of_birth <= current_date - make_interval(years => s.adult)) as adults,
       g.guardians_out,
       to_char(g.first_out_at at time zone s.tz, 'HH24:MI') as first_out
     from overnight_guardian_gaps g cross join s
     where g.night = $1::date
     order by household`,
    [s.night]);

  // 2. Children away overnight without authorisation: the predicate of
  // overnight_safeguarding_count() (041), spelled out so the child can
  // be named and roomed alongside it. `with_adults` is the household's
  // adults who were also off site that night (17 Sep 2026, the owner: a
  // child out with a parent and a child out alone are different things,
  // and the email must say which).
  const { rows: awayRows } = await client.query(
    `with s as (select local_timezone as tz, adult_age_years as adult from app_settings where id)
     select btrim(r.first_name) || ' ' || btrim(r.last_name) as name,
            date_part('year', age(o.night, r.date_of_birth))::int as age,
            ${ROOM} as room,
            (select string_agg(btrim(a.first_name) || ' ' || btrim(a.last_name), ', ' order by a.last_name, a.first_name)
               from overnight_absences o2 join residents a on a.id = o2.resident_id
              where o2.night = o.night and r.household_id is not null and a.household_id = r.household_id
                and a.date_of_birth <= (o.night - make_interval(years => s.adult))::date) as with_adults
       from overnight_absences o
       join residents r on r.id = o.resident_id
       cross join s
      where o.night = $1::date
        and r.date_of_birth > (o.night - make_interval(years => s.adult))::date
        and not absence_authorised(r.id, o.night)
      order by r.last_name, r.first_name`,
    [s.night]);

  // 3. Check-ins recorded while signed out: the predicate of
  // checkin_conflict_count() (054), spelled out.
  const { rows: conflictRows } = await client.query(
    `with s as (select local_timezone as tz from app_settings where id)
     select btrim(r.first_name) || ' ' || btrim(r.last_name) as name,
            ${ROOM} as room,
            to_char(e.occurred_at at time zone s.tz, 'HH24:MI') as at,
            g.kind,
            to_char(g.occurred_at at time zone s.tz, 'HH24:MI') as gate_at
       from checkin_events e
       join residents r on r.id = e.resident_id
       cross join s
       left join lateral (
         select ge.kind, ge.occurred_at from gate_events ge
          where ge.resident_id = e.resident_id and ge.occurred_at <= e.occurred_at
          order by ge.occurred_at desc, ge.id desc limit 1) g on true
      where (e.occurred_at at time zone s.tz)::date = $1::date
        and (g.kind is null or g.kind = 'out')
      order by e.occurred_at`,
    [s.night]);

  // 4. At the House Rules figures: the register views filter on
  // is_staff(), which the nightly job is not; the same streak/window
  // figures as migration 015 defines them (closed, required, not
  // presented; the streak counts days after the latest presented day),
  // extended here with the resident's name and room.
  const { rows: figureRows } = await client.query(
    `with t as (
       select r.first_name, r.last_name,
              ${ROOM} as room,
              (select count(*)::int from daily_compliance x
                where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
                  and x.compliance_date > coalesce((select max(y.compliance_date) from daily_compliance y
                                                     where y.resident_id = r.id and y.required and y.presented and y.closed_at is not null), '1900-01-01'::date)) as consecutive_missed,
              (select count(*)::int from daily_compliance x
                where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
                  and x.compliance_date > site_today() - $3::int) as absent_in_window
         from residents r where r.status = 'active')
     select btrim(first_name) || ' ' || btrim(last_name) as name, room, consecutive_missed, absent_in_window
       from t
      where consecutive_missed >= $1 or absent_in_window >= $2
      order by last_name, first_name`,
    [s.nights, s.win_limit, s.win_days]);

  const items = {
    guardian_gaps: gapRows.map((r) =>
      `${r.household}${r.room ? ' · ' + r.room : ''} — children ${r.children || 'on site'}; ${r.adults ? `adult${r.guardians_out === 1 ? '' : 's'} ${r.adults}` : `${r.guardians_out} adult${r.guardians_out === 1 ? '' : 's'}`} signed out${r.first_out ? (r.guardians_out === 1 ? ' at ' : ', first at ') + r.first_out : ''}`),
    children_away: awayRows.map((r) =>
      `${r.name} (${r.age})${r.room ? ' · ' + r.room : ''} — off site at midnight, no authorised absence; ${r.with_adults ? 'out with ' + r.with_adults : 'NO ADULT from the household out with them'}`),
    conflicts: conflictRows.map((r) =>
      `${r.name}${r.room ? ' · ' + r.room : ''} — checked in ${r.at}, ${r.kind ? 'the In & out register had them out since ' + r.gate_at : 'no sign-in on record'}`),
    at_figures: figureRows.map((r) => {
      const parts = [];
      if (r.consecutive_missed >= s.nights) parts.push(`${r.consecutive_missed} nights in a row missed`);
      if (r.absent_in_window >= s.win_limit) parts.push(`${r.absent_in_window} missed in the last ${s.win_days} nights`);
      return `${r.name}${r.room ? ' · ' + r.room : ''} — ${parts.join('; ')}`;
    }),
  };
  const total = Object.values(items).reduce((sum, arr) => sum + arr.length, 0);

  // Each link lands on the page that has the names, for the night the
  // count is about — see reportLink() above. The guardian-gap count
  // reads the table the snapshot-guardian-gaps step wrote earlier in
  // this same run, and its link opens the named "Children on site
  // without a guardian" report for that night, not the live Families
  // tab: the report is the night the count is about, and opening it is
  // audited (routes/reports.js).
  const links = {
    guardianGaps: reportLink({ tab: 'reports', report: 'guardian-gaps', from: s.night, to: s.night }),
    overnight: reportLink({ tab: 'reports', report: 'overnight', from: s.night, to: s.night }),
    conflicts: reportLink({ tab: 'reports', report: 'checkin-conflicts', from: s.night, to: s.night }),
    absences: reportLink({ tab: 'absences', from: s.night, to: s.night }),
  };
  return { items, total, links };
}

// The one nightly email (054), "Tonight at <site>". It replaced two: the
// House Rules reminder (032), which went to every supervisor and admin
// after close-out, and the overnight safeguarding alert (041), which went
// to the ticked staff after the snapshot. One message now, after the
// snapshot, to the ticked staff, with four sections in a fixed order — each
// a heading, the names behind it, and a link (lib/nightlyEmail.js). Names
// since 055: the owner's ruling of 16 September 2026, reversing ec793da for
// this email — the manager reads it at breakfast and must not need a login
// to know which family. The rows are read here, as the owner, on base
// tables, rather than through overnight_safeguarding_count() and
// checkin_conflict_count(): both stay, for the compliance suite and anyone
// else that only wants the count, but neither feeds this email any more —
// their predicates are spelled out below so a name can ride along with each
// row:
//
//   children on site without a guardian        overnight_guardian_gaps, written below
//   children away overnight without authorisation   the predicate of overnight_safeguarding_count() (041), spelled out
//   check-ins recorded while signed out        the predicate of checkin_conflict_count() (054), spelled out
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
      if (!s || !s.on) { await record(client, name, true, 'off'); return 'off'; }
      if (!mail.isConfigured() && process.env.HUT_MAIL_SINK !== '1') {
        await record(client, name, false, 'mail not configured');
        return 'mail not configured';
      }
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

      const { items, total, links } = await nightlyMessage(client, s);
      if (!total && s.dow !== 7) { await record(client, name, true, 'nothing to report'); return 'nothing to report'; }
      const slug = await prefs.slugForSchema(client, schema);
      let delivered = 0;
      for (const r of staff) {
        // One compose per person: the footer link is theirs alone.
        const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'nightly' });
        const { subject, text, html } = nightly.compose({ siteName: s.site_name, night: s.night, items, links, unsubscribe });
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

// "Send tonight's email now" (Settings): the same message the 00:30 run
// would send about last night, to the same ticked staff, right now. It
// ignores the site switch and the once-a-night guard — it is how an admin
// checks the email works before relying on it — and it writes no job_runs
// row, so tonight's real run still goes; the route records it on the
// audit trail instead ('sent by hand', like the weekly). Throws, rather
// than records, when there is nothing to send with: the admin is at the
// screen and reads the message.
async function nightlyByHand(client, schema) {
  const { rows: [s] } = await client.query(
    `select site_name, local_timezone,
            warn_after_consecutive_nights as nights, absence_window_limit as win_limit, absence_window_days as win_days,
            to_char(site_today() - 1, 'YYYY-MM-DD') as night,
            extract(isodow from site_today())::int as dow
       from app_settings where id`);
  if (!mail.isConfigured() && process.env.HUT_MAIL_SINK !== '1') throw new Error('Mail is not configured on this server');
  const staff = await safeguarding.recipients(client);
  if (!staff.length) throw new Error('Tick at least one supervisor or admin to get the nightly email under Staff first');
  const { items, total, links } = await nightlyMessage(client, s);
  const slug = await prefs.slugForSchema(client, schema);
  let delivered = 0;
  for (const r of staff) {
    const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'nightly' });
    const { subject, text, html } = nightly.compose({ siteName: s.site_name, night: s.night, items, links, unsubscribe });
    const out = await mail.send({ to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe) });
    if (out.delivered) delivered += 1;
  }
  return { night: s.night, total, sent: delivered, recipients: staff.length };
}

async function main(mode = process.argv[2], { keepPool = false, force = process.argv.includes('--force') } = {}) {
  // 'nightly' is accepted as a synonym for no mode at all — the test process
  // calls main() explicitly rather than relying on the argv default, and
  // `main(undefined, ...)` would otherwise re-read process.argv[2] instead of
  // meaning "no mode".
  const isNightly = mode === undefined || mode === 'nightly';
  if (!isNightly && mode !== 'weekly') throw new Error(`[jobs] unknown mode "${mode}"`);
  let failed = 0;

  const { rows: tenants } = await withOwner((client) => client.query(
    "select slug, status from public.tenants where status <> 'closed' order by created_at"));
  // Once per run, for the guard below: which t_* schemas are behind public.
  const { rows: gapRows } = await withOwner((client) => client.query(
    "select schema, missing_functions from public.tenant_schema_gaps()"));
  const gapsBySchema = new Map(gapRows.map((r) => [r.schema, r]));

  for (const t of tenants) {
    let schema;
    try { schema = tenancy.schemaForSlug(t.slug); } catch (err) { console.error(`[jobs] ${t.slug}: ${err.message}`); failed += 1; continue; }
    const label = t.slug === tenancy.LEGACY_SLUG ? "" : `${t.slug} · `;

    // A tenant schema that is behind runs NOTHING — not the email jobs,
    // not the purges — in every mode. searchPath() is `t_x, public,
    // extensions`, so an unqualified name the tenant's schema lacks does
    // not fail: it falls through to public's copy, which reads public's
    // tables. For a purge that is a harmless no-op against the legacy
    // centre's own rows; for the email jobs it is another centre's data.
    // overnight_guardian_gaps, checkin_conflict_count() and
    // snapshot_guardian_gaps() (054) are all unqualified in the jobs
    // above, so on a tenant provisioned before 054 the nightly email would
    // have counted the LEGACY centre's households for this tenant's staff,
    // and linked them to a report of them. A behind schema is an operator
    // problem (bring it
    // current or close it; docs/KNOWN-ISSUES.md #4), so it is refused whole
    // and recorded ok=false as `schema-check`, which v_system_health shows.
    if (schema !== 'public') {
      const gapsRow = gapsBySchema.get(schema);
      const behind = schemaBehind(gapsRow);
      if (behind) {
        console.error(`[jobs] ${label}schema-check: FAILED — ${behind}`);
        // Nowhere to record a schema that does not exist: the insert would
        // fall through to public.job_runs and show on the wrong centre.
        if (gapsRow) await withOwnerIn(schema, (client) => record(client, 'schema-check', false, behind)).catch(() => {});
        failed += 1;
        continue;
      }
    }

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
    // live tenant, and none of the nightly maintenance around it. `force`
    // applies to it — `node jobs.js weekly --force` is the manual resend of
    // a missed Sunday return; nightly mode ignores it.
    if (mode === 'weekly') {
      if (live && !(await weeklyRegister(schema, label, { force }))) failed += 1;
      continue;
    }

    if (!live) console.log(`[jobs] ${label}${t.status} — purges only`);

    // The nightly email reads both snapshots — who was off site at midnight,
    // and which households had children and no guardian — so it runs after
    // the second and only if both succeeded. A failed snapshot is already
    // counted; the point is not to send on a missing one: a missing night
    // is indistinguishable from "nobody was away" or "no household was in
    // the state", and an email built on it would say "nothing to report"
    // about a child nobody has seen. The weekly return no longer runs from
    // here at all — see 'weekly' mode above and hut-weekly in render.yaml,
    // which checks the overnight snapshot itself via sendGate().
    // The guardian-gap snapshot has a third outcome — skipped, outside its
    // window (snapshotGate()) — which is not a failure but still no night
    // to count, so the email stays unsent for the same reason.
    let snapshotsOk = true;
    let snapshotSkipped = null;
    for (const [name, sql, liveOnly] of TENANT_JOBS) {
      if (liveOnly && !live) continue;
      const ok = name === 'snapshot-guardian-gaps'
        ? await snapshotGuardianGaps(schema, label, name, sql)
        : await runJob(schema, label, name, sql);
      if (ok === false) failed += 1;
      if (typeof ok === 'string') snapshotSkipped = ok;
      if (name === 'snapshot-overnight-absences' || name === 'snapshot-guardian-gaps') snapshotsOk = snapshotsOk && ok === true;
      if (name === 'snapshot-guardian-gaps') {
        if (snapshotsOk) {
          if (!(await nightlyEmail(schema, label))) failed += 1;
        } else {
          const why = snapshotSkipped ? `skipped: ${snapshotSkipped}` : 'skipped: snapshot failed';
          console.log(`[jobs] ${label}nightly-email: ${why}`);
          await withOwnerIn(schema, (client) => record(client, 'nightly-email', true, why)).catch(() => {});
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

module.exports = { weeklyRegister, sendGate, snapshotGate, schemaBehind, nightlyEmail, nightlyByHand, main };
if (require.main === module) main().catch((err) => {
  console.error("[jobs] fatal:", err);
  process.exit(1);
});
