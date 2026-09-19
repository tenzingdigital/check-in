-- 059_apns_devices.sql — one table, two ways of reaching a phone.
--
-- 058 built alerts for the web app, where a device is a Web Push subscription:
-- an https endpoint at a push service plus the two keys that encrypt the
-- payload for it. A native iOS app is not that. Apple's Push Notification
-- service takes a device token and a JWT, and does its own transport
-- encryption; there is no per-message key and nothing for us to encrypt with.
--
-- Rather than a second table, the existing one learns a `kind`. The alternative
-- — push_subscriptions and apns_devices side by side — would mean every query
-- that asks "who can we reach" becoming a union, and the guardian gap
-- evaluation is the last place that should grow a special case.
--
-- WHAT CHANGES FOR PRIVACY, AND WHAT DOES NOT
--
-- Web Push payloads are encrypted for the subscribing device (RFC 8291), so
-- the relaying service carries ciphertext. APNs is not that: Apple can read
-- an alert payload.
--
-- This costs nothing here only because of the rule 058 already set and
-- lib/push.js already enforces: a payload carries the centre's name and
-- nothing else — no resident, no household, no count, no id. There is nothing
-- in it worth reading. That rule was written for the lock screen and it turns
-- out to be what makes a native transport acceptable too, which is the usual
-- shape of a good constraint.

-- One row is still one device. What differs is how it is addressed.
alter table public.push_subscriptions
  add column if not exists kind text not null default 'webpush';

do $$ begin
  alter table public.push_subscriptions
    add constraint push_subscriptions_kind_known check (kind in ('webpush', 'apns'));
exception when duplicate_object then null; end $$;

comment on column public.push_subscriptions.kind is
  'webpush: endpoint is a push service URL and the keys encrypt the payload. apns: endpoint is Apple''s device token, the keys are null, and Apple can read the payload — which is why a payload carries no names.';

-- An APNs device has no per-message keys, so the two key columns stop being
-- mandatory for every row and become mandatory for the kind that needs them.
alter table public.push_subscriptions alter column key_p256dh drop not null;
alter table public.push_subscriptions alter column key_auth   drop not null;

-- The endpoint check was "https://%", which is right for Web Push and wrong
-- for a device token. Replaced with one that knows both shapes: a Web Push
-- endpoint is a URL with both keys; an APNs token is hex, and Apple's have
-- been 64 characters for years but are not promised to stay that length, so
-- this checks the alphabet and a sane range rather than an exact size.
alter table public.push_subscriptions drop constraint if exists push_subscriptions_endpoint_https;

do $$ begin
  alter table public.push_subscriptions add constraint push_subscriptions_shape check (
    (kind = 'webpush'
       and endpoint like 'https://%'
       and key_p256dh is not null and key_auth is not null)
    or
    (kind = 'apns'
       and endpoint ~ '^[0-9a-fA-F]{32,200}$'
       and key_p256dh is null and key_auth is null)
  );
exception when duplicate_object then null; end $$;

-- The send path reads by user and kind: a person with an iPhone app and a
-- laptop browser is two rows of two kinds, and both should be told.
create index if not exists push_subscriptions_user_kind_idx
  on public.push_subscriptions (user_id, kind) where failures < 8;
