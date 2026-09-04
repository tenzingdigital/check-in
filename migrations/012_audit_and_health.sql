-- ---------------------------------------------------------------------------
-- 012_audit_and_health.sql — the administrators leave a trail, logins are
-- remembered, and the nightly job can be seen to have run.
-- ---------------------------------------------------------------------------
--
-- Guards' every tap has always been attributed and immutable. The people with
-- power were not logged at all: changing a resident's date of birth or ID
-- number, promoting an account, disabling one, editing retention. Item F5 in
-- docs/SECURITY-ROADMAP.md. Three additions, all append-only:
--
--   admin_audit        who changed what, on residents, profiles and
--                      app_settings, with the row before and after. Written by
--                      triggers as the table owner; readable by admins; no
--                      role can update or delete a row. Purged on the register
--                      retention horizon. An export of a resident's record is
--                      also noted here (note_disclosure), so the single most
--                      sensitive read in the system is on the record too.
--   auth.login_events  every sign-in attempt and its outcome, with IP and
--                      user agent, kept 90 days — which is what the privacy
--                      notice already says is kept, and until now was not.
--   job_runs           one row per maintenance job per night, so a stale
--                      register is a red banner on every terminal rather than
--                      a silent gap (v_system_health).
--
-- Also here: profiles_update_self goes. It let any staff member rename
-- themselves, and every log view joins profiles for the name, so a renamed
-- account rewrote what history displayed. Names are an admin's to change.
--
-- Erasure and audit: an erased resident's audit rows would otherwise keep the
-- name and date of birth the erasure removed, so erase_resident() deletes
-- them too, and a residents DELETE is audited without the old row (the
-- erasure_log's digest is the proof it happened).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Administrators' actions
-- ---------------------------------------------------------------------------

create table if not exists public.admin_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references public.profiles (id) on delete set null,
  table_name  text not null,
  row_id      text not null,
  action      text not null check (action in ('insert', 'update', 'delete', 'export')),
  old_row     jsonb,
  new_row     jsonb,
  note        text
);

create index if not exists admin_audit_at_idx  on public.admin_audit (at);
create index if not exists admin_audit_row_idx on public.admin_audit (table_name, row_id);

comment on table public.admin_audit is
  'Append-only record of administrators'' and supervisors'' changes. Written by triggers; readable by admins; never updated or deleted except by the retention purge and erasure.';

alter table public.admin_audit enable row level security;
drop policy if exists admin_audit_admin_read on public.admin_audit;
create policy admin_audit_admin_read on public.admin_audit for select using (public.is_admin());
-- Default privileges hand authenticated INSERT/UPDATE/DELETE; RLS with no
-- write policy already refuses them, and saying so is cheap.
revoke insert, update, delete on public.admin_audit from anon, authenticated, service_role;
revoke all on public.admin_audit from anon;

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id  text;
begin
  if tg_op = 'DELETE' then
    v_id := old.id::text;
    -- A residents DELETE is an erasure: keep no copy of what was erased.
    if tg_table_name <> 'residents' then v_old := to_jsonb(old); end if;
  elsif tg_op = 'INSERT' then
    v_id := new.id::text;
    v_new := to_jsonb(new);
  else
    v_id := new.id::text;
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
  end if;

  -- Derived and noisy columns add nothing to "what changed".
  v_old := v_old - 'search_key' - 'updated_at';
  v_new := v_new - 'search_key' - 'updated_at';
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;

  insert into public.admin_audit (actor_id, table_name, row_id, action, old_row, new_row)
  values (auth.uid(), tg_table_name, v_id, lower(tg_op), v_old, v_new);

  return coalesce(new, old);
end;
$$;

revoke all on function public.audit_row() from public, anon, authenticated, service_role;

drop trigger if exists residents_audit on public.residents;
create trigger residents_audit
  after insert or update or delete on public.residents
  for each row execute function public.audit_row();

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after insert or update or delete on public.profiles
  for each row execute function public.audit_row();

drop trigger if exists app_settings_audit on public.app_settings;
create trigger app_settings_audit
  after update on public.app_settings
  for each row execute function public.audit_row();

