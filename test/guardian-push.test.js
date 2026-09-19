// Guardian gap alerts, end to end. Run: ./test/guardian-push.sh
/* ============================================================================

   The September incident, replayed: a household with children on site, the
   last adult signs OUT at the gate, and the question is whether anything says
   so before Monday.

   What this asserts:

     - signing the last guardian out opens a gap and notifies the phones
     - a second gate event while the gap is open notifies nobody again
     - the guardian signing back in closes it
     - a supervision arrangement means there is no gap at all
     - a payload never carries a name, a count, an id or a room
     - a subscription the push service has dropped is deleted; other failures
       are counted and eventually stop being tried
     - a gap is still recorded when nobody is subscribed, so "found it, could
       not tell anyone" is visible rather than silent

   The push service itself is stubbed at the web-push boundary: this suite is
   about whether the right thing is sent to the right people at the right
   moment, not about whether Google's servers accept it.
   ========================================================================= */

const assert = require('assert/strict');
process.env.HUT_MAIL_SINK = '1';
process.env.PUBLIC_URL = 'https://hut-check-in.onrender.com';
// A throwaway pair, so isConfigured() is true and the payload assertions run.
// Never a deployment's keys: this one is in the repository.
const webpush = require('web-push');
const KEYS = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = KEYS.publicKey;
process.env.VAPID_PRIVATE_KEY = KEYS.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

// Stub the one call that would reach a push service. Everything above it —
// which devices, what payload, when — is the real code.
const outbox = [];
let nextFailure = null;                     // { status } applied to the next send
webpush.sendNotification = async (sub, body) => {
  if (nextFailure) {
    const err = new Error(`stubbed ${nextFailure.status}`);
    err.statusCode = nextFailure.status;
    nextFailure = null;
    throw err;
  }
  outbox.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
  return { statusCode: 201 };
};

// APNs stubbed at its own boundary. Configured so isConfigured() is true; the
// transport itself (HTTP/2 to Apple) is not what this suite is about.
process.env.APNS_KEY_ID = 'TESTKEYID0';
process.env.APNS_TEAM_ID = 'TESTTEAM00';
process.env.APNS_TOPIC = 'ie.checksteady.test';
{
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.APNS_KEY_P8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
}
const apns = require('../lib/apns');
const apnsOutbox = [];
let apnsFailure = null;                     // { status, reason, gone }
apns.send = async (token, message) => {
  if (apnsFailure) { const f = apnsFailure; apnsFailure = null; return { ok: false, ...f }; }
  apnsOutbox.push({ token, message });
  return { ok: true, status: 200 };
};

const db = require('../database');
const { closePool, withOwner, withOwnerIn, migrate } = db;
const tenancy = require('../lib/tenancy');
const push = require('../lib/push');
const guardianGap = require('../lib/guardianGap');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`   ok  ${name}`);
}

const SCHEMA = 'public';                    // the legacy tenant, which is public
let tenantId, adminId, household, parentId, childId;

async function gate(residentId, kind) {
  await withOwnerIn(SCHEMA, (c) => c.query(
    `insert into gate_events (resident_id, guard_id, kind) values ($1, $2, $3)`,
    [residentId, adminId, kind]));
}
const openGaps = () => withOwner(async (c) => (await c.query(
  `select * from public.guardian_gap_alerts where tenant_id = $1 and closed_at is null`,
  [tenantId])).rows);

