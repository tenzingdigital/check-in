-- 054_guardian_alert_and_conflicts.sql — children on site with no guardian,
-- check-ins recorded while signed out, and one nightly email.
--
-- The incident of September 2026: a parent signed OUT at the gate in the
-- evening and did not come back; she had checked in earlier so the register
-- read "verified present"; her children were on site with nobody
-- responsible; nothing said so until Monday. House Rules 3.5.4 makes a
-- child left unsupervised a matter staff must report. This file holds the
-- two facts the app can state — a household with children on site and no
-- guardian on site and no supervision arrangement (053), and a check-in
-- recorded while the gate had the person out — and the switch for the one
-- nightly email that replaces the House Rules reminder (032) and the
-- overnight safeguarding alert (041).
--
-- Two readers of each fact, and they are not the same caller. Staff read
-- v_household_care (053) and the conflicts view below from a session with
-- an identity. The 22:00 alert and the nightly email read as the owner,
-- with no identity at all, and every v_* view filters on is_staff() — which
-- is false for the owner, so a snapshot written from the view would record
-- "nothing to report" about every child left alone (035 and 041 already
-- read base tables for exactly this reason). So the fact is computed once
-- more here, on the base tables, in guardian_gap_households(): the same
-- predicate as the view, children_on_site > 0 and guardians_on_site = 0
-- and no arrangement running, and it must stay in step with 053.

-- ---------------------------------------------------------------------------
-- 1. The nightly record of guardian gaps, written by the snapshot.
-- ---------------------------------------------------------------------------
create table if not exists public.overnight_guardian_gaps (
  night            date not null,
  household_id     uuid not null references public.households (id) on delete cascade,
  children_on_site integer not null,
  guardians_out    integer not null,
  first_out_at     timestamptz,
  recorded_at      timestamptz not null default now(),
  primary key (night, household_id)
);
comment on table public.overnight_guardian_gaps is
  'One row per night per household that had children on site, no guardian on site and no supervision arrangement running when the snapshot was taken (054). Counts and a time; the names are one tap away behind a login.';