-- An export is a disclosure. The route calls this in the same transaction as
-- export_resident_record(), with the reason the administrator gave.
create or replace function public.note_disclosure(p_resident_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin may export a resident record' using errcode = '42501';
  end if;
  if length(coalesce(btrim(p_reason), '')) = 0 then
    raise exception 'A reason for the export is required' using errcode = '22023';
  end if;
  insert into public.admin_audit (actor_id, table_name, row_id, action, note)
  values (auth.uid(), 'residents', p_resident_id::text, 'export', btrim(p_reason));
end;
$$;

revoke all on function public.note_disclosure(uuid, text) from public, anon;
grant execute on function public.note_disclosure(uuid, text) to authenticated;

-- The audit outlives the movement log and dies with the register.
create or replace function public.purge_expired_audit()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.admin_audit where at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_audit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A name is an admin's to change
-- ---------------------------------------------------------------------------
drop policy if exists profiles_update_self on public.profiles;

-- ---------------------------------------------------------------------------
-- 3. Erasure removes the audit rows too; export includes them
-- ---------------------------------------------------------------------------

create or replace function public.erase_resident(p_resident_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions   -- digest() comes from pgcrypto
as $$
declare
  v_events   integer;
  v_register integer;
  v_audit    integer;
  v_digest   text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;

  if not exists (select 1 from public.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  select count(*)::integer into v_events
  from public.gate_events where resident_id = p_resident_id;

  select count(*)::integer into v_register
  from public.daily_compliance where resident_id = p_resident_id;

  v_digest := encode(digest(p_resident_id::text, 'sha256'), 'hex');

  -- The audit rows carry the name and date of birth the erasure is removing.
  -- They go first, as the owner (this function is invoker-rights, so an
  -- admin's own DELETE would be refused by RLS): a definer helper does it.
  v_audit := public.erase_audit_rows(p_resident_id);

  -- Cascades to gate_events, checkin_events, daily_compliance.
  delete from public.residents where id = p_resident_id;

  insert into public.erasure_log (resident_digest, events_removed, reason, performed_by)
  values (v_digest, v_events, nullif(btrim(p_reason), ''), auth.uid());

  return jsonb_build_object(
    'erased', true,
    'events_removed', v_events,
    'register_rows_removed', v_register,
    'audit_rows_removed', v_audit,
    'digest', v_digest
  );
end;
$$;

create or replace function public.erase_audit_rows(p_resident_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;
  delete from public.admin_audit
   where table_name = 'residents' and row_id = p_resident_id::text;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.erase_audit_rows(uuid) from public, anon;
grant execute on function public.erase_audit_rows(uuid) to authenticated;

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

-- ---------------------------------------------------------------------------
-- 4. Login events
-- ---------------------------------------------------------------------------
create table if not exists auth.login_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  email      text,
  user_id    uuid references auth.users (id) on delete set null,
  outcome    text not null check (outcome in ('ok', 'bad_password', 'unknown_email', 'disabled', 'locked')),
  ip         text,
  user_agent text
);
create index if not exists login_events_at_idx    on auth.login_events (at);
create index if not exists login_events_email_idx on auth.login_events (lower(email));

comment on table auth.login_events is
  'Every sign-in attempt and its outcome, kept 90 days. Written by the API on the owner connection; no request role can read it.';

revoke all on auth.login_events from anon, authenticated, service_role;

create or replace function auth.purge_expired_login_events()
returns integer
language plpgsql security definer set search_path = auth
as $$
declare v_n integer;
begin
  delete from auth.login_events where at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function auth.purge_expired_login_events() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Job runs and the health view
-- ---------------------------------------------------------------------------
create table if not exists public.job_runs (
  id      bigint generated always as identity primary key,
  job     text not null,
  ran_at  timestamptz not null default now(),
  ok      boolean not null,
  result  text
);
create index if not exists job_runs_job_idx on public.job_runs (job, ran_at desc);
revoke all on public.job_runs from anon, authenticated, service_role;

create or replace function public.purge_expired_job_runs()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_n integer;
begin
  delete from public.job_runs where ran_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_job_runs() from public, anon, authenticated;

-- What every terminal needs to know about the register's upkeep, in one row.
-- close_out_behind is the one that matters: true when the last day the
-- nightly job closed is before yesterday, which means the register is no
-- longer recording who was missed.
create or replace view public.v_system_health as
select
  (select max(compliance_date) from public.daily_compliance where closed_at is not null) as last_closed_day,
  public.site_today() as site_today,
  (select max(ran_at) from public.job_runs where job = 'close-out-compliance-days' and ok) as last_close_out_run,
  (select max(ran_at) from public.job_runs where ok) as last_job_run,
  (select count(*)::integer from public.job_runs where not ok and ran_at > now() - interval '2 days') as recent_failures,
  coalesce(
    (select max(compliance_date) from public.daily_compliance where closed_at is not null) < public.site_today() - 1,
    -- No closed day at all: behind only once there has been a full day to close.
    exists (select 1 from public.daily_compliance where compliance_date < public.site_today() - 1)
  ) as close_out_behind
where public.is_staff();

revoke all on public.v_system_health from anon, public;
grant select on public.v_system_health to authenticated;
