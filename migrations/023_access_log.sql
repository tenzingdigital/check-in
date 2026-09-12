-- 023: who looked at whom.
--
-- The register and the audit trail say what was recorded and what was
-- changed. Nothing said who OPENED a resident's record: the detail sheet
-- on the register carries the identity number, the edit sheet everything,
-- and an export the lot. This is the access log the DPA promises and an
-- inspector asks for — and the first thing to read after a complaint that
-- somebody was looking at a record they had no business with.
--
-- One row per opening: who, which resident, which surface, when. Written
-- by the server in the same transaction as the read, through note_view(),
-- so a read without a row cannot happen from the app. Administrators read
-- it (the "Who viewed which record" report, and each resident's export
-- includes their own). Kept as long as the audit trail, then purged.
--
-- The gate's detail sheet shows nothing beyond the list (no identity
-- number), and the register's sheet opened offline reads the encrypted
-- copy and never reaches the server; neither is logged, and docs/GDPR.md
-- says so.

create table if not exists public.resident_views (
  id          bigint generated always as identity primary key,
  viewed_at   timestamptz not null default now(),
  actor_id    uuid references public.profiles (id) on delete set null,
  resident_id uuid not null references public.residents (id) on delete cascade,
  surface     text not null check (surface in ('register', 'admin', 'export'))
);
create index if not exists resident_views_at_idx       on public.resident_views (viewed_at);
create index if not exists resident_views_resident_idx on public.resident_views (resident_id, viewed_at);

comment on table public.resident_views is 'Who opened which resident''s record, where, and when. The access log.';
comment on column public.resident_views.surface is 'register: the detail sheet on the daily register; admin: the edit sheet; export: the Art. 15 record.';

alter table public.resident_views enable row level security;
drop policy if exists resident_views_admin on public.resident_views;
create policy resident_views_admin on public.resident_views for select using (public.is_admin());
revoke all on public.resident_views from anon, public;
grant select on public.resident_views to authenticated;
-- No insert grant: rows arrive through note_view() only.

create or replace function public.note_view(p_resident_id uuid, p_surface text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Not a staff member' using errcode = '42501';
  end if;
  -- A lookup of an id that is not on the register is not a view of anyone;
  -- the route answers 404 and there is nothing to log.
  insert into public.resident_views (actor_id, resident_id, surface)
  select auth.uid(), p_resident_id, p_surface
   where exists (select 1 from public.residents where id = p_resident_id);
end;
$$;
revoke all on function public.note_view(uuid, text) from public, anon;
grant execute on function public.note_view(uuid, text) to authenticated;

-- The report. A function rather than a bare select so a supervisor is
-- refused out loud (42501 → 403) instead of being handed an empty table
-- by the row policy.
create or replace function public.resident_views_between(p_from date, p_to date)
returns table (at text, staff text, resident text, "where" text)
language plpgsql
security definer
set search_path = public
as $$
declare v_tz text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator may see who viewed a record' using errcode = '42501';
  end if;
  select local_timezone into v_tz from public.app_settings where id;
  return query
    select to_char(v.viewed_at at time zone v_tz, 'YYYY-MM-DD HH24:MI') as at,
           coalesce(p.full_name, '(account removed)') as staff,
           r.first_name || ' ' || r.last_name as resident,
           v.surface as "where"
      from public.resident_views v
      left join public.profiles p on p.id = v.actor_id
      join public.residents r on r.id = v.resident_id
     where (v.viewed_at at time zone v_tz)::date between p_from and p_to
     order by v.viewed_at desc;
end;
$$;
revoke all on function public.resident_views_between(date, date) from public, anon;
grant execute on function public.resident_views_between(date, date) to authenticated;

-- Retention follows the audit trail: the period the register exists.
create or replace function public.purge_resident_views()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.resident_views where viewed_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_resident_views() from public, anon, authenticated;

-- The Art. 15 export now carries the views of the record it exports.
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
