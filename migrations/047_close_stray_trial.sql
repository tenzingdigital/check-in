-- Close the stray self-serve trial "cheksteadysitetest" (confirmed with
-- Aimee, 2026-09-13: her own click through the trial signup while testing,
-- not a real centre). Its schema was provisioned before migration 041 (and
-- others since) ever caught it up -- the exact risk docs/KNOWN-ISSUES.md #4
-- describes -- which is what broke the nightly overnight-safeguarding-alert
-- job: "column p.safeguarding_alert does not exist" in that schema.
--
-- Takes the same three steps DELETE /api/tenants/:id does (routes/tenants.js),
-- since a platform admin closing it by hand would do exactly this: end its
-- sessions, drop its schema, mark the tenant row closed. Logins are left
-- alone on purpose (auth.users.tenant_id is ON DELETE RESTRICT, so the audit
-- trail keeps the names) -- they simply can no longer sign in once the
-- schema behind them is gone.
--
-- Guarded so this is a no-op anywhere the tenant doesn't exist (every other
-- environment, and this one again on a future boot).

do $$
declare
  v_id public.tenants.id%type;
  v_slug constant text := 'cheksteadysitetest';
begin
  select id into v_id from public.tenants where slug = v_slug;
  if v_id is not null then
    delete from auth.sessions s using auth.users u where u.id = s.user_id and u.tenant_id = v_id;
    execute format('drop schema if exists %I cascade', 't_' || replace(v_slug, '-', '_'));
    update public.tenants set status = 'closed', closed_at = now() where id = v_id and status <> 'closed';
  end if;
end $$;
