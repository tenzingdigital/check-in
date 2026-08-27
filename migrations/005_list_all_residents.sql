-- ---------------------------------------------------------------------------
-- 005_list_all_residents.sql — let the list view show the whole register.
-- ---------------------------------------------------------------------------
--
-- The apps now load every resident into the list before anything is typed,
-- instead of showing an empty panel until two characters of a name.
-- search_residents() already treats an empty query as "match everyone"; the
-- only thing in the way was the hard cap of 100, which would silently
-- truncate a register larger than that (the demo seed alone is 200 rows).
-- Raise the ceiling to 1000 — still a backstop against a runaway request,
-- but comfortably above any plausible register for one site.
--
-- The body is otherwise identical to the 002_schema.sql definition.

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
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;
