-- 057_kiosk_photo_and_room_search.sql — the tablet's photograph and branding,
-- and a room code alone finds the room.
--
-- Part 1: the owner wants the self check-in tablet to open on a photograph
-- of the centre (17 Sep 2026 brief, with three photos of the incumbent
-- tablet at Slaney). An administrator uploads the one photograph this site
-- shows; the kiosk reads it back, plus the site's name, through two more
-- SECURITY DEFINER doors built the same way as kiosk_search()/kiosk_checkin()
-- (051): the kiosk role is not staff and must not gain any reach beyond
-- exactly what these doors hand back. site_photos holds the bytes — RLS
-- enabled with no policies at all, and every grant revoked, so the table is
-- reachable only from inside a SECURITY DEFINER function running as its
-- owner, never directly by any role, staff included. There is room for more
-- than one kind of site photograph one day (kind is a column, not baked into
-- the table name), but exactly one is defined today: 'kiosk'.
--
-- Part 2: kiosk_search() (051) already matches a room's full painted label
-- (building · floor · number) exactly. The incumbent tablet at Slaney is
-- found by room code alone ("C09"), which is what is written on the door and
-- what a resident is actually asked for — the building and floor are not on
-- the door. Re-created in full from 051 (its only prior definition) with one
-- added clause; everything else, including the exact-match discipline and
-- the five-row limit, is unchanged.
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. site_photos — the bytes, reachable only through the functions below.
-- ---------------------------------------------------------------------------
create table if not exists public.site_photos (
  kind         text primary key check (kind in ('kiosk')),
  content_type text not null,
  bytes        bytea not null,
  uploaded_by  uuid references public.profiles (id),
  uploaded_at  timestamptz not null default now()
);

comment on table public.site_photos is
  'One photograph per kind ("kiosk": the self check-in tablet''s attract screen). RLS enabled with no policies at all and every grant revoked — reachable only from inside set_site_photo()/clear_site_photo()/site_photo(), which run as this table''s owner. Never joined, never queried directly, by any role including admin.';

