-- 058_push_alerts.sql — a phone that says so at 21:10, not an email on Monday.
--
-- Migration 054 exists because of the September incident: a parent signed OUT
-- in the evening and did not come back, her children were on site with nobody
-- responsible, and nothing said so until Monday. 054 can already state the
-- fact — guardian_gap_households() — but only the nightly job asks it, so the
-- answer arrives the following morning at the earliest.
--
-- This file is the other half: somewhere to keep the phones that have agreed
-- to be told, and somewhere to record that a gap has been notified so that the
-- next gate event does not tell everyone again.
--
-- Two deliberate properties, both about what leaves the building:
--
--   * A notification carries NO NAMES. The payload says a centre has a
--     safeguarding alert and nothing else; the app fetches who, after it has a
--     session. A lost phone on a bus must not have a child's name on its lock
--     screen, and the alert is the one message most likely to be read in
--     public.
--
--   * Web Push payloads are encrypted for the subscription's own key
--     (RFC 8291), so the push service relaying them — Google's, Mozilla's,
--     Apple's — cannot read them. That is the reason this is Web Push and not
--     a native FCM/APNs integration: the same alert through a native SDK is
--     readable by the provider.

-- ---------------------------------------------------------------------------
-- The phones that have agreed to be told
-- ---------------------------------------------------------------------------
-- One row per device, not per person: a supervisor with a phone and a tablet
-- is two subscriptions, and signing out of one must not silence the other.
--
-- Platform-level, in public, because auth.users is: a subscription belongs to
-- a login, and the login already names its tenant. Keeping it per-tenant would
-- mean a device row that outlived its schema.
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  -- The push service's URL for this device. Unique because re-subscribing on
  -- the same device returns the same endpoint, and a duplicate would send the
  -- same alert twice to one phone.
  endpoint    text        not null unique,
  -- The device's public key and auth secret, from PushSubscription.getKey().
  -- These encrypt the payload; the server cannot read a message it has sent,
  -- and neither can the push service.
  key_p256dh  text        not null,
  key_auth    text        not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  -- A push service answers 404 or 410 for a subscription the browser has
  -- dropped. Those are deleted outright; anything else (a timeout, a 500) is
  -- counted, and a device that has failed repeatedly stops being tried.
  failures    integer     not null default 0,

  constraint push_subscriptions_endpoint_https check (endpoint like 'https://%')
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

comment on table public.push_subscriptions is
  'Devices that have agreed to receive safeguarding alerts. One row per device. Payloads are encrypted for key_p256dh/key_auth, so neither the push service nor a backup of this table can read a sent alert.';

-- ---------------------------------------------------------------------------
-- Which gaps have already been said out loud
-- ---------------------------------------------------------------------------
-- Without this, every gate event recorded while a gap is open would notify
-- every phone again: a busy evening would be a dozen identical alerts, and the
-- thirteenth would be ignored.
--
-- A gap is opened when guardian_gap_households() first returns a household and
-- closed when it stops returning it — a guardian coming back, a supervision
-- arrangement being recorded, the last child signing out. The row is kept after
-- closing: "the gap on the 14th ran from 21:10 to 23:40" is exactly what an
-- inspection or a review asks, and it is the only place that is written down at
-- the minute it happened rather than at the next midnight.
--
-- In public rather than per-tenant for the same reason as
-- public.tenant_demo_rows: there is no per-tenant migration ledger yet
-- (docs/MULTI-TENANCY.md), so a table added to tenant/template.sql would reach
-- centres provisioned afterwards and not the ones already running.
create table if not exists public.guardian_gap_alerts (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants (id) on delete cascade,
  -- The household in that tenant's own schema. Not a foreign key: it cannot
  -- be, across schemas, and a household deleted afterwards should not erase
  -- the record that a gap happened.
  household_id     uuid        not null,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  children_on_site integer     not null,
  -- When the phones were told, and how many were reached. Null notified_at on
  -- an open row means the gap was found but the send has not run or failed
  -- outright, which is a thing worth being able to see.
  notified_at      timestamptz,
  notified_count   integer     not null default 0,

  constraint guardian_gap_alerts_closes_after check (closed_at is null or closed_at >= opened_at)
);

-- One open gap per household at a time. This is what makes the evaluation
-- idempotent: it runs on every gate event and inserts nothing when the gap it
-- found is already open.
create unique index if not exists guardian_gap_alerts_open_idx
  on public.guardian_gap_alerts (tenant_id, household_id) where closed_at is null;
create index if not exists guardian_gap_alerts_opened_idx
  on public.guardian_gap_alerts (tenant_id, opened_at desc);

comment on table public.guardian_gap_alerts is
  'Every guardian gap, from the minute it opened to the minute it closed, and whether the phones were told. The open-row index makes evaluation on each gate event idempotent.';

-- Neither table is reachable by a request role. Subscriptions are written by
-- the app under the owner connection after it has checked the session, and the
-- alert rows are written by the evaluation that runs after a gate event. A
-- guard's session has no business reading either.
revoke all on public.push_subscriptions   from anon, authenticated;
revoke all on public.guardian_gap_alerts  from anon, authenticated;
