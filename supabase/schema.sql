-- ============================================================================
-- Hut Check-In — database schema
-- Target: Supabase (PostgreSQL 15+)
--
-- Run this once in the Supabase SQL editor on a fresh project.
-- It is written to be re-runnable: every object is created with
-- "if not exists" / "or replace" and policies are dropped before creation.
--
-- Design notes
--  * gate_events is an append-only ledger of site entry/exit. It answers
--    presence ("is this person in or out?"). There is no daily reset and no
--    nightly job that mutates state — "today's log" is a timestamp range
--    filter. It does not drive daily-compliance tracking — that lives
--    elsewhere (see checkin_events, added separately).
--  * Guards never read the residents table directly. They read v_resident_status,
--    which deliberately omits date_of_birth and exposes only age_years /
--    is_adult. Data minimisation (GDPR Art. 5(1)(c)) enforced in the schema.
--  * Everything a guard can do goes through record_check(), so business rules
--    (active resident, double-tap dedupe, guard attribution) cannot be bypassed
--    by a hand-written client.
-- ============================================================================

begin;

-- Extensions live in their own schema on Supabase. Creating the schema first
-- and keeping it on the search_path means unqualified calls (digest,
-- word_similarity, gin_trgm_ops) resolve whether the extension ended up in
-- "extensions" or in "public" on an older project.
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
set search_path = public, extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;

-- unaccent(text) is only STABLE because it resolves the dictionary through the
-- search_path, so it cannot be used in a generated column or an index. Naming
-- the dictionary explicitly gives us an IMMUTABLE variant. The schema is looked
-- up at install time so this works wherever the extension landed.
do $$
declare v_schema text;
begin
  select n.nspname into v_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'unaccent';

  execute format(
    'create or replace function public.immutable_unaccent(text) '
    'returns text language sql immutable strict parallel safe as '
    '$fn$ select %I.unaccent(%L::regdictionary, $1) $fn$',
    v_schema, v_schema || '.unaccent'
  );
end $$;


-- ---------------------------------------------------------------------------
-- Site configuration (single row)
-- ---------------------------------------------------------------------------
-- Kept in the database rather than the front end so a supervisor can change the
-- compliance window or retention period without a redeploy.

create table if not exists public.app_settings (
  id                      boolean primary key default true check (id),
  site_name               text    not null default 'Security Hut',
  local_timezone          text    not null default 'Europe/Dublin',
  -- Hour of the site-local day after which "not seen yet" starts being flagged.
  due_soon_after_hour     integer not null default 18 check (due_soon_after_hour between 0 and 23),
  -- Statutory proof horizon for the daily register. PLACEHOLDER: set to the
  -- real retention period before go-live.
  compliance_retention_days integer not null default 2555 check (compliance_retention_days between 1 and 36500),
  adult_age_years         integer not null default 18  check (adult_age_years between 1 and 30),
  -- GDPR Art. 5(1)(e): storage limitation. Applies to both gate_events and
  -- checkin_events.
  event_retention_days    integer not null default 90  check (event_retention_days between 1 and 3650),
  updated_at              timestamptz not null default now()
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- Staff (guards / supervisors / admins)
-- ---------------------------------------------------------------------------
-- One row per auth.users row. Accounts are created by an admin in the Supabase
-- dashboard — public sign-up MUST be disabled (see README).

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null,
  role       text not null default 'guard' check (role in ('guard', 'supervisor', 'admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Staff accounts. role=guard: search + sign residents in/out. supervisor: also manage residents. admin: also manage staff and run GDPR export/erasure.';

-- Auto-create a profile whenever an admin adds a user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data ->> 'role', ''), 'guard')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
-- security definer so that RLS policies on profiles cannot recurse into
-- themselves. They read only the caller's own row.

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.role from public.profiles p where p.id = auth.uid() and p.active), 'none');
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.my_role() in ('guard', 'supervisor', 'admin');
$$;

create or replace function public.is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.my_role() in ('supervisor', 'admin');
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.my_role() = 'admin';
$$;


-- The current date at the site, not on the server. Every compliance decision
-- routes through this so there is exactly one definition of "a day".
create or replace function public.site_today()
returns date
language sql
stable
set search_path = public, extensions
as $$
  select (now() at time zone (select local_timezone from public.app_settings where id))::date;
$$;

-- Was the daily rule in force for this person on this specific day? Age is
-- computed as of p_day, never as of today — otherwise backfilling a resident's
-- history would retroactively apply the duty to days when they were 17.
create or replace function public.compliance_required(
  p_dob           date,
  p_registered_on date,
  p_departed_on   date,
  p_day           date,
  p_adult_age     integer
)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select p_day >= p_registered_on
     and (p_departed_on is null or p_day <= p_departed_on)
     and p_dob <= (p_day - make_interval(years => p_adult_age))::date;