alter table public.site_photos enable row level security;
-- No policy is created at all: with RLS on and no policy, ordinary role
-- membership grants nothing, whatever privilege a future migration might
-- mistakenly add. The revoke below is belt and braces on top of that.
revoke all on public.site_photos from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. set_site_photo(kind, content_type, bytes) — admin only; upsert; audited.
-- ---------------------------------------------------------------------------
-- Type and size are checked here, in SQL, as the one gate every caller must
-- pass through — the route (routes/settings.js) also sniffs the file's
-- magic bytes against the declared type before it ever reaches this
-- function, but that is a kindness to the person uploading (a clear "that's
-- not a JPEG" instead of a database error), not the security boundary.
create or replace function public.set_site_photo(p_kind text, p_content_type text, p_bytes bytea)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.my_role();
begin
  if v_role <> 'admin' then
    raise exception 'Only an administrator can set the tablet''s photograph' using errcode = '42501';
  end if;
  if p_kind not in ('kiosk') then
    raise exception 'Unknown photograph' using errcode = '22023';
  end if;
  if p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Photograph must be a JPEG, PNG or WebP image' using errcode = '22023';
  end if;
  if length(p_bytes) < 1 or length(p_bytes) > 4194304 then
    raise exception 'Photograph must be no more than 4 MB' using errcode = '22023';
  end if;

  insert into public.site_photos (kind, content_type, bytes, uploaded_by, uploaded_at)
  values (p_kind, p_content_type, p_bytes, auth.uid(), now())
  on conflict (kind) do update
    set content_type = excluded.content_type,
        bytes         = excluded.bytes,
        uploaded_by   = excluded.uploaded_by,
        uploaded_at   = excluded.uploaded_at;

  -- The photograph itself never goes on the audit record — only its size,
  -- the same discipline note_disclosure (012) and the 056 correction rows
  -- already keep for every other sensitive write in this schema.
  insert into public.admin_audit (actor_id, table_name, row_id, action, new_row)
  values (auth.uid(), 'site_photos', p_kind, 'insert',
          jsonb_build_object('kind', p_kind, 'content_type', p_content_type, 'bytes', length(p_bytes)));
end;
$$;
revoke all on function public.set_site_photo(text, text, bytea) from public, anon;
grant execute on function public.set_site_photo(text, text, bytea) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. clear_site_photo(kind) — admin only; audited as a delete.
-- ---------------------------------------------------------------------------
create or replace function public.clear_site_photo(p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.my_role();
begin
  if v_role <> 'admin' then
    raise exception 'Only an administrator can remove the tablet''s photograph' using errcode = '42501';
  end if;

  delete from public.site_photos where kind = p_kind;

  insert into public.admin_audit (actor_id, table_name, row_id, action)
  values (auth.uid(), 'site_photos', p_kind, 'delete');
end;
$$;
revoke all on function public.clear_site_photo(text) from public, anon;
grant execute on function public.clear_site_photo(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. site_photo(kind) — kiosk and staff read the bytes.
-- ---------------------------------------------------------------------------
create or replace function public.site_photo(p_kind text)
returns table (content_type text, bytes bytea, uploaded_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.my_role();
begin
  if v_role not in ('kiosk', 'guard', 'supervisor', 'admin') then
    raise exception 'Not authorised to read the tablet''s photograph' using errcode = '42501';
  end if;

  return query
    select sp.content_type, sp.bytes, sp.uploaded_at
    from public.site_photos sp
    where sp.kind = p_kind;
end;
$$;
revoke all on function public.site_photo(text) from public, anon;
grant execute on function public.site_photo(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. kiosk_branding() — kiosk and staff learn the site name and whether a
--    photograph exists. Nothing else: this is the one thing settings: null
--    still leaves the kiosk able to see (see routes/session.js).
-- ---------------------------------------------------------------------------
create or replace function public.kiosk_branding()
returns table (site_name text, has_photo boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.my_role();
begin
  if v_role not in ('kiosk', 'guard', 'supervisor', 'admin') then
    raise exception 'Not authorised to read the site''s branding' using errcode = '42501';
  end if;

  return query
    select s.site_name, exists (select 1 from public.site_photos p where p.kind = 'kiosk') as has_photo
    from public.app_settings s
    where s.id;
end;
$$;
revoke all on function public.kiosk_branding() from public, anon;
grant execute on function public.kiosk_branding() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. kiosk_search(q) — the room code alone, exact match, finds the room.
-- ---------------------------------------------------------------------------
-- Re-created in full from 051, unchanged except for one added clause (marked
-- below) right after the existing exact-label match. See that migration's
-- comments for everything else here — the two-letter minimum, the LIKE
-- escaping, the five-row limit, the adult-only and child-never rules, all
-- carried over verbatim.
create or replace function public.kiosk_search(p_q text)
returns table (
  resident_id      uuid,
  full_name        text,
  room_label       text,
  checked_in_today boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role    text := public.my_role();
  v_nq      text;
  v_nq_like text;
  v_adult   integer;
begin
  if v_role not in ('kiosk', 'supervisor', 'admin') then
    raise exception 'Not authorised to search residents' using errcode = '42501';
  end if;

  -- Two letters minimum: the point of a search, not a list. A single letter
  -- (or the empty string a cleared box sends) would return "everyone whose
  -- name starts with A" off a shared tablet — this is the line that keeps
  -- kiosk_search a search. A query containing a LIKE wildcard is refused
  -- outright with the same message, belt and braces: '%%' or '__' would
  -- otherwise match every adult and 'a%' every adult whose name starts with
  -- "a", walking the whole roster five rows at a time. v_nq is also escaped
  -- below before it ever reaches a LIKE, so this remains true even if a
  -- future caller of this function forgets the check above matters.
  v_nq := lower(public.immutable_unaccent(btrim(coalesce(p_q, ''))));
  if length(v_nq) < 2 or position('%' in v_nq) > 0 or position('_' in v_nq) > 0 then
    raise exception 'Type at least two letters' using errcode = '22023';
  end if;

  -- Escaped for use inside LIKE: backslash first (so escaping % and _ does
  -- not itself get re-escaped), then the two LIKE metacharacters. Under
  -- standard_conforming_strings (the default since PG 9.1, and the only
  -- mode this schema runs in — see immutable_unaccent above), a plain
  -- '...' literal already treats backslash as an ordinary character, so no
  -- E'' prefix is needed here; every LIKE below still names ESCAPE '\'
  -- explicitly rather than relying on that being the unstated default.
  v_nq_like := replace(replace(replace(v_nq, '\', '\\'), '%', '\%'), '_', '\_');

  select adult_age_years into v_adult from public.app_settings where id;

  return query
    with matched as (
      select
        r.id                                              as m_id,
        btrim(r.first_name) || ' ' || btrim(r.last_name)   as m_full_name,
        case when rm.id is null then null
             else b.name
                  || case when rm.floor <> '' then ' · ' || rm.floor else '' end
                  || ' · ' || rm.number
        end                                                 as m_room_label,
        exists (
          select 1 from public.daily_compliance d
          where d.resident_id = r.id
            and d.compliance_date = public.site_today()
            and d.presented
        )                                                   as m_checked_in_today
      from public.residents r
      left join public.rooms     rm on rm.id = r.room_id
      left join public.buildings b  on b.id = rm.building_id
      where r.status = 'active'
        -- The daily register is an adult's duty (IPAS): a child is never on
        -- this screen at all, not merely hidden after being found — the row
        -- never enters the candidate set, so no branch below can surface one.
        -- site_today(), not current_date: current_date is the server clock's
        -- day (008's v_resident_status.is_adult still uses it, unchanged
        -- here — it is staff-facing and out of this migration's scope), and
        -- site_today() is the site-local day the rest of the register runs
        -- on (record_checkin_at, close-out, v_resident_compliance). The two
        -- disagree for at most the hour either side of local midnight; a
        -- kiosk's own write (below) must judge "adult" by the same calendar
        -- day it is about to write a check-in against, not the server's.
        and r.date_of_birth <= (public.site_today() - make_interval(years => v_adult))::date
        and (
          -- Name: prefix on either word order, so "aoi" and "brennan" both
          -- find Aoife Brennan. Deliberately NOT search_key — search_key
          -- (008) also folds in id_number, so a substring match on it would
          -- let a partial identity number through the name box. Matched on
          -- the plain names instead, word-prefix only (never a bare
          -- substring), so a person cannot be found by a fragment buried
          -- mid-name that happens to be common to many residents.
          lower(public.immutable_unaccent(btrim(r.first_name) || ' ' || btrim(r.last_name))) like v_nq_like || '%' escape '\'
          or lower(public.immutable_unaccent(btrim(r.first_name) || ' ' || btrim(r.last_name))) like '% ' || v_nq_like || '%' escape '\'
          or lower(public.immutable_unaccent(btrim(r.last_name) || ' ' || btrim(r.first_name))) like v_nq_like || '%' escape '\'
          or lower(public.immutable_unaccent(btrim(r.last_name) || ' ' || btrim(r.first_name))) like '% ' || v_nq_like || '%' escape '\'
          -- Room: the label as painted on the door, exact match only (never
          -- a prefix or substring) — a room holds several people, so a
          -- loose room match would be a mini roll-call of the whole room,
          -- which is exactly the "list" this function refuses to be.
          or (rm.id is not null and lower(
                b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number
              ) = v_nq)
          -- 057: the room code alone, exact match — what the door knows.
          -- Slaney's own incumbent tablet is found this way ("C09"), not by
          -- the full building/floor label above, which nobody at the door
          -- reads out. Still exact-only, for the same reason as the label
          -- match just above: a room holds several people.
          or (rm.id is not null and lower(rm.number) = v_nq)
          -- Identity number: EXACT match only, never a prefix or substring.
          -- id_number is upper-cased on write (routes/residents.js), so both
          -- sides are upper-cased here to match regardless of how it was
          -- typed. A prefix match would let the number be enumerated one
          -- digit at a time from a shared tablet; this closes that off
          -- entirely rather than just making it slow.
          or (r.id_number is not null and upper(r.id_number) = upper(btrim(coalesce(p_q, ''))))
        )
    )
    select
      m.m_id,
      m.m_full_name,
      -- The room is shown only to tell two same-named residents apart — by
      -- default one resident's room is never revealed to whoever is standing
      -- at the tablet.
      case when count(*) over (partition by m.m_full_name) > 1 then m.m_room_label else null end,
      m.m_checked_in_today
    from matched m
    order by m.m_full_name
    limit 5;
end;
$$;
revoke all on function public.kiosk_search(text) from public, anon;
grant execute on function public.kiosk_search(text) to authenticated;
