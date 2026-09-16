-- 050_absence_window_max_nights.sql — permitted absence periods can carry a
-- maximum stay, and can be edited.
--
-- Two complaints land in one migration:
--   1. "I had a typo in a permitted absence date and can't edit it" — the
--      owner. There was no PATCH; only add-and-remove (036). Fixed in
--      routes/settings.js, not here.
--   2. The IPAS circular's wording for Ramadan and Easter — "Managers may
--      facilitate such reasonable requests of no more than 2 weeks" — is a
--      maximum per period, not a fact about the calendar, so it lives on
--      the period rather than as a second global figure alongside
--      holiday_max_days (029, which is a different rule: the longest
--      holiday of any kind, anywhere on the calendar). A window with no
--      figure here has no maximum; the register still warns, never
--      refuses — same as every other check in 036.
alter table public.absence_windows
  add column if not exists max_nights integer check (max_nights between 1 and 365);
comment on column public.absence_windows.max_nights is 'Longest stay permitted for this period, in nights inclusive of both ends (to - from + 1). Null: no maximum. IPAS: "no more than 2 weeks" for Ramadan and Easter.';

-- 036 granted select, insert, delete but not update — there was nothing to
-- update. The RLS policy (absence_windows_admin, "for all") already covers
-- an admin's UPDATE; only the table-level grant was missing.
grant update on public.absence_windows to authenticated;
