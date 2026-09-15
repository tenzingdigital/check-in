-- 049_email_unsubscribe.sql — a way out of the site emails.
--
-- Three recurring emails reach staff: the Sunday Weekly register update
-- (035/037), the nightly safeguarding alert (041) and the nightly House
-- Rules reminder (032). Until now none of them could be stopped by the
-- person receiving it; the first two by an admin unticking them, the third
-- not at all. This adds an Unsubscribe link to all three, and records the
-- fact of opting out SEPARATELY from the tick, so Admin → Staff can say
-- "unsubscribed themselves on the 14th" rather than showing an unticked box
-- indistinguishable from one an admin never ticked.
--
-- Spec: docs/superpowers/specs/2026-09-15-email-unsubscribe-design.md

-- ---------------------------------------------------------------------------
-- The fact of opting out. One row per person per kind of email.
--
-- An `id` column even though (profile_id, kind) is the natural key, because
-- audit_row() (012) writes new.id and is attached below unchanged — every
-- opt-out and opt-in then lands in admin_audit, attributed to whoever the
-- request set request.jwt.claim.sub to (the person, when they used the link).
-- ---------------------------------------------------------------------------
create table if not exists public.email_opt_outs (
  id              bigint generated always as identity primary key,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  kind            text not null check (kind in ('weekly_report', 'safeguarding_alert', 'house_rules')),
  unsubscribed_at timestamptz not null default now(),
  unique (profile_id, kind)
);

comment on table public.email_opt_outs is
  'A staff member opted themselves out of one of the site emails via the link in its footer. Absence of a row with the tick off means an admin unticked them. Read by the staff list; written only through the owner (the unsubscribe page) or an admin (re-ticking).';

alter table public.email_opt_outs enable row level security;
drop policy if exists email_opt_outs_read on public.email_opt_outs;
create policy email_opt_outs_read on public.email_opt_outs for select using (public.is_staff());
drop policy if exists email_opt_outs_admin on public.email_opt_outs;
create policy email_opt_outs_admin on public.email_opt_outs for delete using (public.is_admin());
revoke all on public.email_opt_outs from anon, public, authenticated;
grant select, delete on public.email_opt_outs to authenticated;

drop trigger if exists email_opt_outs_audit on public.email_opt_outs;
create trigger email_opt_outs_audit
  after insert or update or delete on public.email_opt_outs
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- The key in the link. One per person, minted on first use, reused after.
--
-- Stored in clear, unlike a password-reset token, because it has to be put
-- in every email that goes out — a hash cannot be re-sent — and because all
-- it can do is toggle that one person's rows above. Nobody but the owner
-- can read the table: no grant to authenticated or anon at all. Deleting a
-- row invalidates that person's links; the next send mints a fresh one.
-- ---------------------------------------------------------------------------
create table if not exists public.email_link_keys (
  profile_id  uuid primary key references public.profiles (id) on delete cascade,
  key         text not null unique,
  created_at  timestamptz not null default now()
);

comment on table public.email_link_keys is
  'The random key carried by a staff member''s Unsubscribe links (049). Owner-only; handed out by email_link_key().';

alter table public.email_link_keys enable row level security;
revoke all on public.email_link_keys from anon, public, authenticated;

-- Mint or return. The nightly job calls this as the owner (auth.uid() is
-- null); the send-now route calls it as the admin who pressed the button.
-- Anyone else with a session — including the person themselves — is refused:
-- a supervisor reading their own key gains nothing they cannot do from the
-- email, and a supervisor reading a colleague's could unsubscribe them.
create or replace function public.email_link_key(p_profile uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an administrator can build an unsubscribe link.' using errcode = '42501';
  end if;
  select key into v_key from public.email_link_keys where profile_id = p_profile;
  if v_key is not null then return v_key; end if;
  -- 32 bytes, base64url without padding: 43 characters that survive a URL.
  v_key := replace(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=', '');
  insert into public.email_link_keys (profile_id, key) values (p_profile, v_key)
    on conflict (profile_id) do update set key = public.email_link_keys.key
    returning key into v_key;
  return v_key;
end;
$$;

revoke all on function public.email_link_key(uuid) from public, anon;
grant execute on function public.email_link_key(uuid) to authenticated;
