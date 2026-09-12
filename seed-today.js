// seed-today.js — DEMO DATA. Shape today's register so every state is visible.
//
// For demo databases only, like seed.sql / seed-200.sql: it fabricates and
// deletes register entries, so it must never run against a register that
// holds real people.
//
// The shape it sculpts, over the active residents:
//   - 2 residents NEVER SEEN: all their check-in history is removed, so the
//     register shows state 'never'.
//   - 5 residents OVERDUE: not seen today, with one to three missed closed
//     days behind them, so the register shows an open breach and the
//     attention list has something to say.
//   - everyone else: checked in at least once today, at scattered times
//     between local midnight and now, attributed to the oldest active staff
//     account.
//
// The picks are stable (ordered by md5 of the resident id) and residents
// already seen today keep their existing events, so re-running converges on
// the same shape rather than reshuffling it.
//
// Two ways to run it:
//   DATABASE_URL="postgres://…" node seed-today.js       (by hand)
//   SEED_TODAY_CHECKINS=1                                 (once, at boot —
//     server.js calls run() after migrate; remove the env var afterwards)

const db = require('./database');

const NEVER = 2;
const OVERDUE = 5;

// Everyone active with no check-in yet today gets one at a random time
// between local midnight and now.
const CHECKIN_SQL = `
with s as (
  select local_timezone as tz, adult_age_years as aa
  from public.app_settings where id
),
today as (select public.site_today() as d),
guard as (
  select id from public.profiles where active order by created_at limit 1
),
day_start as (
  select ((select d from today)::timestamp at time zone s.tz) as t0 from s
),
targets as (
  select r.id as resident_id,
         (select t0 from day_start)
           + random() * (now() - (select t0 from day_start)) as ts
  from public.residents r
  where r.status = 'active'
    and exists (select 1 from guard)
    and not exists (
      select 1 from public.checkin_events c, s
      where c.resident_id = r.id
        and (c.occurred_at at time zone s.tz)::date = (select d from today)
    )
),
ins as (
  insert into public.checkin_events (resident_id, guard_id, occurred_at)
  select t.resident_id, (select id from guard), t.ts
  from targets t
  returning resident_id, occurred_at
)
insert into public.daily_compliance as dc
  (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
select i.resident_id,
       (select d from today),
       public.compliance_required(
         r.date_of_birth,
         (r.registered_at at time zone s.tz)::date,
         r.departed_on, (select d from today), s.aa),
       true, i.occurred_at, 1
from ins i
join public.residents r on r.id = i.resident_id
cross join s
on conflict (resident_id, compliance_date) do update
  set presented     = true,
      first_seen_at = least(dc.first_seen_at, excluded.first_seen_at),
      checkin_count = dc.checkin_count + 1;
`;

// Stable picks: the first NEVER go to 'never', the next OVERDUE to 'overdue'.
const PICK_SQL = `
with active as (
  select id, row_number() over (order by md5(id::text)) as rn
  from public.residents
  where status = 'active'
)
select coalesce(array_agg(id) filter (where rn <= $1), '{}')                    as never_ids,
       coalesce(array_agg(id) filter (where rn > $1 and rn <= $1 + $2), '{}')   as overdue_ids
from active;
`;

// One to three missed, closed, required days per overdue resident, counting
// back from yesterday — enough for a breach and a visible streak.
const BREACH_SQL = `
insert into public.daily_compliance as dc
  (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
select u.id, public.site_today() - g, true, false, null, 0, now()
from unnest($1::uuid[]) with ordinality as u(id, ord)
cross join lateral generate_series(1, 1 + (u.ord::int % 3)) g
on conflict (resident_id, compliance_date) do update
  set required = true, presented = false, first_seen_at = null,
      checkin_count = 0, closed_at = now();
`;

async function run() {
  return db.withOwner(async (client) => {
    await client.query('begin');
    try {
      const { rowCount: seeded } = await client.query(CHECKIN_SQL);

      const { rows: [pick] } = await client.query(PICK_SQL, [NEVER, OVERDUE]);
      const shaped = pick.never_ids.concat(pick.overdue_ids);

      if (shaped.length) {
        // The never and overdue residents lose today's (and, for 'never', all)
        // check-in history before their target state is written.
        await client.query(
          `delete from public.checkin_events where resident_id = any($1::uuid[])`,
          [shaped]);
        await client.query(
          `delete from public.daily_compliance where resident_id = any($1::uuid[])`,
          [shaped]);
        await client.query(BREACH_SQL, [pick.overdue_ids]);
      }

      await client.query('commit');
      console.log(
        `[seed-today] shaped: ${seeded} check-in(s) added today, ` +
        `${pick.overdue_ids.length} overdue with open breaches, ` +
        `${pick.never_ids.length} never seen`);
      return seeded;
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => db.closePool())
    .catch((err) => { console.error(`[seed-today] ${err.message}`); process.exit(1); });
}
