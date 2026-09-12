-- ============================================================================
-- Demo data — OPTIONAL. Run only on a test project.
--
-- These are invented people. Do not run this against a project that holds real
-- resident data: mixing test records into a live register makes your GDPR
-- accuracy obligation (Art. 5(1)(d)) much harder to argue.
-- ============================================================================

insert into public.residents (first_name, last_name, date_of_birth, id_type, id_number) values
  ('Aoife',   'Brennan',   '1991-04-12', 'TRC', 'TRC0000001'),
  ('Marek',   'Nowak',     '1988-11-30', 'TRC', 'TRC0000002'),
  ('Grace',   'Okonkwo',   '2001-02-19', 'IRP', 'IRP0000003'),
  ('Daniel',  'Fitzgerald','1975-07-03', 'TRC', 'TRC0000004'),
  ('Leila',   'Haddad',    '1996-09-25', 'TRC', 'TRC0000005'),
  ('Tomás',   'Ó Súilleabháin', '1983-01-08', 'IRP', 'IRP0000006'),
  ('Priya',   'Nair',      '1999-06-14', 'TRC', 'TRC0000007'),
  ('Jonas',   'Andersson', '1993-03-02', 'TRC', 'TRC0000008'),
  ('Sofia',   'Marchetti', '2009-05-21', 'IRP', 'IRP0000009'),   -- minor, exempt from the 24h rule
  ('Kwame',   'Mensah',    '1979-12-17', 'TRC', 'TRC0000010')
on conflict do nothing;

-- A spread of history so the compliance states are all visible in the UI:
-- some signed in recently (ok), one approaching the deadline (due_soon),
-- one well past it (overdue), and one with no history at all (never).
with g as (
  select id from public.profiles order by created_at limit 1
),
r as (
  select id, first_name, last_name from public.residents
)
insert into public.gate_events (resident_id, guard_id, kind, occurred_at)
select r.id, g.id, v.kind, now() - v.ago
from r
cross join g
join (values
  ('Brennan',        'in',  interval '2 hours'),
  ('Nowak',          'in',  interval '21 hours'),   -- due soon
  ('Okonkwo',        'in',  interval '40 hours'),   -- overdue
  ('Okonkwo',        'out', interval '39 hours'),
  ('Fitzgerald',     'in',  interval '6 hours'),
  ('Haddad',         'in',  interval '30 hours'),   -- overdue
  ('Ó Súilleabháin', 'in',  interval '1 hour'),
  ('Nair',           'in',  interval '10 hours'),
  ('Nair',           'out', interval '3 hours'),
  ('Mensah',         'in',  interval '23 hours')    -- due soon
) as v(surname, kind, ago) on r.last_name = v.surname;