$$;


-- ---------------------------------------------------------------------------
-- Residents
-- ---------------------------------------------------------------------------

create table if not exists public.residents (
  id            uuid primary key default gen_random_uuid(),
  first_name    text not null check (length(btrim(first_name)) > 0),
  last_name     text not null check (length(btrim(last_name)) > 0),
  -- Needed to apply the 18+ rule, and to know when a minor becomes an adult.
  -- Never exposed to guards — see v_resident_status.
  date_of_birth date not null check (date_of_birth > '1900-01-01' and date_of_birth <= current_date),
  room_ref      text,
  status        text not null default 'active' check (status in ('active', 'departed')),
  -- The day the resident stopped being subject to the daily rule. status alone
  -- cannot answer that for a PAST date, which would corrupt close-out backfill.
  departed_on   date,
  -- Free-text operational note, e.g. "uses side gate". Deliberately NOT a
  -- place for health, religion or other special-category data (GDPR Art. 9).
  note          text,
  registered_at timestamptz not null default now(),
  registered_by uuid references public.profiles (id) on delete set null,
  updated_at    timestamptz not null default now(),

  -- Matched against by search_residents(). Lower-cased and stripped of accents
  -- so a guard on an ASCII keyboard finds "Ó Súilleabháin" by typing
  -- "suilleabhain". The name appears in both orders so "smith john" and
  -- "john smith" both hit.
  search_key text generated always as (
    lower(public.immutable_unaccent(
      btrim(first_name) || ' ' || btrim(last_name) || ' ' ||
      btrim(last_name)  || ' ' || btrim(first_name) || ' ' ||
      coalesce(room_ref, '')
    ))
  ) stored,

  constraint departed_on_requires_status
    check (departed_on is null or status = 'departed')
);

create index if not exists residents_search_key_trgm_idx
  on public.residents using gin (search_key gin_trgm_ops);

create index if not exists residents_status_idx
  on public.residents (status);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists residents_touch_updated_at on public.residents;
create trigger residents_touch_updated_at
  before update on public.residents
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Gate events (append-only ledger)
-- ---------------------------------------------------------------------------

create table if not exists public.gate_events (
  id          bigint generated always as identity primary key,
  resident_id uuid not null references public.residents (id) on delete cascade,
  guard_id    uuid not null references public.profiles (id) on delete restrict,
  kind        text not null check (kind in ('in', 'out')),
  occurred_at timestamptz not null default now(),
  note        text
);

create index if not exists gate_events_resident_time_idx
  on public.gate_events (resident_id, occurred_at desc, id desc);
create index if not exists gate_events_time_idx
  on public.gate_events (occurred_at desc);

comment on table public.gate_events is
  'Append-only record of site entry and exit. Answers "who is on site now". Does NOT satisfy the daily check-in requirement — see checkin_events.';


-- ---------------------------------------------------------------------------
-- Erasure log (GDPR Art. 17 accountability)
-- ---------------------------------------------------------------------------
-- Proves an erasure happened without retaining the erased person's data: the
-- resident's identity is stored only as a salted-by-id hash.

