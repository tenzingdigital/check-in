-- ---------------------------------------------------------------------------
-- 014_idle_lock.sql — how long a terminal may sit untouched before it locks.
-- ---------------------------------------------------------------------------
-- A session is a shift (12 hours), which is right as an upper bound and wrong
-- as the only bound: a guard who walks away leaves the register open for the
-- rest of the shift. The front end now signs the terminal out after this
-- many minutes without a touch. A site setting, not a constant: a hut with a
-- single guard on nights wants a longer leash than an office.

alter table public.app_settings
  add column if not exists idle_lock_minutes integer not null default 20
    check (idle_lock_minutes between 1 and 720);

comment on column public.app_settings.idle_lock_minutes is
  'Minutes without a touch before a terminal signs itself out. Sessions still expire at HUT_SESSION_HOURS regardless.';