async function main() {
  await migrate({ log: () => {} });

  // ---- a household: one adult, one child, both on site --------------------
  await withOwner(async (c) => {
    tenantId = (await c.query(`select id from public.tenants where slug = $1`, [tenancy.LEGACY_SLUG])).rows[0].id;
  });
  // A fresh database has no staff at all — the bootstrap admin is only made
  // when ADMIN_EMAIL/ADMIN_PASSWORD are set — so this suite makes its own.
  await withOwner(async (c) => {
    adminId = (await c.query(
      `select auth.create_user('warden@test.example', 'a-long-enough-passphrase', 'Test Warden', 'admin', $1) as id`,
      [tenantId])).rows[0].id;
  });
  await withOwnerIn(SCHEMA, async (c) => {
    household = (await c.query(`insert into households default values returning id`)).rows[0].id;
    parentId = (await c.query(
      `insert into residents (first_name, last_name, date_of_birth, household_id)
       values ('Testina', 'Zolfram', current_date - interval '34 years', $1) returning id`, [household])).rows[0].id;
    childId = (await c.query(
      `insert into residents (first_name, last_name, date_of_birth, household_id)
       values ('Vexbury', 'Zolfram', current_date - interval '9 years', $1) returning id`, [household])).rows[0].id;
  });
  await gate(parentId, 'in');
  await gate(childId, 'in');

  console.log('\n== guardian gap alerts ==');

  await test('both on site is not a gap', async () => {
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.opened, 0, 'a gap was opened while a guardian was on site');
    assert.equal((await openGaps()).length, 0);
  });

  // ---- a phone that has agreed to be told ---------------------------------
  const ENDPOINT = 'https://push.example.com/device-a';
  await test('a device subscribes, and a subscription is per device', async () => {
    await push.subscribe(adminId, { endpoint: ENDPOINT, p256dh: 'k-a', auth: 'a-a', userAgent: 'test' });
    await push.subscribe(adminId, { endpoint: 'https://push.example.com/device-b', p256dh: 'k-b', auth: 'a-b' });
    const n = await withOwner(async (c) => (await c.query(
      `select count(*)::int n from public.push_subscriptions where user_id = $1`, [adminId])).rows[0].n);
    assert.equal(n, 2, 'a phone and a tablet should be two subscriptions');
    // Re-subscribing the same device must not duplicate it.
    await push.subscribe(adminId, { endpoint: ENDPOINT, p256dh: 'k-a2', auth: 'a-a2' });
    const again = await withOwner(async (c) => (await c.query(
      `select count(*)::int n from public.push_subscriptions where user_id = $1`, [adminId])).rows[0].n);
    assert.equal(again, 2, 're-subscribing one device created a second row');
  });

  await withOwnerIn(SCHEMA, (c) => c.query(
    `update profiles set safeguarding_alert = true where id = $1`, [adminId]));

  // ---- the September scenario ---------------------------------------------
  await test('the last guardian signing out opens a gap and tells the phones', async () => {
    outbox.length = 0;
    await gate(parentId, 'out');
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.opened, 1, 'no gap was opened when the last guardian signed out');
    assert.equal(r.notified, 2, `expected both devices told, got ${r.notified}`);
    assert.equal(outbox.length, 2);

    const row = (await openGaps())[0];
    assert.equal(row.household_id, household);
    assert.equal(row.children_on_site, 1);
    assert.ok(row.notified_at, 'the gap was not recorded as notified');
  });

  await test('the payload carries no name, count, room or id', async () => {
    for (const { payload } of outbox) {
      const text = JSON.stringify(payload);
      for (const leak of ['Vexbury', 'Testina', 'Zolfram', household, parentId, childId]) {
        assert.ok(!text.includes(String(leak)), `the payload leaked ${String(leak).slice(0, 12)}: ${text}`);
      }
      assert.deepEqual(Object.keys(payload).sort(), ['kind', 'site', 'tag', 'url']);
      assert.equal(payload.kind, 'guardian-gap');
    }
    // And the rule is enforced, not merely observed.
    assert.throws(() => push.assertNoNames({ kind: 'guardian-gap', child: 'Vexbury Zolfram' }), /not allowed/);
    assert.throws(() => push.assertNoNames({ kind: 'guardian-gap', children_on_site: 1 }), /not allowed/);
  });

  await test('a second gate event during the same gap tells nobody again', async () => {
    outbox.length = 0;
    await gate(childId, 'in');                       // already in; a re-scan at the door
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.opened, 0, 'the same gap opened twice');
    assert.equal(outbox.length, 0, 'the phones were told twice about one gap');
    assert.equal((await openGaps()).length, 1, 'there should be exactly one open row');
  });

  await test('the guardian coming back closes it', async () => {
    await gate(parentId, 'in');
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.closed, 1, 'the gap did not close when the guardian returned');
    assert.equal((await openGaps()).length, 0);
    // The closed row is kept: "it ran from 21:10 to 23:40" is the question an
    // inspection asks, and this is the only record written at the minute.
    const closed = await withOwner(async (c) => (await c.query(
      `select * from public.guardian_gap_alerts where tenant_id = $1 and closed_at is not null`,
      [tenantId])).rows);
    assert.equal(closed.length, 1, 'the closed gap was deleted rather than kept');
    assert.ok(closed[0].closed_at >= closed[0].opened_at);
  });

  await test('a supervision arrangement means there is no gap', async () => {
    await withOwnerIn(SCHEMA, (c) => c.query(
      `insert into supervision_arrangements (household_id, carer_id, from_at, to_at, recorded_by)
       values ($1, $2, now() - interval '1 hour', now() + interval '4 hours', $3)`,
      [household, parentId, adminId]));
    outbox.length = 0;
    await gate(parentId, 'out');
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.opened, 0, 'a gap opened despite a supervision arrangement running');
    assert.equal(outbox.length, 0);
    await withOwnerIn(SCHEMA, (c) => c.query(
      `update supervision_arrangements set ended_at = now() where household_id = $1`, [household]));
  });

  // ---- what happens to phones that stop answering -------------------------
  await test('a dropped subscription is deleted; another failure is counted', async () => {
    // 410 Gone: the browser has thrown this subscription away.
    nextFailure = { status: 410 };
    await push.sendToUsers([adminId], { kind: 'guardian-gap', site: 'Test', url: '/', tag: 't' });
    const left = await withOwner(async (c) => (await c.query(
      `select endpoint, failures from public.push_subscriptions where user_id = $1 order by endpoint`,
      [adminId])).rows);
    assert.equal(left.length, 1, 'a 410 should delete exactly one subscription');

    // A 500 is the push service having a bad day, not the device being gone.
    nextFailure = { status: 500 };
    await push.sendToUsers([adminId], { kind: 'guardian-gap', site: 'Test', url: '/', tag: 't' });
    const after = await withOwner(async (c) => (await c.query(
      `select failures from public.push_subscriptions where user_id = $1`, [adminId])).rows);
    assert.equal(after.length, 1, 'a 500 deleted a subscription it should have kept');
    assert.equal(after[0].failures, 1, 'the failure was not counted');
  });

  // ---- the native iOS app -------------------------------------------------
  const APNS_TOKEN = 'a'.repeat(64);
  await test('an iPhone app registers its APNs token and is told too', async () => {
    // One person, two devices, two transports: the browser on a laptop and the
    // native app on a phone. Both must be reached by one call. Starting from a
    // clean slate rather than whatever the failure tests above left behind.
    await withOwner((c) => c.query(`delete from public.push_subscriptions where user_id = $1`, [adminId]));
    await push.subscribe(adminId, { endpoint: 'https://push.example.com/laptop', p256dh: 'k', auth: 'a' });
    await push.subscribe(adminId, { kind: 'apns', endpoint: APNS_TOKEN, userAgent: 'CheckSteady/1.0 iOS' });

    const rows = await withOwner(async (c) => (await c.query(
      `select kind, key_p256dh, key_auth from public.push_subscriptions
        where user_id = $1 order by kind`, [adminId])).rows);
    assert.deepEqual(rows.map((r) => r.kind), ['apns', 'webpush']);
    // An APNs row has no per-message keys: Apple encrypts the transport and
    // there is nothing to encrypt with (migration 059).
    assert.equal(rows[0].key_p256dh, null);
    assert.equal(rows[0].key_auth, null);

    outbox.length = 0; apnsOutbox.length = 0;
    await gate(parentId, 'in');                       // close whatever is open
    await guardianGap.evaluate(SCHEMA, tenantId);
    await gate(parentId, 'out');                      // and open it again
    const r = await guardianGap.evaluate(SCHEMA, tenantId);

    assert.equal(r.opened, 1);
    assert.equal(r.notified, 2, 'both the browser and the iPhone should have been told');
    assert.equal(outbox.length, 1, 'the browser was not sent a Web Push message');
    assert.equal(apnsOutbox.length, 1, 'the iPhone was not sent an APNs message');
  });

  await test('the APNs message names the centre and nobody else', async () => {
    const { token, message } = apnsOutbox[0];
    assert.equal(token, APNS_TOKEN);
    const text = JSON.stringify(message);
    for (const leak of ['Vexbury', 'Testina', 'Zolfram', household, parentId, childId]) {
      assert.ok(!text.includes(String(leak)), `the APNs message leaked ${String(leak).slice(0, 12)}`);
    }
    // Apple CAN read this payload, unlike a Web Push one. That is only
    // acceptable because there is nothing in it: a title, a sentence, and
    // where to land.
    assert.match(message.title, /Children may be unsupervised/);
    assert.ok(message.body && !/\d/.test(message.body), 'the body should carry no count');
  });

  await test('a dead APNs token is deleted; a transient failure is counted', async () => {
    apnsFailure = { status: 410, reason: 'Unregistered', gone: true };
    await push.sendToUsers([adminId], { kind: 'guardian-gap', site: 'Test', url: '/', tag: 't' });
    let kinds = await withOwner(async (c) => (await c.query(
      `select kind from public.push_subscriptions where user_id = $1`, [adminId])).rows.map((r) => r.kind));
    assert.ok(!kinds.includes('apns'), 'an Unregistered token should have been deleted');

    // And a transient one is kept and counted, as a Web Push 500 is.
    await push.subscribe(adminId, { kind: 'apns', endpoint: APNS_TOKEN });
    apnsFailure = { status: 500, reason: 'InternalServerError', gone: false };
    await push.sendToUsers([adminId], { kind: 'guardian-gap', site: 'Test', url: '/', tag: 't' });
    const row = await withOwner(async (c) => (await c.query(
      `select failures from public.push_subscriptions where user_id = $1 and kind = 'apns'`,
      [adminId])).rows[0]);
    assert.ok(row, 'a 500 deleted a token it should have kept');
    assert.equal(row.failures, 1);
  });

  await test('a malformed device token is refused before it reaches the table', async () => {
    await assert.rejects(
      () => push.subscribe(adminId, { kind: 'apns', endpoint: 'not-a-hex-token' }), /hex/);
    await assert.rejects(
      () => push.subscribe(adminId, { kind: 'webpush', endpoint: 'http://insecure.example' }), /https/);
  });

  await test('a gap with nobody subscribed is still recorded', async () => {
    await withOwner((c) => c.query(`delete from public.push_subscriptions where user_id = $1`, [adminId]));
    outbox.length = 0; apnsOutbox.length = 0;
    // Close whatever the tests above left open, so this one opens its own gap
    // rather than depending on the state it inherited.
    await gate(parentId, 'in');
    await guardianGap.evaluate(SCHEMA, tenantId);
    await gate(parentId, 'out');
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.opened, 1, 'the gap was not recorded when no device was subscribed');
    assert.equal(r.notified, 0);
    const row = (await openGaps())[0];
    assert.equal(row.notified_at, null,
      'notified_at must stay null so "found it, could not tell anyone" is visible');
  });

  await test('evaluation is idempotent — running it again changes nothing', async () => {
    const before = await openGaps();
    const r = await guardianGap.evaluate(SCHEMA, tenantId);
    assert.equal(r.opened, 0);
    assert.equal(r.closed, 0);
    assert.deepEqual((await openGaps()).map((x) => x.id), before.map((x) => x.id));
  });

  // Leave the register as it was found.
  await withOwnerIn(SCHEMA, (c) => c.query(`delete from residents where id = any($1::uuid[])`, [[parentId, childId]]));
  await withOwner((c) => c.query(`delete from public.guardian_gap_alerts where tenant_id = $1`, [tenantId]));

  await closePool();
  console.log(`\n   ${passed} assertions passed\n`);
}

main().catch((err) => {
  console.error('\n   FAILED:', err && err.message);
  console.error(err);
  process.exit(1);
});
