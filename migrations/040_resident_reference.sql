-- 040: a reference of our own on every resident.
--
-- There has been no stable handle a person can use. The UUID is unusable by
-- hand; id_number (the TRC or IRP number) is optional — has_id exists because
-- many residents have none — and sensitive, so it should not be the thing
-- staff keep in a working file. So the import keys on
-- lower(first_name)|lower(last_name)|date_of_birth, which cannot tell two
-- residents of the same name and birthday apart, treats a corrected spelling
-- as a new person, and rests on a parser that reads every dd/mm/yyyy as
-- day-first whatever the sheet's origin.
--
-- Per centre, not global: each tenant schema carries its own sequence, so
-- every centre counts from one and the number means something locally.
--
-- From a sequence rather than max(ref) + 1, deliberately. An erased
-- resident's number must never be handed to the next arrival: a reference
-- that reappears against a different person makes every export that carries
-- it ambiguous after the fact.

create sequence if not exists public.resident_ref_seq;

alter table public.residents
  add column if not exists ref integer;

-- Existing residents first, in the order they arrived, so the numbers read
-- the way a person expects. setval afterwards so the sequence continues from
-- the end rather than colliding with what was just written.
do $$
declare v_max integer;
begin
  if exists (select 1 from public.residents where ref is null) then
    with ordered as (
      select id, row_number() over (order by registered_at, id) as n
        from public.residents where ref is null
    )
    update public.residents r set ref = o.n from ordered o where o.id = r.id;
  end if;
  select coalesce(max(ref), 0) into v_max from public.residents;
  perform setval('public.resident_ref_seq', greatest(v_max, 1), v_max > 0);
end $$;

alter table public.residents
  alter column ref set default nextval('public.resident_ref_seq');

-- Unique, and not null once every row has one. A trigger would be another
-- way to fill it, but a column default is filled by every writer including
-- one written years from now, and cannot be forgotten at a call site.
update public.residents set ref = nextval('public.resident_ref_seq') where ref is null;

alter table public.residents
  alter column ref set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.residents'::regclass and conname = 'residents_ref_unique'
  ) then
    alter table public.residents add constraint residents_ref_unique unique (ref);
  end if;
end $$;

comment on column public.residents.ref is
  'The centre''s own reference for this resident, from resident_ref_seq. Unique per centre, assigned on insert, never reused — an erased number must not reappear against a different person. Displayed zero-padded to four digits. The key for imports and bulk updates; id_number is the State''s number and stays separate.';

-- The reference is not sensitive and every staff member can already see the
-- resident it belongs to, so it rides on the views the app already reads
-- rather than needing a lookup of its own.