alter table public.overnight_guardian_gaps enable row level security;
drop policy if exists guardian_gaps_read on public.overnight_guardian_gaps;
create policy guardian_gaps_read on public.overnight_guardian_gaps for select using (public.is_staff());
-- No insert/update/delete policies: the snapshot and the purge write as owner.
revoke all on public.overnight_guardian_gaps from anon, public, authenticated;
grant select on public.overnight_guardian_gaps to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The fact, on the base tables, for the owner.
-- ---------------------------------------------------------------------------
-- Households with children on site, no guardian on site and no arrangement
-- running right now. Guardians are the household's active adults, children
-- its active under-age members (adult_age_years), presence is the latest
-- gate event, exactly as v_household_care (053) computes them — this is
-- that view's shape without its is_staff() filter, for the two functions
-- below, which the nightly job calls with no identity. Owner-only: a staff
-- session reads the view.
create or replace function public.guardian_gap_households()
returns table (household_id uuid, children_on_site integer, guardians_out integer, first_out_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (select adult_age_years from public.app_settings where id),
  members as (
    select r.household_id,
           (r.date_of_birth <= current_date - make_interval(years => s.adult_age_years)) as is_adult,
           coalesce(le.kind, 'out') as presence,
           le.occurred_at as last_event_at
      from public.residents r cross join s
      left join lateral (
        select ge.kind, ge.occurred_at from public.gate_events ge
         where ge.resident_id = r.id
         order by ge.occurred_at desc, ge.id desc limit 1) le on true
     where r.status = 'active' and r.household_id is not null
  ),
  shape as (
    select m.household_id,
           count(*) filter (where not m.is_adult and m.presence = 'in')::integer as children_on_site,
           count(*) filter (where m.is_adult and m.presence = 'in')::integer     as guardians_on_site,
           count(*) filter (where m.is_adult and m.presence = 'out')::integer    as guardians_out,
           min(m.last_event_at) filter (where m.is_adult and m.presence = 'out') as first_out_at
      from members m group by m.household_id
  )
  select sh.household_id, sh.children_on_site, sh.guardians_out, sh.first_out_at
    from shape sh
   where sh.children_on_site > 0 and sh.guardians_on_site = 0
     and not exists (
       select 1 from public.supervision_arrangements a
        where a.household_id = sh.household_id and a.ended_at is null
          and now() >= a.from_at and now() < a.to_at)
$$;
revoke all on function public.guardian_gap_households() from public, anon, authenticated;

-- The nightly job writes the night's gaps; a re-run is free (on conflict do
-- nothing), and the row count returned is what job_runs records.
create or replace function public.snapshot_guardian_gaps(p_night date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.overnight_guardian_gaps (night, household_id, children_on_site, guardians_out, first_out_at)
  select p_night, g.household_id, g.children_on_site, g.guardians_out, g.first_out_at
    from public.guardian_gap_households() g
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.snapshot_guardian_gaps(date) from public, anon, authenticated;

-- Retention follows the register.
create or replace function public.purge_guardian_gaps()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.overnight_guardian_gaps
   where night < public.site_today() - (select compliance_retention_days from public.app_settings where id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_guardian_gaps() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The 22:00 rows, with names, for the people whose duty it is.
-- ---------------------------------------------------------------------------
-- One row per gap household, ready to read out: the household label and
-- rooms as the register shows them (018), the children on site as
-- "Cormac (9)", the guardians as "Aoife Brennan (out since 19:40)" — with
-- the date when they went out on another day. Supervisors and admins
-- only, because it names children; a guard is refused, not handed zero
-- rows, so the refusal is visible. The owner (the 22:00 alert, no
-- identity) passes, as in email_link_key() (049) — which is why this is
-- never granted to anon.
create or replace function public.guardian_gaps_now()
returns table (household_id uuid, household_label text, room_labels text, children text, guardians_out text, first_out_at timestamptz)
language plpgsql stable security definer set search_path = public set lc_time = 'C' as $$
declare v_tz text; v_adult integer; v_today date;
begin
  if auth.uid() is not null and not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can list children without a guardian' using errcode = '42501';
  end if;
  select local_timezone, adult_age_years into v_tz, v_adult from public.app_settings where id;
  v_today := public.site_today();
  return query
  with g as (select * from public.guardian_gap_households()),
  m as (
    select r.household_id, btrim(r.first_name) as first_name, btrim(r.last_name) as last_name, r.date_of_birth,
           (r.date_of_birth <= current_date - make_interval(years => v_adult)) as is_adult,
           coalesce(le.kind, 'out') as presence,
           le.occurred_at as last_event_at,
           case when rm.id is null then null
                else b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number end as room_label
      from public.residents r
      join g on g.household_id = r.household_id
      left join public.rooms rm    on rm.id = r.room_id
      left join public.buildings b on b.id = rm.building_id
      left join lateral (
        select ge.kind, ge.occurred_at from public.gate_events ge
         where ge.resident_id = r.id
         order by ge.occurred_at desc, ge.id desc limit 1) le on true
     where r.status = 'active'
  )
  select g.household_id,
         (select string_agg(distinct m.last_name, ' / ' order by m.last_name) || ' family (' || count(*) || ')'
            from m where m.household_id = g.household_id),
         (select string_agg(distinct m.room_label, ', ' order by m.room_label)
            from m where m.household_id = g.household_id and m.room_label is not null),
         (select string_agg(m.first_name || ' (' || date_part('year', age(m.date_of_birth))::integer || ')', ', ' order by m.date_of_birth)
            from m where m.household_id = g.household_id and not m.is_adult and m.presence = 'in'),
         (select string_agg(m.first_name || ' ' || m.last_name
                   || case when m.last_event_at is null then ' (never signed in)'
                           else ' (out since '
                                || to_char(m.last_event_at at time zone v_tz,
                                           case when (m.last_event_at at time zone v_tz)::date = v_today then 'HH24:MI' else 'FMDD Mon HH24:MI' end)
                                || ')' end,
                   ', ' order by m.last_name, m.first_name)
            from m where m.household_id = g.household_id and m.is_adult),
         g.first_out_at
    from g
   order by 2;
end $$;
revoke all on function public.guardian_gaps_now() from public, anon;
grant execute on function public.guardian_gaps_now() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Check-ins recorded while the gate had the person out.
-- ---------------------------------------------------------------------------
-- A conflict is a check-in whose latest gate event at or before it is OUT,
-- or none exists — the register said "present" about someone the gate had
-- off site. Within retention, like the events themselves.
create or replace view public.v_checkin_conflicts as
select e.id as checkin_id, e.resident_id, e.occurred_at, e.guard_id, e.source,
       g.kind as last_gate_kind, g.occurred_at as last_gate_at
  from public.checkin_events e
  left join lateral (
    select ge.kind, ge.occurred_at from public.gate_events ge
     where ge.resident_id = e.resident_id and ge.occurred_at <= e.occurred_at
     order by ge.occurred_at desc, ge.id desc limit 1) g on true
 where public.is_staff()
   and e.occurred_at > now() - make_interval(days => (select compliance_retention_days from public.app_settings where id))
   and (g.kind is null or g.kind = 'out');
comment on view public.v_checkin_conflicts is
  'Check-ins recorded while the In & out register had the person out (054): the latest gate event at or before the check-in is OUT, or there is none. Staff only.';
revoke all on public.v_checkin_conflicts from anon, public;
grant select on public.v_checkin_conflicts to authenticated;

-- The count the nightly email carries, for one site-local day, as the
-- owner: the view above is empty for a caller with no identity (see the
-- note at the top), and the job must not read "no conflicts" from that.
-- Same predicate as the view. Owner-only, as overnight_safeguarding_count().
create or replace function public.checkin_conflict_count(p_day date)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer
    from public.checkin_events e
    left join lateral (
      select ge.kind from public.gate_events ge
       where ge.resident_id = e.resident_id and ge.occurred_at <= e.occurred_at
       order by ge.occurred_at desc, ge.id desc limit 1) g on true
   where (e.occurred_at at time zone (select local_timezone from public.app_settings where id))::date = p_day
     and (g.kind is null or g.kind = 'out')
$$;
revoke all on function public.checkin_conflict_count(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. One switch for the one nightly email (and the 22:00 alert).
-- ---------------------------------------------------------------------------
alter table public.app_settings add column if not exists nightly_email boolean not null default false;
comment on column public.app_settings.nightly_email is
  'The nightly email (children without a guardian, children away, check-in conflicts, House Rules figures) and the 22:00 guardian alert, to the staff ticked safeguarding_alert. Replaces notify_thresholds_email (032), which is kept but no longer read.';
-- On for any site that had either of the emails it replaces.
update public.app_settings set nightly_email = true
 where notify_thresholds_email or exists (select 1 from public.profiles p where p.safeguarding_alert);
-- Existing tenant schemas get the column too, as 052 did: the template
-- cannot patch a column onto an app_settings already provisioned.
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.app_settings add column if not exists nightly_email boolean not null default false', s);
    execute format('update %I.app_settings set nightly_email = true where notify_thresholds_email or exists (select 1 from %I.profiles p where p.safeguarding_alert)', s, s);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Two new unsubscribe kinds; the retired safeguarding alert folds into
--    'nightly'; the retired House Rules reminder is left as history.
-- ---------------------------------------------------------------------------
-- Someone who opted out of the overnight safeguarding alert has opted out
-- of the email that replaces it: 049's unsubscribe cleared their
-- profiles.safeguarding_alert tick, which is the tick the nightly email
-- reads, so the copied 'nightly' row and the tick agree. The old rows
-- stay: Admin → Staff still says when they unsubscribed.
--
-- A 'house_rules' opt-out is NOT copied. The House Rules reminder went to
-- every supervisor and admin with no tick behind it, so opting out of it
-- cleared nothing; copying that row to 'nightly' would leave the person's
-- safeguarding_alert tick true — they get the nightly email anyway — while
-- their staff card says "Unsubscribed". A row that says one thing while the
-- email does another is worse than no row. Their rows stay as history: the
-- kind still resolves on an old link (lib/emailPrefs.js) and the staff card
-- lists it under "(now the nightly email)"; stopping the nightly email is
-- one click on that link, and it clears the tick this time.
alter table public.email_opt_outs drop constraint if exists email_opt_outs_kind_check;
alter table public.email_opt_outs add constraint email_opt_outs_kind_check
  check (kind in ('weekly_report', 'safeguarding_alert', 'house_rules', 'guardian_alert', 'nightly'));
insert into public.email_opt_outs (profile_id, kind)
select distinct o.profile_id, 'nightly' from public.email_opt_outs o where o.kind = 'safeguarding_alert'
on conflict do nothing;
-- The same for every tenant schema already provisioned (049 is in each
-- one's copy of the template): a check constraint on an existing table is
-- the 052 case, not the 053 one.
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.email_opt_outs drop constraint if exists email_opt_outs_kind_check', s);
    execute format('alter table %I.email_opt_outs add constraint email_opt_outs_kind_check check (kind in (%L, %L, %L, %L, %L))',
                   s, 'weekly_report', 'safeguarding_alert', 'house_rules', 'guardian_alert', 'nightly');
    -- safeguarding_alert only, for the reason above: a house_rules row has
    -- no tick behind it and would disagree with the email.
    execute format('insert into %I.email_opt_outs (profile_id, kind) select distinct o.profile_id, %L from %I.email_opt_outs o where o.kind = %L on conflict do nothing',
                   s, 'nightly', s, 'safeguarding_alert');
  end loop;
end $$;
