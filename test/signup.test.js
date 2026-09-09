// Self-serve trials, end to end. Run:  ./test/signup.sh
/* ============================================================================

   The one unauthenticated write in the system, so the questions this asks are
   mostly about abuse and about the halves of the flow not being able to drift
   apart:

     - a POST provisions NOTHING: no schema, no tenant, no login
     - the email carries a link, and only the link creates the centre
     - the link works once; a second click, or an expired one, creates nothing
     - a sample-data trial arrives full: residents, rooms, a family, someone
       away, somebody on the attention list, and check-ins recorded today
     - an empty trial arrives empty, and no fabricated resident is anywhere
     - the sample rows are registered, so Admin can clear exactly those
     - the trial's write gate is live now and false the moment it lapses
     - rate limits refuse the fourth request from one address in an hour
     - a throwaway address and an address that already has an account are
       refused, with a page a person can read rather than JSON

   Assertions are plain throws, and there is no test framework — same reasoning
   as test/api.test.js next door.
   ========================================================================= */

const assert = require('assert/strict');
process.env.HUT_MAIL_SINK = '1';
const app = require('../server');
const { closePool, withOwner, withOwnerIn, migrate } = require('../database');
const tenancy = require('../lib/tenancy');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`   ok  ${name}`);
}

const mailTo = (email) =>
  (global.__mailSink || []).filter((m) => m.to === email).slice(-1)[0];

// The confirmation link out of the email that was "sent".
function linkFrom(mail) {
  const m = /\/signup\/confirm\?token=([A-Za-z0-9_-]+)/.exec(mail.text || '');
  assert.ok(m, 'the trial email carries no confirmation link');
  return m[1];
}

