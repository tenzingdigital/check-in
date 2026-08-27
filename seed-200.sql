-- ============================================================================
-- Large demo data — OPTIONAL. Run only on a test project.
--
-- Tops the residents table up to 200 invented people, each with a room, a
-- realistic age (a handful of minors, so the 18+ exemption is visible), a few
-- departed, occasional operational notes, and gate history spread so the gate
-- page shows every timing state: signed in recently, approaching the 24-hour
-- mark, well past it, currently out, and never seen at all.
--
-- Safe to re-run: it only inserts as many residents as are missing below 200,
-- never a name combination that already exists, and gate events only for the
-- residents it created in that same run. On a database already holding 200 or
-- more residents it does nothing.
--
-- Like seed.sql, this file is for TEST DATABASES ONLY. Do not run it against
-- a live register (GDPR Art. 5(1)(d) — accuracy).
-- ============================================================================

with g as (
  select id from public.profiles order by created_at limit 1
),
pool as (
  select f.fn as first_name, l.ln as last_name
  from unnest(array[
    'Aisling','Bartek','Chidi','Dara','Elena','Farid','Grainne','Hassan',
    'Ivana','Jakub','Katarzyna','Liam','Mateusz','Nkechi','Oisin','Patryk',
    'Roisin','Samir','Tereza','Una','Viktor','Wojciech','Yusuf','Zofia',
    'Amara','Brendan','Cormac','Dominika','Emeka','Fionnuala'
  ]) as f(fn)
  cross join unnest(array[
    'Adeyemi','Byrne','Coleman','Doyle','Egan','Farrell','Gallagher','Horvath',
    'Ibrahim','Jankowski','Kavanagh','Lynch','Murphy','Novak','Osei','Petrov',
    'Quinn','Reilly','Szabo','Traore','Ushakov','Vasile','Walsh','Yilmaz',
    'Zielinski','Adebayo','Brogan','Cullen','Duffy','Eze'
  ]) as l(ln)
),
-- Shuffle deterministically-ish and drop any name pair already registered, so
-- re-running (or running after seed.sql) never creates the same person twice.
shuffled as (
  select p.first_name, p.last_name,
         row_number() over (order by md5(p.first_name || ' ' || p.last_name)) as rn
  from pool p
  where not exists (
    select 1 from public.residents r
    where r.first_name = p.first_name and r.last_name = p.last_name
  )
),
-- Roll the per-row randoms in a CTE that references each row, NOT in an
-- uncorrelated lateral subquery — the planner evaluates the latter once for
-- the whole statement, which would make every resident share one dice roll.
rolled as (
  select s.first_name, s.last_name,
         random() as u_minor, random() as u_departed, random() as u_note
  from shuffled s
  where s.rn <= greatest(0, 200 - (select count(*) from public.residents))
),
new_residents as (
  insert into public.residents
    (first_name, last_name, date_of_birth, room_ref, status, departed_on, note)
  select
    s.first_name,
    s.last_name,
    -- ~6% minors (13–17), the rest adults (20–65).
    case when s.u_minor < 0.06
      then current_date - (4745 + floor(random() * 1600)::int)
      else current_date - (7300 + floor(random() * 16500)::int)
    end,
    -- Rooms A-01 .. D-24.
    chr(65 + floor(random() * 4)::int) || '-' || lpad((1 + floor(random() * 24)::int)::text, 2, '0'),
    case when s.u_departed < 0.05 then 'departed' else 'active' end,
    case when s.u_departed < 0.05 then current_date - (1 + floor(random() * 180)::int) end,
    case when s.u_note < 0.07 then (array[
      'Works nights, usually signs in around 07:00',
      'Uses the side gate',
      'Hard of hearing — knock loudly',
      'Keyworker visits on Tuesdays',
      'Usually accompanied by a family member'
    ])[1 + floor(random() * 5)::int] end
  from rolled s
  returning id, status
),
-- One gate-history plan per new active resident:
--   u < 0.15          never seen (no events)
--   0.15 <= u < 0.60  currently in, signed in 0.5–47.5 hours ago
--                     (spread across fine / due soon / overdue)
--   u >= 0.60         currently out: an 'in' 5–70 hours ago, then an 'out'
--                     0.25–4.25 hours ago
plans as (
  select nr.id as resident_id,
         random() as u,
         0.5  + random() * 47.0 as in_hours_ago,
         5.0  + random() * 65.0 as far_in_hours_ago,
         0.25 + random() * 4.0  as out_hours_ago
  from new_residents nr
  where nr.status = 'active'
),
events as (
  select resident_id, 'in' as kind, now() - (in_hours_ago * interval '1 hour') as occurred_at
    from plans where u >= 0.15 and u < 0.60
  union all
  select resident_id, 'in', now() - (far_in_hours_ago * interval '1 hour')
    from plans where u >= 0.60
  union all
  select resident_id, 'out', now() - (out_hours_ago * interval '1 hour')
    from plans where u >= 0.60
)
insert into public.gate_events (resident_id, guard_id, kind, occurred_at)
select e.resident_id, g.id, e.kind, e.occurred_at
from events e
cross join g;
