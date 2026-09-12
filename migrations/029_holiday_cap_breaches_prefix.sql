-- 029: the centre call of 8 September — holiday cap, IPO interviews,
-- breach reports, and room prefix search.
--
--   1. A holiday is at most holiday_max_days consecutive days (IPAS: 14),
--      a new figure in Settings. An IPO interview is a reason of its own.
--   2. Breach reports. When the House Rules threshold is met, or the
--      verification system is misused (one resident signing in for
--      others), staff issue a breach report to IPAS. The app flags the
--      threshold; this records that the report was issued: which kind, on
--      what day, by whom, with the reference. No narrative.
--   3. "B" in the search box lists everyone in the B rooms.

-- ---------------------------------------------------------------------------
-- 1. Holiday cap and the interview reason
-- ---------------------------------------------------------------------------
alter table public.app_settings
  add column if not exists holiday_max_days integer not null default 14
  check (holiday_max_days between 1 and 90);
comment on column public.app_settings.holiday_max_days is 'The longest holiday a resident may be authorised to take, in consecutive days. IPAS: 14.';

alter table public.authorised_absences drop constraint if exists authorised_absences_reason_check;
alter table public.authorised_absences
  add constraint authorised_absences_reason_check
  check (reason in ('holiday', 'family', 'medical', 'interview', 'education', 'work', 'other'));