async function main() {
  await migrate({ log: () => {} });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (body, headers = {}) => fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  const confirm = (token) =>
    fetch(`${base}/signup/confirm?token=${encodeURIComponent(token)}`, { redirect: 'manual' });

  const tenantBySlug = (slug) => withOwner(async (c) => {
    const { rows } = await c.query('select * from public.tenants where slug = $1', [slug]);
    return rows[0];
  });

  console.log('\n== self-serve trials ==');

  // ---- the POST half ------------------------------------------------------
  await test('a sign-up is accepted, and provisions nothing at all', async () => {
    const before = await withOwner(async (c) =>
      (await c.query('select count(*)::int n from public.tenants')).rows[0].n);
    const res = await post({
      full_name: 'Niamh Byrne', email: 'niamh@harbourhouse.example',
      centre_name: 'Harbour House', seed: 'sample',
    }, { 'x-forwarded-for': '203.0.113.10' });
    assert.equal(res.status, 202);
    const html = await res.text();
    assert.match(html, /Check your email/, 'the person is told to check their email');
    assert.match(html, /niamh@harbourhouse\.example/, 'the page says which address');
    assert.doesNotMatch(html, /"ok"\s*:/, 'a browser must not be answered with JSON');

    const after = await withOwner(async (c) =>
      (await c.query('select count(*)::int n from public.tenants')).rows[0].n);
    assert.equal(after, before, 'a POST created a tenant — nothing may be provisioned before the email is proven');
    const schemas = await withOwner(async (c) =>
      (await c.query("select count(*)::int n from pg_namespace where nspname like 't\\_%'")).rows[0].n);
    assert.equal(schemas, 0, 'a POST created a schema');
  });

  await test('the request is stored as a digest, never the token itself', async () => {
    const row = await withOwner(async (c) =>
      (await c.query('select * from public.signup_requests where email = $1',
        ['niamh@harbourhouse.example'])).rows[0]);
    assert.ok(row, 'no pending request was written');
    assert.equal(row.seed, 'sample');
    assert.equal(row.slug, 'harbour-house', 'the slug comes from the centre name');
    assert.ok(Buffer.isBuffer(row.token_sha256) && row.token_sha256.length === 32);
    const mailed = mailTo('niamh@harbourhouse.example');
    const token = linkFrom(mailed);
    assert.ok(!row.token_sha256.equals(Buffer.from(token)), 'the raw token is in the table');
  });

  // ---- the click half -----------------------------------------------------
  let sampleTenant;
  await test('the link creates the centre and lands on choosing a password', async () => {
    const token = linkFrom(mailTo('niamh@harbourhouse.example'));
    const res = await confirm(token);
    assert.equal(res.status, 302, 'the confirmation should redirect into the app');
    const loc = res.headers.get('location');
    assert.match(loc, /^\/\?reset=[A-Za-z0-9_-]+&welcome=trial$/,
      'the redirect must carry a password-setting token, so the journey is one email not two');

    sampleTenant = await tenantBySlug('harbour-house');
    assert.ok(sampleTenant, 'no tenant was created');
    assert.equal(sampleTenant.status, 'trial');
    assert.equal(sampleTenant.name, 'Harbour House');
    const days = (new Date(sampleTenant.trial_ends_at) - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days < 7.1, `the trial should run 7 days, got ${days}`);
  });

  await test('the first administrator exists, in this centre, as an admin', async () => {
    const u = await withOwner(async (c) => (await c.query(
      `select u.id, u.tenant_id from auth.users u where lower(u.email) = $1`,
      ['niamh@harbourhouse.example'])).rows[0]);
    assert.ok(u, 'no login was created');
    assert.equal(u.tenant_id, sampleTenant.id, 'the login belongs to another centre');
    const p = await withOwnerIn(tenancy.schemaForSlug('harbour-house'), async (c) =>
      (await c.query('select role, full_name from profiles where id = $1', [u.id])).rows[0]);
    assert.equal(p.role, 'admin', 'the first account must be an administrator');
    assert.equal(p.full_name, 'Niamh Byrne');
  });

  await test('a sample trial opens on a centre that looks like a real morning', async () => {
    const schema = tenancy.schemaForSlug('harbour-house');
    const s = await withOwnerIn(schema, async (c) => {
      const one = async (sql) => (await c.query(sql)).rows[0];
      return {
        residents: (await one('select count(*)::int n from residents')).n,
        rooms:     (await one('select count(*)::int n from rooms')).n,
        families:  (await one('select count(*)::int n from households')).n,
        needs:     (await one("select count(*)::int n from residents where evac_need <> 'none'")).n,
        // Presence from the events, not from v_resident_status: that view is
        // gated on is_staff(), and this connection is the owner with no
        // session identity, so it would correctly return nothing.
        onSite:    (await one(`select count(*)::int n from (
                      select distinct on (resident_id) kind from gate_events
                       order by resident_id, occurred_at desc, id desc) t
                     where kind = 'in'`)).n,
        seenToday: (await one('select count(*)::int n from daily_compliance where compliance_date = site_today() and presented')).n,
        notSeen:   (await one('select count(*)::int n from daily_compliance where compliance_date = site_today() and not presented')).n,
        history:   (await one('select count(*)::int n from checkin_events')).n,
        away:      (await one('select count(*)::int n from authorised_absences')).n,
        settings:  await one('select feature_buildings, feature_evacuation, feature_households, feature_visitors from app_settings'),
      };
    });
    assert.ok(s.residents >= 25, `expected a full sample centre, got ${s.residents} residents`);
    assert.ok(s.rooms >= 10, `expected rooms, got ${s.rooms}`);
    assert.ok(s.families >= 3, `expected families, got ${s.families}`);
    assert.ok(s.needs >= 3, 'nobody needs assistance — the roll call would have nothing to show');
    assert.ok(s.onSite > 0 && s.onSite < s.residents, 'everybody or nobody is on site');
    assert.ok(s.seenToday > 0, 'nobody has checked in today — the register opens empty');
    assert.ok(s.notSeen > 0, 'everybody has checked in — the Not seen tile would be empty');
    assert.ok(s.history > 200, `expected weeks of history, got ${s.history} check-ins`);
    assert.equal(s.away, 1, 'no authorised absence, so "Away until" is never demonstrated');
    // A trial exists to show the product; the features default to off.
    for (const [k, v] of Object.entries(s.settings)) assert.equal(v, true, `${k} should be on for a trial`);
  });

  await test('somebody is on the attention list, with a run of missed nights', async () => {
    // Counted from daily_compliance rather than v_resident_compliance: that
    // view is gated on is_staff() and this connection is the owner, so it
    // would return nothing regardless of the data underneath it.
    const rows = await withOwnerIn(tenancy.schemaForSlug('harbour-house'), async (c) =>
      (await c.query(
        `select resident_id, count(*)::int as missed
           from daily_compliance
          where compliance_date > site_today() - 4
            and not presented and required
          group by resident_id having count(*) >= 3`)).rows);
    assert.ok(rows.length >= 1,
      'no resident has a run of missed nights, so Admin → Absences opens empty');
  });

  await test('every sample row is registered, so Admin can clear exactly those', async () => {
    const reg = await withOwner(async (c) => (await c.query(
      `select kind, count(*)::int n from public.tenant_demo_rows
        where tenant_id = $1 group by kind order by kind`, [sampleTenant.id])).rows);
    const byKind = Object.fromEntries(reg.map((r) => [r.kind, r.n]));
    const actual = await withOwnerIn(tenancy.schemaForSlug('harbour-house'), async (c) =>
      (await c.query('select count(*)::int n from residents')).rows[0].n);
    assert.equal(byKind.resident, actual, 'the registry and the register disagree on how many are sample rows');
    assert.ok(byKind.building >= 1 && byKind.household >= 3);
  });

  await test('a live trial may write; a lapsed one may not, and still reads', async () => {
    const may = () => withOwner(async (c) =>
      (await c.query('select public.tenant_may_write($1) as ok', [sampleTenant.id])).rows[0].ok);
    assert.equal(await may(), true, 'a live trial cannot write');
    await withOwner((c) => c.query(
      `update public.tenants set trial_ends_at = now() - interval '1 minute' where id = $1`,
      [sampleTenant.id]));
    assert.equal(await may(), false, 'a lapsed trial can still write');
    // Reading is a separate question and must survive: an expired trial must
    // never cost a centre the evidence it already recorded.
    const still = await withOwnerIn(tenancy.schemaForSlug('harbour-house'), async (c) =>
      (await c.query('select count(*)::int n from residents')).rows[0].n);
    assert.ok(still > 0, 'a lapsed trial lost its residents');
    await withOwner((c) => c.query(
      `update public.tenants set trial_ends_at = now() + interval '7 days' where id = $1`,
      [sampleTenant.id]));
  });

  await test('the link is single use', async () => {
    const token = linkFrom(mailTo('niamh@harbourhouse.example'));
    const res = await confirm(token);
    assert.equal(res.status, 410, 'a used link created something a second time');
    assert.match(await res.text(), /used, or has expired/);
    const n = await withOwner(async (c) => (await c.query(
      "select count(*)::int n from public.tenants where name = 'Harbour House'")).rows[0].n);
    assert.equal(n, 1, 'a second click made a second centre');
  });

  await test('an expired link creates nothing', async () => {
    await post({ full_name: 'Late Caller', email: 'late@slowmail.example',
                 centre_name: 'Late Centre', seed: 'empty' },
               { 'x-forwarded-for': '203.0.113.11' });
    const token = linkFrom(mailTo('late@slowmail.example'));
    await withOwner((c) => c.query(
      `update public.signup_requests set expires_at = now() - interval '1 minute'
        where email = 'late@slowmail.example'`));
    const res = await confirm(token);
    assert.equal(res.status, 410);
    assert.equal(await tenantBySlug('late-centre'), undefined, 'an expired link provisioned a centre');
  });

  await test('a garbage token creates nothing and does not crash', async () => {
    const res = await confirm('not-a-real-token');
    assert.equal(res.status, 410);
  });

  // ---- the empty trial ----------------------------------------------------
  await test('an empty trial arrives with no fabricated resident anywhere', async () => {
    await post({ full_name: 'Sean Murphy', email: 'sean@ownlist.example',
                 centre_name: 'Own List House', seed: 'empty' },
               { 'x-forwarded-for': '203.0.113.12' });
    const res = await confirm(linkFrom(mailTo('sean@ownlist.example')));
    assert.equal(res.status, 302);
    const t = await tenantBySlug('own-list-house');
    const counts = await withOwnerIn(tenancy.schemaForSlug('own-list-house'), async (c) => ({
      residents: (await c.query('select count(*)::int n from residents')).rows[0].n,
      buildings: (await c.query('select count(*)::int n from buildings')).rows[0].n,
    }));
    assert.equal(counts.residents, 0, 'an empty trial was seeded with sample people');
    assert.equal(counts.buildings, 0);
    const reg = await withOwner(async (c) => (await c.query(
      'select count(*)::int n from public.tenant_demo_rows where tenant_id = $1', [t.id])).rows[0].n);
    assert.equal(reg, 0, 'an empty trial registered demo rows');
  });

  await test('two centres of the same name get different slugs and schemas', async () => {
    await post({ full_name: 'Another Manager', email: 'other@harbour2.example',
                 centre_name: 'Harbour House', seed: 'empty' },
               { 'x-forwarded-for': '203.0.113.13' });
    const res = await confirm(linkFrom(mailTo('other@harbour2.example')));
    assert.equal(res.status, 302);
    const t = await tenantBySlug('harbour-house-2');
    assert.ok(t, 'the second Harbour House did not get a distinct slug');
    assert.notEqual(tenancy.schemaForSlug('harbour-house-2'), tenancy.schemaForSlug('harbour-house'));
  });

  // ---- refusals -----------------------------------------------------------
  await test('a throwaway address is refused, readably', async () => {
    const res = await post({ full_name: 'A Tester', email: 'x@mailinator.com',
                             centre_name: 'Throwaway', seed: 'sample' },
                           { 'x-forwarded-for': '203.0.113.20' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /will not reach you/);
    assert.equal(await tenantBySlug('throwaway'), undefined);
  });

  await test('an incomplete form is refused', async () => {
    for (const body of [
      { full_name: '', email: 'a@b.example', centre_name: 'X' },
      { full_name: 'A', email: 'not-an-email', centre_name: 'X' },
      { full_name: 'A', email: 'a@b.example', centre_name: '' },
    ]) {
      const res = await post(body, { 'x-forwarded-for': '203.0.113.21' });
      assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }
  });

  await test('an address that already has an account is told to sign in', async () => {
    const res = await post({ full_name: 'Niamh Byrne', email: 'niamh@harbourhouse.example',
                             centre_name: 'Harbour House Again', seed: 'sample' },
                           { 'x-forwarded-for': '203.0.113.22' });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /already has an account/);
  });

  await test('a fourth request from one address inside an hour is refused', async () => {
    const email = 'repeat@centre.example';
    for (let i = 0; i < 3; i++) {
      const res = await post({ full_name: 'R', email, centre_name: `Repeat ${i}`, seed: 'empty' },
                             { 'x-forwarded-for': `198.51.100.${i}` });
      assert.equal(res.status, 202, `request ${i + 1} should have been accepted`);
    }
    const res = await post({ full_name: 'R', email, centre_name: 'Repeat 4', seed: 'empty' },
                           { 'x-forwarded-for': '198.51.100.9' });
    assert.equal(res.status, 429, 'the fourth request in an hour was accepted');
  });

  await test('a sixth request from one connection inside an hour is refused', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 5; i++) {
      const res = await post({ full_name: 'F', email: `flood${i}@centre.example`,
                               centre_name: `Flood ${i}`, seed: 'empty' }, { 'x-forwarded-for': ip });
      assert.equal(res.status, 202, `request ${i + 1} from one IP should have been accepted`);
    }
    const res = await post({ full_name: 'F', email: 'flood9@centre.example',
                             centre_name: 'Flood 9', seed: 'empty' }, { 'x-forwarded-for': ip });
    assert.equal(res.status, 429, 'the sixth request from one connection was accepted');
  });

  // ---- the whole journey, and the promise made on the trial page ---------
  await test('the trial link sets a password, signs in, and clears the sample data', async () => {
    // Take a fresh centre so the earlier tests' state cannot mask anything.
    await post({ full_name: 'Dara Kelly', email: 'dara@journey.example',
                 centre_name: 'Journey House', seed: 'sample' },
               { 'x-forwarded-for': '203.0.113.30' });
    const res = await confirm(linkFrom(mailTo('dara@journey.example')));
    const resetToken = decodeURIComponent(/reset=([^&]+)/.exec(res.headers.get('location'))[1]);

    // The redirect lands on the app's password screen; this is what that
    // screen posts.
    const setPw = await fetch(`${base}/api/password-reset/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password: 'a-long-enough-passphrase' }),
    });
    assert.equal(setPw.status, 200, `setting the password failed: ${await setPw.text()}`);

    const login = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dara@journey.example', password: 'a-long-enough-passphrase' }),
    });
    assert.equal(login.status, 200, `the new administrator could not sign in: ${await login.text()}`);
    const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookie, 'no session cookie was set');

    const api = (path, opts = {}) => fetch(base + path, {
      ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) } });

    // Admin can see how much sample data is there...
    const before = await (await api('/api/settings/demo-data')).json();
    assert.ok(before.residents >= 25, `expected sample residents, got ${before.residents}`);

    // ...and clear exactly it.
    const cleared = await api('/api/settings/demo-data', { method: 'DELETE' });
    assert.equal(cleared.status, 200, `clearing failed: ${await cleared.text()}`);
    const after = await (await api('/api/settings/demo-data')).json();
    assert.equal(after.residents, 0, 'the registry still lists sample residents after clearing');

    const left = await withOwnerIn(tenancy.schemaForSlug('journey-house'), async (c) => ({
      residents: (await c.query('select count(*)::int n from residents')).rows[0].n,
      checkins:  (await c.query('select count(*)::int n from checkin_events')).rows[0].n,
    }));
    assert.equal(left.residents, 0, 'sample residents survived the clear');
    assert.equal(left.checkins, 0, 'their check-ins were orphaned rather than removed');
  });

  await test('a guard cannot clear the sample data', async () => {
    // The register belongs to the centre; deleting people is an admin act, and
    // the check must not live only on the screen.
    const schema = tenancy.schemaForSlug('journey-house');
    await withOwnerIn(schema, (c) => c.query(
      `update profiles set role = 'guard' where full_name = 'Dara Kelly'`));
    const login = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dara@journey.example', password: 'a-long-enough-passphrase' }),
    });
    const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).join('; ');
    const res = await fetch(`${base}/api/settings/demo-data`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 403, 'a guard was allowed to clear the register');
  });

  await test('spent and expired requests are swept away', async () => {
    const n = await withOwner(async (c) =>
      (await c.query('select public.sweep_signup_requests() as n')).rows[0].n);
    assert.ok(n >= 1, 'the sweep removed nothing, though an expired request exists');
    const left = await withOwner(async (c) => (await c.query(
      `select count(*)::int n from public.signup_requests
        where confirmed_at is null and expires_at < now()`)).rows[0].n);
    assert.equal(left, 0, 'expired requests survived the sweep');
  });

  await new Promise((r) => server.close(r));
  await closePool();
  console.log(`\n   ${passed} assertions passed\n`);
}

main().catch((err) => {
  console.error('\n   FAILED:', err && err.message);
  console.error(err);
  process.exit(1);
});