create table if not exists public.erasure_log (
  id              bigint generated always as identity primary key,
  resident_digest text not null,
  events_removed  integer not null,
  reason          text,
  performed_by    uuid references public.profiles (id) on delete set null,
  performed_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- These run with the definer's rights (Supabase default) so that guards can
-- read a minimised projection without holding SELECT on public.residents.
-- Access is still gated per-call by the `public.is_staff()` predicate, and the
-- anon role is revoked below.

create or replace view public.v_resident_status as
with s as (
  select * from public.app_settings where id
),
last_event as (
  select distinct on (resident_id)
    resident_id, kind, occurred_at, guard_id
  from public.gate_events
  order by resident_id, occurred_at desc, id desc
)
select
  r.id,
  r.first_name,
  r.last_name,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as full_name,
  r.room_ref,
  r.status,
  r.note,
  r.search_key,
  -- Age only. The date of birth itself never leaves the residents table.
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  (r.date_of_birth <= current_date - make_interval(years => s.adult_age_years)) as is_adult,
  -- Current presence. Someone with no history at all is treated as "out".
  coalesce(le.kind, 'out') as presence,
  le.occurred_at as last_event_at,
  le.guard_id    as last_event_guard_id
from public.residents r
cross join s
left join last_event le on le.resident_id = r.id
where public.is_staff();

comment on view public.v_resident_status is
  'Guard-facing projection of residents. Exposes age_years and is_adult but never date_of_birth.';


create or replace view public.v_check_log as
select
  e.id,
  e.resident_id,
  e.kind,
  e.occurred_at,
  e.note,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as resident_name,
  r.room_ref,
  e.guard_id,
  g.full_name as guard_name
from public.gate_events e
join public.residents r on r.id = e.resident_id
join public.profiles  g on g.id = e.guard_id
where public.is_staff();

comment on view public.v_check_log is
  'Human-readable event feed. Filter by occurred_at range for "today''s log".';


-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Ranked name search, tolerant of typos: "novak" still finds "Nowak", which
-- matters when a guard is typing a half-heard name on a cold night.
--
-- Note the use of word_similarity() rather than similarity(). search_key holds
-- the name twice plus the room, so plain similarity() against the whole string
-- is heavily diluted — "novak" scores only 0.15 against Marek Nowak's key and
-- would never match. word_similarity() scores the query against the best-
-- matching extent within the key instead, giving 0.50 for that same pair while
-- unrelated residents stay at or below 0.20. The 0.4 cut-off sits in that gap.
-- It is spelled as an explicit predicate rather than the %> operator so the
-- threshold lives here rather than in a session GUC.
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
  -- Normalise the query exactly the way search_key was normalised.
  cross join (select lower(public.immutable_unaccent(btrim(coalesce(q, '')))) as nq) n
  where public.is_staff()
    and (include_departed or v.status = 'active')
    and (
      n.nq = ''
      or v.search_key like '%' || n.nq || '%'
      -- Fuzzy matches are a fallback, not a supplement: they are offered only
      -- when nothing matches literally. Without this, typing the exact room
      -- "b-11" also returned B-06 and B-02, because short codes share trigrams
      -- — three cards where the guard expected one, at the moment they are
      -- about to tap a name.
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
    -- Prefix match beats substring match beats fuzzy match.
    case when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 100));
$$;


-- The only write path a guard has. Enforces attribution, resident status and
-- double-tap protection, then returns the resident's refreshed status row so
-- the UI updates in a single round trip.
--
-- SECURITY DEFINER is required, not incidental: guards deliberately hold no
-- SELECT on public.residents (that table carries date_of_birth), so an invoker-
-- rights version cannot even read the resident's status to validate it, and
-- every sign-in fails with "Resident not found". The function is safe to
-- elevate because it is a closed operation — it re-checks is_staff() itself and
-- takes the guard identity from auth.uid() rather than from an argument, so
-- there is no parameter a caller can use to act as someone else.
create or replace function public.record_check(
  p_resident_id uuid,
  p_direction   text,
  p_note        text default null
)
returns setof public.v_resident_status
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_guard  uuid := auth.uid();
  v_status text;
  v_last   public.gate_events;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check events'
      using errcode = '42501';
  end if;

  if p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;

  select status into v_status from public.residents where id = p_resident_id;
  if v_status is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'Resident is not active and cannot be signed in or out'
      using errcode = '23514';
  end if;

  -- Ignore an identical repeat within 60 seconds (double tap on a touchscreen).
  select * into v_last
  from public.gate_events
  where resident_id = p_resident_id
  order by occurred_at desc, id desc
  limit 1;

  if v_last.id is null
     or v_last.kind <> p_direction
     or v_last.occurred_at < now() - interval '60 seconds'
  then
    insert into public.gate_events (resident_id, guard_id, kind, note)
    values (p_resident_id, v_guard, p_direction, nullif(btrim(p_note), ''));
  end if;

  return query
    select * from public.v_resident_status where id = p_resident_id;
end;
$$;


-- Counts for the header. One round trip instead of three.
create or replace function public.hut_summary()
returns table (on_site integer, events_today integer)
language sql stable security invoker set search_path = public, extensions
as $$
  select
    count(*) filter (where presence = 'in' and status = 'active')::integer,
    (select count(*)::integer from public.gate_events e
      where e.occurred_at >= date_trunc('day',
              now() at time zone (select local_timezone from public.app_settings where id)
            ) at time zone (select local_timezone from public.app_settings where id))
  from public.v_resident_status
  where public.is_staff();
$$;


-- ---------------------------------------------------------------------------
-- GDPR operations (admin only)
-- ---------------------------------------------------------------------------

-- Art. 15 / Art. 20: everything held about one resident, as portable JSON.
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
               'note', e.note,
               'recorded_by', g.full_name
             ) order by e.occurred_at)
      from public.gate_events e
      join public.profiles g on g.id = e.guard_id
      where e.resident_id = r.id
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


