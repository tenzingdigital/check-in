-- 041: who receives the overnight safeguarding alert.
--
-- An under-18 is exempt from the daily check-in rule, and in
-- v_resident_compliance that exemption is evaluated SECOND — before
-- breach_open, before everything. So a child never has required_today true,
-- never appears under Not seen, and never reaches attention_list(), which
-- selects only breach_open, never and due_today. A fifteen-year-old not seen
-- for three days looks exactly like one seen an hour ago.
--
-- That is right as COMPLIANCE — IPAS puts the daily obligation on adults, and
-- a child is not in breach of anything. It has been built as "exempt from the
-- rule" and reads as "not our concern", and those are different things.
--
-- A flag of its own rather than reusing weekly_report (037): these are
-- different audiences. A designated safeguarding person may want the nightly
-- alert and not the weekly return to head office, or the reverse, and ticking
-- one should never tick the other.
--
-- Everything below mirrors 037's shape deliberately, so there is one pattern
-- for "a staff member receives a thing" rather than two.

alter table public.profiles
  add column if not exists safeguarding_alert boolean not null default false;

comment on column public.profiles.safeguarding_alert is
  'Receives the nightly overnight safeguarding alert: a count of children who were away overnight with no authorised absence recorded. Only a supervisor or admin may carry this — the alert points at a report a guard cannot run.';

create or replace function public.profiles_clear_safeguarding_alert_for_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role = 'guard' and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    new.safeguarding_alert := false;
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_clear_safeguarding_alert_for_guard() from public, anon, authenticated;

drop trigger if exists profiles_safeguarding_alert_guard on public.profiles;
create trigger profiles_safeguarding_alert_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_clear_safeguarding_alert_for_guard();

-- The trigger clears the flag on a demotion so the role change never fails
-- because of it; the constraint is what refuses a deliberate attempt to tick
-- a guard. Tao 5: the route may say no, but this is the guarantee.
alter table public.profiles drop constraint if exists profiles_safeguarding_alert_not_guard;
alter table public.profiles
  add constraint profiles_safeguarding_alert_not_guard
  check (not (safeguarding_alert and role = 'guard'));

-- ---------------------------------------------------------------------------
-- The count the alert sends.
--
-- Children with a row in overnight_absences for that night, not covered by an
-- authorised absence. The source is the In & out register — overnight_absences
-- is derived from gate_events (027) — because children are not on the daily
-- register, so the movement log is the only place their absence shows.
--
-- A count, not a list: the email carries counts and a link and never a name
-- (ec793da took resident names out of outbound mail deliberately, and a child
-- is the worst case to undo that for). The names are one tap away, behind a
-- login, on a view that note_view() records.
-- ---------------------------------------------------------------------------
create or replace function public.overnight_safeguarding_count(p_night date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.overnight_absences o
    join public.residents r on r.id = o.resident_id
   where o.night = p_night
     and r.date_of_birth > (o.night - make_interval(years => (select adult_age_years from public.app_settings where id)))::date
     and not public.absence_authorised(o.resident_id, o.night);
$$;

revoke all on function public.overnight_safeguarding_count(date) from public, anon, authenticated, service_role;