create or replace function public.authorise_absence(
  p_resident_id     uuid,
  p_from            date,
  p_to              date,
  p_reason          text,
  p_guardian_agreed boolean default false
)
returns public.authorised_absences
language plpgsql security definer set search_path = public
as $$
declare
  v_res   public.residents;
  v_adult integer;
  v_holiday integer;
  v_row   public.authorised_absences;
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can authorise an absence' using errcode = '42501';
  end if;
  select * into v_res from public.residents where id = p_resident_id;
  if not found then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_res.status <> 'active' then
    raise exception 'Only an active resident can be authorised to be away' using errcode = '23514';
  end if;
  if p_to < p_from then
    raise exception 'The last day must not be before the first' using errcode = '22023';
  end if;
  if p_to - p_from > 366 then
    raise exception 'An authorised absence covers at most a year' using errcode = '22023';
  end if;
  select adult_age_years, holiday_max_days into v_adult, v_holiday from public.app_settings where id;
  if p_reason = 'holiday' and p_to - p_from + 1 > v_holiday then
    raise exception 'A holiday covers at most % consecutive days (Settings)', v_holiday using errcode = '22023';
  end if;
  if v_res.date_of_birth > (p_from - make_interval(years => v_adult))::date and not coalesce(p_guardian_agreed, false) then
    raise exception 'A child''s absence needs a parent or guardian''s agreement recorded' using errcode = '23514';
  end if;
  if exists (select 1 from public.authorised_absences a
              where a.resident_id = p_resident_id
                and daterange(a.from_date, coalesce(a.ended_on, a.to_date), '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'Overlaps an authorised absence already recorded' using errcode = '23505';
  end if;
  insert into public.authorised_absences (resident_id, from_date, to_date, reason, guardian_agreed, approved_by)
  values (p_resident_id, p_from, p_to, p_reason, coalesce(p_guardian_agreed, false), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Breach reports
-- ---------------------------------------------------------------------------
create table if not exists public.breach_reports (
  id          bigserial primary key,
  resident_id uuid not null references public.residents (id) on delete cascade,
  kind        text not null check (kind in ('house_rules', 'misuse')),
  issued_on   date not null,
  issued_by   uuid references public.profiles (id) on delete set null,
  -- The reference the report carries (an IPAS or file reference), not a
  -- description of what happened.
  reference   text check (reference is null or length(reference) <= 60),
  created_at  timestamptz not null default now()
);
create index if not exists breach_reports_resident_idx on public.breach_reports (resident_id, issued_on desc);
comment on table public.breach_reports is 'That a breach report was issued to IPAS: which kind, when, by whom, its reference. The threshold is the app''s; the decision and the report are the manager''s.';

alter table public.breach_reports enable row level security;
drop policy if exists breach_reports_read on public.breach_reports;
create policy breach_reports_read on public.breach_reports for select using (public.is_staff());
revoke all on public.breach_reports from anon, public, authenticated;
grant select on public.breach_reports to authenticated;
grant usage on sequence public.breach_reports_id_seq to authenticated;

drop trigger if exists breach_reports_audit on public.breach_reports;
create trigger breach_reports_audit
  after insert or update or delete on public.breach_reports
  for each row execute function public.audit_row();

create or replace function public.issue_breach(
  p_resident_id uuid,
  p_kind        text,
  p_issued_on   date default null,
  p_reference   text default null
)
returns public.breach_reports
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.breach_reports;
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can record a breach report' using errcode = '42501';
  end if;
  if not exists (select 1 from public.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  insert into public.breach_reports (resident_id, kind, issued_on, issued_by, reference)
  values (p_resident_id, p_kind, coalesce(p_issued_on, public.site_today()), auth.uid(), nullif(btrim(coalesce(p_reference, '')), ''))
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.issue_breach(uuid, text, date, text) from public, anon;
grant execute on function public.issue_breach(uuid, text, date, text) to authenticated;

create or replace function public.purge_expired_breach_reports()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.breach_reports where issued_on < public.site_today() - v_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_breach_reports() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Room prefix search
-- ---------------------------------------------------------------------------
create or replace function public.search_residents(
  q                text,
  include_departed boolean default false,
  max_results      integer default 20
)
returns setof public.v_resident_status
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select v.*
  from public.v_resident_status v
  cross join (select lower(public.immutable_unaccent(btrim(coalesce(q, '')))) as nq) n
  where public.is_staff()
    and (include_departed or v.status = 'active')
    and (
      n.nq = ''
      or v.search_key like '%' || n.nq || '%'
      -- Migration 028: the room as painted on the door (B1, K12), or any
      -- part of the building-and-room label. Security works by room.
      or exists (select 1 from public.v_resident_room x
                  where x.id = v.id
                    and (lower(x.room) = n.nq
                         -- A prefix too: "B" lists Manor House, "K1" K1 and K10-K18.
                         or lower(x.room) like n.nq || '%'
                         or lower(x.room_label) like '%' || n.nq || '%'
                         or lower(x.building || ' ' || x.room) like '%' || n.nq || '%'))
      or (
        word_similarity(n.nq, v.search_key) >= 0.4
        and not exists (
          select 1 from public.v_resident_status v2
          where (include_departed or v2.status = 'active')
            and v2.search_key like '%' || n.nq || '%'
        )
      )
    )
  order by
    case when exists (select 1 from public.v_resident_room x where x.id = v.id and (lower(x.room) = n.nq or lower(x.room) like n.nq || '%')) then 0
         when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;


-- ---------------------------------------------------------------------------
-- 4. The export carries breach reports too
-- ---------------------------------------------------------------------------
create or replace function public.export_resident_record(p_resident_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may export a resident record' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'exported_at', now(),
    'exported_by', (select full_name from public.profiles where id = auth.uid()),
    'resident', to_jsonb(r) - 'search_key',
    'gate_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', e.kind,
               'occurred_at', e.occurred_at,
               'recorded_at', e.recorded_at,
               'late_entry', e.late_entry,
               'recorded_by', g.full_name
             ) order by e.occurred_at)
      from public.gate_events e
      join public.profiles g on g.id = e.guard_id
      where e.resident_id = r.id
    ), '[]'::jsonb),
    'checkin_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'occurred_at', c.occurred_at,
               'recorded_at', c.recorded_at,
               'late_entry', c.late_entry,
               'recorded_by', g.full_name
             ) order by c.occurred_at)
      from public.checkin_events c
      join public.profiles g on g.id = c.guard_id
      where c.resident_id = r.id
    ), '[]'::jsonb),
    'daily_compliance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', dc.compliance_date,
               'required', dc.required,
               'presented', dc.presented,
               'checkins', dc.checkin_count
             ) order by dc.compliance_date)
      from public.daily_compliance dc where dc.resident_id = r.id
    ), '[]'::jsonb),
    -- Who opened this record and when (migration 023). Part of "everything
    -- held about me", and the reason the access log exists.
    'views', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', v.viewed_at,
               'by', p.full_name,
               'where', v.surface
             ) order by v.viewed_at)
      from public.resident_views v
      left join public.profiles p on p.id = v.actor_id
      where v.resident_id = r.id
    ), '[]'::jsonb),
    -- Authorised absences and the rooms they have had (migration 028).
    'authorised_absences', coalesce((
      select jsonb_agg(jsonb_build_object(
               'from', a.from_date, 'to', a.to_date, 'reason', a.reason,
               'guardian_agreed', a.guardian_agreed, 'ended_on', a.ended_on,
               'approved_by', p.full_name, 'recorded_at', a.created_at
             ) order by a.from_date)
      from public.authorised_absences a
      left join public.profiles p on p.id = a.approved_by
      where a.resident_id = r.id
    ), '[]'::jsonb),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'room', ra.room_label, 'from', ra.from_at, 'to', ra.to_at,
               'changed_by', p.full_name
             ) order by ra.from_at)
      from public.room_assignments ra
      left join public.profiles p on p.id = ra.changed_by
      where ra.resident_id = r.id
    ), '[]'::jsonb),
    'breach_reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', b.kind, 'issued_on', b.issued_on, 'reference', b.reference,
               'issued_by', p.full_name, 'recorded_at', b.created_at
             ) order by b.issued_on)
      from public.breach_reports b
      left join public.profiles p on p.id = b.issued_by
      where b.resident_id = r.id
    ), '[]'::jsonb),
    -- Every change an administrator made to this record, and every export
    -- of it. Art. 15 is "everything held about me"; that includes who
    -- edited it and when.
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', a.at,
               'action', a.action,
               'by', p.full_name,
               'before', a.old_row,
               'after', a.new_row,
               'note', a.note
             ) order by a.at)
      from public.admin_audit a
      left join public.profiles p on p.id = a.actor_id
      where a.table_name = 'residents' and a.row_id = r.id::text
    ), '[]'::jsonb)
  )
  into v_out
  from public.residents r
  where r.id = p_resident_id;

  if v_out is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  return v_out;
end;
$$;
