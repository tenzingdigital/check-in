-- 053_supervision_arrangements.sql — Appendix 5: a household's children in
-- another adult resident's care for a period.
--
-- The centre's form (Child Protection and Welfare Safeguarding Policy,
-- Appendix 5, part A): the parent and a nominated adult resident sign,
-- management approves, the form is filed — and security are never told.
-- This table holds the fact that matters at the door and at 22:00: which
-- children, whose care, until when, and whether an overnight was approved.
-- Nothing else: the contact number and the story stay on the paper form.
--
-- Guardians are the household's active adults; children its active
-- under-age members (adult_age_years in app_settings). No parent flag.
-- Supervisors and admins record; nobody edits; ending early sets ended_at.

create table if not exists public.supervision_arrangements (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  carer_id      uuid not null references public.residents (id) on delete cascade,
  from_at       timestamptz not null,
  to_at         timestamptz not null,
  overnight     boolean not null default false,
  recorded_by   uuid not null references public.profiles (id),
  recorded_at   timestamptz not null default now(),
  ended_at      timestamptz,
  constraint supervision_period check (to_at > from_at),
  constraint supervision_ended_inside check (ended_at is null or ended_at >= from_at)
);
create index if not exists supervision_household_idx on public.supervision_arrangements (household_id, from_at desc);
create index if not exists supervision_carer_idx on public.supervision_arrangements (carer_id, from_at desc);
comment on table public.supervision_arrangements is
  'Appendix 5 part A: a household''s children in another adult resident''s care from/to. Facts only — no contact number, no note.';

alter table public.supervision_arrangements enable row level security;
drop policy if exists supervision_read on public.supervision_arrangements;
create policy supervision_read on public.supervision_arrangements for select using (public.is_staff());
-- No insert/update/delete policies: writes go through the two functions.
revoke all on public.supervision_arrangements from anon, public;
grant select on public.supervision_arrangements to authenticated;

drop trigger if exists supervision_audit on public.supervision_arrangements;
create trigger supervision_audit
  after insert or update or delete on public.supervision_arrangements
  for each row execute function public.audit_row();

-- Does [p_from, p_to) cross a local midnight? Compared on the site's clock.
create or replace function public.crosses_midnight(p_from timestamptz, p_to timestamptz)
returns boolean language sql stable set search_path = public as $$
  select (p_from at time zone (select local_timezone from public.app_settings where id))::date
      <> (p_to   at time zone (select local_timezone from public.app_settings where id))::date
$$;
revoke all on function public.crosses_midnight(timestamptz, timestamptz) from anon, public;
grant execute on function public.crosses_midnight(timestamptz, timestamptz) to authenticated;

create or replace function public.record_supervision(
  p_household uuid, p_carer uuid, p_from timestamptz, p_to timestamptz, p_overnight boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_adult_age int;
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can record a supervision arrangement' using errcode = '42501';
  end if;
  if p_to <= p_from then raise exception 'The arrangement must end after it starts' using errcode = '22023'; end if;
  select adult_age_years into v_adult_age from public.app_settings where id;
  if not exists (select 1 from public.residents r where r.id = p_carer and r.status = 'active'
                   and r.date_of_birth <= current_date - make_interval(years => v_adult_age)) then
    raise exception 'The carer must be an active adult resident' using errcode = '22023';
  end if;
  if exists (select 1 from public.residents r where r.id = p_carer and r.household_id = p_household) then
    raise exception 'The carer must be outside the household' using errcode = '22023';
  end if;
  if exists (select 1 from public.supervision_arrangements a
              where a.household_id = p_household and a.ended_at is null
                and tstzrange(a.from_at, a.to_at) && tstzrange(p_from, p_to)) then
    raise exception 'This household already has an arrangement for part of that time' using errcode = '22023';
  end if;
  if public.crosses_midnight(p_from, p_to) and not p_overnight then
    raise exception 'An arrangement that runs past midnight needs the overnight approval ticked (House Rules 3.5.4)' using errcode = '22023';
  end if;
  insert into public.supervision_arrangements (household_id, carer_id, from_at, to_at, overnight, recorded_by)
  values (p_household, p_carer, p_from, p_to, p_overnight, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_supervision(uuid, uuid, timestamptz, timestamptz, boolean) from public, anon;
grant execute on function public.record_supervision(uuid, uuid, timestamptz, timestamptz, boolean) to authenticated;

create or replace function public.end_supervision(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can end a supervision arrangement' using errcode = '42501';
  end if;
  update public.supervision_arrangements set ended_at = greatest(now(), from_at)
   where id = p_id and ended_at is null;
  if not found then raise exception 'No running arrangement with that id' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.end_supervision(uuid) from public, anon;
grant execute on function public.end_supervision(uuid) to authenticated;

-- One row per household with children: who is responsible, who is on site,
-- and the arrangement running right now, if any. The gate draws its care
-- lines from this; the 22:00 alert (piece B) reads it.
create or replace view public.v_household_care as
with s as (select adult_age_years from public.app_settings where id),
members as (
  select r.household_id, r.id, v.presence,
         (r.date_of_birth <= current_date - make_interval(years => s.adult_age_years)) as is_adult
    from public.residents r cross join s
    left join public.v_resident_status v on v.id = r.id
   where r.status = 'active' and r.household_id is not null
),
shape as (
  select household_id,
         count(*) filter (where is_adult)::int as guardians,
         count(*) filter (where not is_adult)::int as children,
         count(*) filter (where is_adult and presence = 'in')::int as guardians_on_site,
         count(*) filter (where not is_adult and presence = 'in')::int as children_on_site
    from members group by household_id
),
running as (
  select distinct on (a.household_id) a.household_id, a.id as arrangement_id, a.carer_id,
         btrim(c.first_name) || ' ' || btrim(c.last_name) as carer_name,
         rm.room_label as carer_room_label, a.to_at as until, a.overnight
    from public.supervision_arrangements a
    join public.residents c on c.id = a.carer_id
    left join public.v_resident_room rm on rm.id = c.id
   where a.ended_at is null and now() >= a.from_at and now() < a.to_at
   order by a.household_id, a.from_at desc
)
select sh.household_id, sh.guardians, sh.children, sh.guardians_on_site, sh.children_on_site,
       ru.arrangement_id, ru.carer_id, ru.carer_name, ru.carer_room_label, ru.until, ru.overnight
  from shape sh left join running ru on ru.household_id = sh.household_id;
revoke all on public.v_household_care from anon, public;
grant select on public.v_household_care to authenticated;

-- Retention follows the register.
create or replace function public.purge_supervision_arrangements()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.supervision_arrangements
   where to_at < now() - make_interval(days => (select compliance_retention_days from public.app_settings where id));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_supervision_arrangements() from public, anon, authenticated;

-- database.js migrates public only (docs/KNOWN-ISSUES.md #4): a t_* tenant
-- schema gets tenant/template.sql once, at provisioning, and this file does
-- not revisit it. Unlike 052 (an existing per-tenant table whose stale
-- column list was already 500ing live routes), this is a brand-new table
-- that nothing yet calls per-tenant, so the same do-nothing-and-let
-- tenant_schema_gaps() surface it (048's documented policy) would have been
-- defensible. The table is created here anyway, per the plan; see the task
-- report for why the functions and view were deliberately left out of it.
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('create table if not exists %I.supervision_arrangements (like public.supervision_arrangements including all)', s);
    execute format('alter table %I.supervision_arrangements enable row level security', s);
  end loop;
end $$;
