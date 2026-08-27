// seed-today.js — DEMO DATA. Give every active resident a check-in today.
//
// For demo databases only, like seed.sql / seed-200.sql: it fabricates
// register entries, so it must never run against a register that holds real
// people. Each resident with no check-in yet today (site-local) gets one
// checkin_event at a random time between local midnight and now, attributed
// to the oldest active staff account, plus the matching daily_compliance row.
// Residents already seen today are left alone, which also makes it idempotent
// — safe to run twice, or to leave the boot flag set by accident.
//
// Two ways to run it:
//   DATABASE_URL="postgres://…" node seed-today.js       (by hand)
//   SEED_TODAY_CHECKINS=1                                 (once, at boot —
//     server.js calls run() after migrate; remove the env var afterwards)

const db = require('./database');

const SEED_SQL = `
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
      checkin_count = dc.checkin_count + 1
returning resident_id;
`;

async function run() {
  return db.withOwner(async (client) => {
    const { rowCount } = await client.query(SEED_SQL);
    console.log(`[seed-today] ${rowCount} resident(s) given a check-in today`);
    return rowCount;
  });
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => db.closePool())
    .catch((err) => { console.error(`[seed-today] ${err.message}`); process.exit(1); });
}