-- Art. 17: erase a resident and their history, leaving only a non-identifying
-- record that the erasure took place.
create or replace function public.erase_resident(p_resident_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions   -- digest() comes from pgcrypto
as $$
declare
  v_events  integer;
  v_digest  text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;

  if not exists (select 1 from public.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  select count(*)::integer into v_events
  from public.gate_events where resident_id = p_resident_id;

  v_digest := encode(digest(p_resident_id::text, 'sha256'), 'hex');

  delete from public.residents where id = p_resident_id;  -- cascades to events

  insert into public.erasure_log (resident_digest, events_removed, reason, performed_by)
  values (v_digest, v_events, nullif(btrim(p_reason), ''), auth.uid());

  return jsonb_build_object('erased', true, 'events_removed', v_events, 'digest', v_digest);
end;
$$;


-- Art. 5(1)(e): storage limitation. Run daily by pg_cron (see below).
create or replace function public.purge_expired_gate_events()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_days    integer;
  v_deleted integer;
begin
  select event_retention_days into v_days from public.app_settings where id;
  delete from public.gate_events where occurred_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_expired_gate_events is
  'Deletes gate events older than app_settings.event_retention_days. Schedule daily with pg_cron.';


-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.app_settings enable row level security;
alter table public.profiles     enable row level security;
alter table public.residents    enable row level security;
alter table public.gate_events  enable row level security;
alter table public.erasure_log  enable row level security;

-- app_settings: everyone on staff reads it, only admins change it.
drop policy if exists app_settings_read  on public.app_settings;
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_read  on public.app_settings for select using (public.is_staff());
create policy app_settings_write on public.app_settings for update using (public.is_admin()) with check (public.is_admin());

-- profiles: staff see each other's names (the log shows who did what);
-- you may edit your own display name; only admins change roles or add rows.
drop policy if exists profiles_read        on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_admin_all   on public.profiles;
create policy profiles_read        on public.profiles for select using (public.is_staff() or id = auth.uid());
create policy profiles_update_self on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = public.my_role() and active);
create policy profiles_admin_all   on public.profiles for all using (public.is_admin()) with check (public.is_admin());

-- residents: guards do NOT hold select on this table. They use
-- v_resident_status, which omits date_of_birth.
drop policy if exists residents_read       on public.residents;
drop policy if exists residents_supervisor on public.residents;
create policy residents_read       on public.residents for select using (public.is_supervisor());
create policy residents_supervisor on public.residents for all    using (public.is_supervisor()) with check (public.is_supervisor());

-- gate_events: staff may append events attributed to themselves and read the
-- log. There is deliberately no update or delete policy for any role — the
-- ledger is append-only. Deletion happens via SECURITY DEFINER functions
-- (retention purge, GDPR erasure) that are individually authorised.
drop policy if exists gate_events_read   on public.gate_events;
drop policy if exists gate_events_insert on public.gate_events;
create policy gate_events_read   on public.gate_events for select using (public.is_staff());
create policy gate_events_insert on public.gate_events for insert
  with check (public.is_staff() and guard_id = auth.uid());

-- erasure_log: admins only.
drop policy if exists erasure_log_admin on public.erasure_log;
create policy erasure_log_admin on public.erasure_log for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Nothing is reachable without a session. The anon key alone gets you nowhere.

revoke all on public.v_resident_status from anon, public;
revoke all on public.v_check_log       from anon, public;
grant select on public.v_resident_status to authenticated;
grant select on public.v_check_log       to authenticated;

revoke all on function public.search_residents(text, boolean, integer)   from anon, public;
revoke all on function public.record_check(uuid, text, text)             from anon, public;
revoke all on function public.hut_summary()                              from anon, public;
revoke all on function public.export_resident_record(uuid)               from anon, public;
revoke all on function public.erase_resident(uuid, text)                 from anon, public;
revoke all on function public.purge_expired_gate_events()                from anon, public;
revoke all on function public.site_today()                               from anon, public;
revoke all on function public.compliance_required(date, date, date, date, integer) from anon, public;

grant execute on function public.search_residents(text, boolean, integer) to authenticated;
grant execute on function public.record_check(uuid, text, text)           to authenticated;
grant execute on function public.hut_summary()                            to authenticated;
grant execute on function public.export_resident_record(uuid)             to authenticated;
grant execute on function public.erase_resident(uuid, text)               to authenticated;
grant execute on function public.site_today()                               to authenticated;
grant execute on function public.compliance_required(date, date, date, date, integer) to authenticated;

commit;


-- ---------------------------------------------------------------------------
-- Scheduled retention purge
-- ---------------------------------------------------------------------------
-- Enable the pg_cron extension first: Supabase dashboard → Database →
-- Extensions → pg_cron. Then run the block below once.
--
--   create extension if not exists pg_cron with schema cron;
--
--   select cron.schedule(
--     'purge-expired-gate-events',
--     '15 3 * * *',                        -- 03:15 UTC daily
--     $$ select public.purge_expired_gate_events(); $$
--   );
--
-- To confirm:   select * from cron.job;
-- To remove:    select cron.unschedule('purge-expired-gate-events');
