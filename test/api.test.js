// HTTP suite. Run:  ./test/api.sh   (it builds the throwaway cluster this needs)
/* ============================================================================

   The SQL suite (db/tests/) proves the database refuses what it should refuse.
   This suite proves the new web tier does not hand anyone a way around it —
   which is the whole question raised by replacing PostgREST and GoTrue with
   four hundred lines of our own. It asserts, in order:

     - the identity binding in withIdentity() actually reaches auth.uid()
     - no endpoint answers without a session
     - login refuses bad passwords, disabled accounts, and cross-origin posts
     - revocation takes effect immediately
     - only public/ is reachable over HTTP
     - the security headers the host config used to declare are really sent

   Assertions are plain throws. There is no test framework, for the same
   reason there is no web framework.
   ========================================================================= */

const assert = require('assert/strict');
process.env.HUT_MAIL_SINK = '1';   // lib/mail.js keeps what it would have sent in global.__mailSink
process.env.HUT_GEO_OVERRIDE = '1'; // lib/geo.js reads x-hut-test-country instead of the IP
const app = require('../server');
const auth = require('../lib/auth');
const { closePool, withIdentity, withOwner, migrate } = require('../database');

const PASSWORD = "correct-horse-battery";
const EMAIL = "gina@hut.example";

let passed = 0;
// Today as the seeded site (Europe/Dublin) counts it: between 23:00 and
// 00:00 UTC in summer that is not the UTC date, and every per-day assertion
// must agree with the register, not with the clock in the sandbox.
function siteToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`   ok  ${name}`);
}

/* ------------------------------------------------------------------------
   A cookie-holding HTTP client, which is all the front end is
   ---------------------------------------------------------------------- */

// A small cookie jar: the session cookie and, since migration 021, the
// trusted-device cookie travel together, and a cleared cookie (Max-Age=0 or
// an empty value) is forgotten rather than sent back.
function client(base) {
  const jar = new Map();
  const header = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") || null;
  return {
    get cookie() { return header(); },
    set cookie(v) { jar.clear(); if (v) for (const part of String(v).split(";")) { const [k, ...rest] = part.trim().split("="); if (k) jar.set(k, rest.join("=")); } },
    async fetch(path, { method = "GET", body, headers = {} } = {}) {
      const cookie = header();
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
      for (const sc of setCookies) {
        const [pair, ...attrs] = sc.split(";").map((x) => x.trim());
        const [name, ...rest] = pair.split("=");
        const value = rest.join("=");
        const cleared = !value || attrs.some((a) => /^max-age=0$/i.test(a));
        if (cleared) jar.delete(name); else jar.set(name, value);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json — a static file */ }
      return { status: res.status, headers: res.headers, text, json };
    },
  };
}

/* ------------------------------------------------------------------------
   Fixtures
   ---------------------------------------------------------------------- */

async function seedStaff() {
  return withOwner(async (c) => {
    const { rows } = await c.query(`select auth.create_user($1, $2, $3, $4) as id`, [
      EMAIL, PASSWORD, "Gina Guard", "guard",
    ]);
    // Residents plus a little history, so search and the log have something to
    // return. Applied after the guard exists because seed.sql attributes its
    // gate events to the first profile.
    const seed = require("fs").readFileSync(require("path").join(__dirname, "..", "seed.sql"), "utf8");
    await c.query(seed);
    return rows[0].id;
  });
}

/* ------------------------------------------------------------------------
   The suite
   ---------------------------------------------------------------------- */

// The first-account bootstrap can only be tested on an empty database, so it
// runs before any fixture exists — and cleans up after itself so seedStaff()
// below still creates the first profile (seed.sql attributes its gate events to
// whichever profile was created first).
async function testBootstrap() {
  console.log("\n== first account ==");

  await test("refuses to create anything when ADMIN_* is unset", async () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    assert.equal(await auth.seedAdminIfEmpty(), null);
    const { rows } = await withOwner((c) => c.query("select count(*)::int as n from public.profiles"));
    assert.equal(rows[0].n, 0, "an account was created without credentials");
  });

  await test("refuses a password shorter than 12 characters", async () => {
    process.env.ADMIN_EMAIL = "boss@hut.example";
    process.env.ADMIN_PASSWORD = "short";
    assert.equal(await auth.seedAdminIfEmpty(), null);
    const { rows } = await withOwner((c) => c.query("select count(*)::int as n from public.profiles"));
    assert.equal(rows[0].n, 0);
  });

  await test("creates one admin on an empty database, and it can log in", async () => {
    process.env.ADMIN_EMAIL = "boss@hut.example";
    process.env.ADMIN_PASSWORD = "a-long-enough-password";
    const created = await auth.seedAdminIfEmpty();
    assert.deepEqual(created, { email: "boss@hut.example" });

    const { rows } = await withOwner((c) =>
      c.query("select full_name, role, active from public.profiles"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "admin", "the first account must be an admin");
    assert.equal(rows[0].active, true);

    const session = await auth.signIn("boss@hut.example", "a-long-enough-password", { ip: "test" });
    assert.ok(session, "the bootstrapped admin could not log in");
  });

  await test("never fires twice", async () => {
    assert.equal(await auth.seedAdminIfEmpty(), null, "a second account was created");
  });

  // Remove it so the rest of the suite starts from an empty register. The
  // account has no events attributed to it, so nothing blocks the delete.
  await withOwner((c) => c.query("delete from auth.users where lower(email) = 'boss@hut.example'"));
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
}

async function main() {
  await testBootstrap();
  const guardId = await seedStaff();

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log("\n== migrations ==");

  // The migration runner is on the deploy path — index.js calls it before it
  // listens — so a bug in it is a failed deploy or, worse, a half-applied
  // schema. The cluster this suite runs against was built by it, so it has
  // already been proven to apply cleanly; what is left to prove is that it
  // knows when to stop and when to complain.

  await test("re-running applies nothing", async () => {
    const applied = await migrate({ log: () => {} });
    assert.deepEqual(applied, [], "a second run re-applied a migration");
  });

  await test("every migration is recorded, and numbered", async () => {
    const { rows } = await withOwner((c) =>
      c.query(`select name from public.schema_migrations order by name`));
    assert.ok(rows.length >= 2, "expected the platform and schema migrations to be recorded");
    assert.ok(rows.every((r) => /^\d{3}_.*\.sql$/.test(r.name)), "a migration is not numbered");
  });

  // A migration whose row is missing is one the runner would apply again, and a
  // half-recorded tracking table is what a restored backup looks like — so
  // re-application must at least be clean.
  //
  // The probe is always the NEWEST migration, and that is not arbitrary. These
  // files use `create or replace` on shared views, so replaying an OLDER one on
  // a newer schema rebuilds those views at the older shape and silently reverts
  // every later migration. The runner's guarantee is "apply what is pending, in
  // order", not "any subset can be replayed in any order". Re-point this at the
  // newest file whenever one is added.
  await test("a missing row makes the runner re-apply that migration, cleanly", async () => {
    const target = "011_default_tenant_for_new_users.sql";
    await withOwner((c) => c.query(`delete from public.schema_migrations where name = $1`, [target]));

    const applied = await migrate({ log: () => {} });
    assert.deepEqual(applied, [target]);

    const { rows } = await withOwner((c) =>
      c.query(`select name from public.schema_migrations where name = $1`, [target]));
    assert.equal(rows.length, 1, "the re-applied migration was not recorded");
  });

  console.log("\n== identity binding ==");

  // The hinge. If this is wrong, every policy in schema.sql is being evaluated
  // against the wrong user — or against no user, which fails open for
  // anything that only checks "is there a session".
  await test("withIdentity binds auth.uid() and the authenticated role", async () => {
    const seen = await withIdentity(guardId, async (c) => {
      const { rows } = await c.query(`select auth.uid() as uid, current_user as role, public.my_role() as app_role`);
      return rows[0];
    });
    assert.equal(seen.uid, guardId);
    assert.equal(seen.role, "authenticated");
    assert.equal(seen.app_role, "guard");
  });

  await test("no identity means anon, and auth.uid() is null", async () => {
    const seen = await withIdentity(null, async (c) => {
      const { rows } = await c.query(`select auth.uid() as uid, current_user as role, public.is_staff() as staff`);
      return rows[0];
    });
    assert.equal(seen.uid, null);
    assert.equal(seen.role, "anon");
    assert.equal(seen.staff, false);
  });

  // A checked-out client has no error listener of its own. If the database
  // drops the connection while a request holds it, pg emits 'error' on that
  // client, and an unhandled 'error' event kills the process — which is how
  // a database restart became a two-minute outage of this service. The
  // probe: hold a client, have another connection terminate its backend, and
  // require that the process is still here and the request merely fails.
  await test("a dropped database connection fails that request, not the process", async () => {
    await withOwner(async (held) => {
      const { rows: [{ pid }] } = await held.query("select pg_backend_pid() as pid");
      await withOwner((other) => other.query("select pg_terminate_backend($1)", [pid]));
      // Let the socket close and the 'error' event fire before we ask again.
      await new Promise((r) => setTimeout(r, 300));
      await assert.rejects(held.query("select 1"), /terminat|closed|Connection/i);
    });
    // The pool discarded the dead client; the next borrower gets a live one.
    const { rows } = await withOwner((c) => c.query("select 1 as ok"));
    assert.equal(rows[0].ok, 1);
  });

  // SET LOCAL is scoped to the transaction. If a bare SET ever crept in, a
  // pooled connection would carry one guard's identity into the next request
  // — the single worst bug this design could have.
  await test("identity does not leak between pooled transactions", async () => {
    await withIdentity(guardId, (c) => c.query("select 1"));
    const after = await withIdentity(null, async (c) => {
      const { rows } = await c.query(`select auth.uid() as uid`);
      return rows[0].uid;
    });
    assert.equal(after, null);
  });

  console.log("\n== authentication ==");
  const api = client(base);

  await test("every data endpoint refuses an anonymous caller", async () => {
    for (const path of ["/api/session", "/api/summary", "/api/residents?q=a", "/api/attention", "/api/checkin-summary"]) {
      const res = await api.fetch(path);
      assert.equal(res.status, 401, `${path} answered ${res.status}`);
    }
    const post = await api.fetch("/api/checkins", { method: "POST", body: { resident_id: guardId } });
    assert.equal(post.status, 401);
    const sync = await api.fetch("/api/sync", { method: "POST", body: { events: [] } });
    assert.equal(sync.status, 401, "the offline replay endpoint answered without a session");
  });

  await test("a wrong password is refused", async () => {
    const res = await api.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: "wrong" } });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /not recognised/);
  });

  await test("an unknown email gets the same message as a wrong password", async () => {
    const res = await api.fetch("/api/session", { method: "POST", body: { email: "nobody@hut.example", password: PASSWORD } });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /not recognised/);
  });

  await test("a cross-origin login post is refused", async () => {
    const res = await api.fetch("/api/session", {
      method: "POST",
      body: { email: EMAIL, password: PASSWORD },
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
  });

  await test("the right password opens a session", async () => {
    const res = await api.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    // The token must not be anything derived from the account.
    assert.ok(!cookie.includes(EMAIL) && !cookie.includes(guardId));
  });

  console.log("\n== the app, signed in ==");

  await test("the session endpoint names the guard and the site", async () => {
    const res = await api.fetch("/api/session");
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.full_name, "Gina Guard");
    assert.equal(res.json.profile.role, "guard");
    assert.ok(res.json.settings.local_timezone);
  });

  await test("search is typo-tolerant through the API", async () => {
    const res = await api.fetch("/api/residents?q=novak");
    assert.equal(res.status, 200);
    assert.ok(res.json.some((r) => r.last_name === "Nowak"), "fuzzy match did not survive the port");
  });

  // The reason guards hold no SELECT on public.residents. If the API ever
  // widened a projection, this is what would catch it.
  await test("no endpoint discloses a date of birth", async () => {
    const paths = ["/api/residents?q=a", "/api/residents?q=a&compliance=1", "/api/attention", "/api/checkin-summary"];
    for (const path of paths) {
      const res = await api.fetch(path);
      assert.equal(res.status, 200);
      assert.ok(!/date_of_birth/.test(res.text), `${path} leaked date_of_birth`);
    }
    // DPA Annex II: identity numbers are never in a list.
    const list = await api.fetch("/api/residents?q=&limit=1000&compliance=1");
    assert.ok(!/id_number/.test(list.text), "the list carries id_number");
    assert.ok(list.json.every((r) => typeof r.has_id === "boolean"), "has_id missing from the list");
  });

  await test("a gate event is recorded and attributed", async () => {
    const found = await api.fetch("/api/residents?q=brennan");
    const resident = found.json[0];
    const res = await api.fetch("/api/gate-events", {
      method: "POST",
      body: { resident_id: resident.id, direction: "out" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.presence, "out");

    // The log is per SITE day (Europe/Dublin in the seed), which between
    // 23:00 and 00:00 UTC in summer is already tomorrow's UTC date.
    const today = siteToday();
    const log = await api.fetch(`/api/gate-events?date=${today}`);
    assert.equal(log.status, 200);
    assert.ok(log.json.some((e) => e.resident_id === resident.id && e.guard_name === "Gina Guard"));
  });

  await test("a check-in satisfies the day", async () => {
    const found = await api.fetch("/api/residents?q=brennan&compliance=1");
    const resident = found.json[0];
    const res = await api.fetch("/api/checkins", { method: "POST", body: { resident_id: resident.id } });
    assert.equal(res.status, 200);
    assert.equal(res.json.presented, true);

    const after = await api.fetch(`/api/residents/${resident.id}/compliance`);
    assert.equal(after.json.seen_today, true);
  });

  // A calendar day must reach the browser as one. The driver's default would
  // send a DATE column as a midnight timestamp, which the page cannot format
  // and which shifts by a day off UTC.
  await test("dates cross the API as YYYY-MM-DD, not as timestamps", async () => {
    const found = await api.fetch("/api/residents?q=brennan&compliance=1");
    const resident = found.json[0];
    const days = await api.fetch(`/api/residents/${resident.id}/days`);
    assert.equal(days.status, 200);
    assert.ok(days.json.length > 0, "expected at least today's row after the check-in above");
    for (const d of days.json) {
      assert.match(String(d.compliance_date), /^\d{4}-\d{2}-\d{2}$/, `compliance_date was ${d.compliance_date}`);
    }
    const detail = await api.fetch(`/api/residents/${resident.id}/compliance`);
    if (detail.json.last_seen_on !== null) {
      assert.match(String(detail.json.last_seen_on), /^\d{4}-\d{2}-\d{2}$/, `last_seen_on was ${detail.json.last_seen_on}`);
    }
  });

  console.log("\n== offline sync ==");

  // The terminal queues events while the link is down and replays them here.
  // What the suite proves: the event lands dated when it HAPPENED and flagged
  // as synced later; a replay of the same ref records nothing twice; one bad
  // item does not take the batch down; and the bounds the database enforces
  // reach the terminal as a reason it can show, never as a 500.
  const syncResident = (await api.fetch("/api/residents?q=nowak")).json[0];
  const ref = () => require("crypto").randomUUID();
  const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
  const refs = { checkin: ref(), gate: ref() };

  await test("queued events are replayed, dated when they happened, and flagged", async () => {
    const occurred = agoIso(60_000);
    const gateAt = agoIso(90_000);
    const res = await api.fetch("/api/sync", {
      method: "POST",
      body: { events: [
        { ref: refs.checkin, kind: "checkin", resident_id: syncResident.id, occurred_at: occurred },
        { ref: refs.gate, kind: "gate", direction: "in", resident_id: syncResident.id, occurred_at: gateAt },
      ] },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.results.map((r) => r.status), ["ok", "ok"]);

    const { rows } = await withOwner((c) => c.query(
      `select late_entry, occurred_at, recorded_at from public.checkin_events where client_ref = $1`, [refs.checkin]));
    assert.equal(rows.length, 1, "the check-in was not recorded");
    assert.equal(rows[0].late_entry, true, "a synced event was not flagged");
    assert.ok(Math.abs(new Date(rows[0].occurred_at) - new Date(occurred)) < 1000, "occurred_at is not the terminal's time");
    assert.ok(new Date(rows[0].recorded_at) > new Date(rows[0].occurred_at), "recorded_at should be the later server time");

    const after = await api.fetch(`/api/residents/${syncResident.id}/compliance`);
    assert.equal(after.json.seen_today, true, "a synced check-in did not satisfy the day");

    // Per SITE day (Europe/Dublin), which after 23:00 UTC in summer is not the
    // UTC date; and matched on the queued time, not just the first "in".
    const today = siteToday();
    const log = await api.fetch(`/api/gate-events?date=${today}`);
    const entry = log.json.find((e) => e.resident_id === syncResident.id && e.kind === "in" && Math.abs(new Date(e.occurred_at) - new Date(gateAt)) < 1500);
    assert.ok(entry, "the synced gate event is not in the log");
    assert.equal(entry.late_entry, true, "the log does not show the event as synced later");
  });

  await test("replaying the same refs records nothing twice", async () => {
    const res = await api.fetch("/api/sync", {
      method: "POST",
      body: { events: [
        { ref: refs.checkin, kind: "checkin", resident_id: syncResident.id, occurred_at: agoIso(60_000) },
        { ref: refs.gate, kind: "gate", direction: "in", resident_id: syncResident.id, occurred_at: agoIso(90_000) },
      ] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.results.map((r) => r.status), ["ok", "ok"], "a replay must be answered ok so the terminal drops it");
    const { rows } = await withOwner((c) => c.query(
      `select (select count(*)::int from public.checkin_events where client_ref = $1) as c,
              (select count(*)::int from public.gate_events    where client_ref = $2) as g`, [refs.checkin, refs.gate]));
    assert.deepEqual(rows[0], { c: 1, g: 1 });
  });

  await test("one bad item is rejected with its reason; the rest of the batch still lands", async () => {
    const good = ref();
    const res = await api.fetch("/api/sync", {
      method: "POST",
      body: { events: [
        { ref: ref(), kind: "checkin", resident_id: syncResident.id, occurred_at: agoIso(3 * 86_400_000) },
        { ref: ref(), kind: "checkin", resident_id: syncResident.id, occurred_at: new Date(Date.now() + 3_600_000).toISOString() },
        { ref: ref(), kind: "checkin", resident_id: "00000000-0000-4000-8000-000000000000", occurred_at: agoIso(1000) },
        { ref: "not-a-uuid", kind: "gate", direction: "sideways", resident_id: syncResident.id, occurred_at: agoIso(1000) },
        { ref: good, kind: "gate", direction: "out", resident_id: syncResident.id, occurred_at: agoIso(30_000) },
      ] },
    });
    assert.equal(res.status, 200, res.text);
    const [old, future, unknown, malformed, ok] = res.json.results;
    assert.equal(old.status, "rejected");       assert.match(old.error, /window/);
    assert.equal(future.status, "rejected");    assert.match(future.error, /future/);
    assert.equal(unknown.status, "rejected");   assert.match(unknown.error, /Resident not found/);
    assert.equal(malformed.status, "rejected"); assert.equal(malformed.ref, "not-a-uuid");
    assert.equal(ok.status, "ok");
    const { rows } = await withOwner((c) => c.query(
      `select late_entry, kind from public.gate_events where client_ref = $1`, [good]));
    assert.deepEqual(rows, [{ late_entry: true, kind: "out" }]);
  });

  await test("an oversized batch is refused outright", async () => {
    const events = Array.from({ length: 201 }, () => ({ ref: ref(), kind: "checkin", resident_id: syncResident.id, occurred_at: agoIso(1000) }));
    const res = await api.fetch("/api/sync", { method: "POST", body: { events } });
    assert.equal(res.status, 400);
    const shape = await api.fetch("/api/sync", { method: "POST", body: { events: "nope" } });
    assert.equal(shape.status, 400);
  });

  await test("the session endpoint tells the terminal whose queue this is", async () => {
    const res = await api.fetch("/api/session");
    assert.equal(res.json.profile.id, guardId);
    assert.equal(res.json.settings.late_entry_window_hours, 48);
    assert.equal(res.json.settings.idle_lock_minutes, 20, "the idle-lock minutes reach the terminal");
  });

  await test("the app's connections run with JIT off", async () => {
    const { rows } = await withOwner((c) => c.query("select current_setting('jit') as jit"));
    assert.equal(rows[0].jit, "off", "database.js must pass -c jit=off; see KNOWN-ISSUES 19d");
  });

  await test("a malformed id is a 400, not a 500", async () => {
    const res = await api.fetch("/api/residents/not-a-uuid/compliance");
    assert.equal(res.status, 400);
  });

  await test("an RPC's own refusal reaches the guard intact", async () => {
    const res = await api.fetch("/api/checkins", {
      method: "POST",
      body: { resident_id: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Resident not found/);
  });

  console.log("\n== revocation ==");

  await test("deactivating a profile ends the session on the next request", async () => {
    await withOwner((c) => c.query(`update public.profiles set active = false where id = $1`, [guardId]));
    const res = await api.fetch("/api/summary");
    assert.equal(res.status, 401);

    const relogin = await api.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    assert.equal(relogin.status, 401, "a disabled account was able to log in again");

    await withOwner((c) => c.query(`update public.profiles set active = true where id = $1`, [guardId]));
  });

  await test("changing the password ends every existing session", async () => {
    const fresh = client(base);
    await fresh.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    assert.equal((await fresh.fetch("/api/summary")).status, 200);

    await withOwner((c) => c.query(`select auth.set_password($1, $2)`, [EMAIL, PASSWORD]));
    assert.equal((await fresh.fetch("/api/summary")).status, 401);
  });

  console.log("\n== tenants and trials ==");

  // The template is generated from the real schema (tools/gen-tenant-template.sh).
  // These tests are what make that generation trustworthy: a provisioned schema
  // is diffed against public, so a migration that changes a per-tenant object
  // without the template being regenerated fails here rather than silently
  // giving every future customer a different database.
  await test("a provisioned tenant schema matches the reference schema exactly", async () => {
    const tenancy = require("../lib/tenancy");
    await withOwner(async (c) => {
      await c.query(`drop schema if exists t_verify cascade`);
      await tenancy.provisionSchema(c, "verify", { siteName: "Verify" });
    });

    // Columns: name, type and nullability, for every table.
    const cols = (schema) => withOwner((c) => c.query(
      `select table_name, column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = $1
        order by table_name, column_name`, [schema]));

    const shared = new Set(["tenants", "schema_migrations"]);
    const ref = (await cols("public")).rows.filter((r) => !shared.has(r.table_name));
    const tenant = (await cols("t_verify")).rows;

    assert.deepEqual(
      tenant.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`),
      ref.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`),
      "the provisioned schema differs from public — regenerate tenant/template.sql");
  });

  await test("every view, function, policy and index is provisioned too", async () => {
    const count = (sql, schema) => withOwner((c) => c.query(sql, [schema]));
    const shared = `('tenants','schema_migrations','immutable_unaccent','touch_updated_at','tenant_may_write','expire_lapsed_trials','handle_new_user')`;

    const views = async (s) => (await count(
      `select table_name from information_schema.views where table_schema=$1 order by 1`, s)).rows.map((r) => r.table_name);
    assert.deepEqual(await views("t_verify"), await views("public"), "views differ");

    const fns = async (s) => (await count(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=$1 and p.proname not in ${shared} order by 1`, s)).rows.map((r) => r.proname);
    assert.deepEqual(await fns("t_verify"), await fns("public"), "functions differ");

    const pols = async (s) => (await count(
      `select tablename||'.'||policyname as p from pg_policies where schemaname=$1 order by 1`, s)).rows.map((r) => r.p);
    assert.deepEqual(await pols("t_verify"), await pols("public"), "row-level security policies differ");
  });

  // The point of the whole design: a tenant's data lives in its own schema, and
  // a tenant's functions resolve names there and nowhere else.
  await test("a tenant's rows land in its own schema and not in public", async () => {
    await withOwner((c) => c.query(
      `insert into t_verify.residents (first_name, last_name, date_of_birth)
       values ('Only', 'InVerify', '1990-01-01')`));

    const mine = await withOwner((c) =>
      c.query(`select count(*)::int as n from t_verify.residents`));
    assert.equal(mine.rows[0].n, 1, "the tenant's own row is not in its schema");

    const leak = await withOwner((c) =>
      c.query(`select count(*)::int as n from public.residents where last_name = 'InVerify'`));
    assert.equal(leak.rows[0].n, 0, "a tenant insert reached the public schema");
  });

  // This is the mechanism the whole isolation argument rests on, so it is
  // asserted directly rather than inferred. Each tenant's copy of each function
  // pins its own schema at CREATE time via proconfig, so it resolves names in
  // its own tenant whatever the caller's session search_path says. If a future
  // migration drops the `set search_path` from a function, this fails.
  await test("every tenant function pins its own schema, so it cannot be redirected", async () => {
    const { rows } = await withOwner((c) => c.query(
      `select p.proname, array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 't_verify'
        order by p.proname`));

    assert.ok(rows.length > 15, `expected the tenant's functions, found ${rows.length}`);
    const unpinned = rows.filter((r) => !/search_path=t_verify\b/.test(r.cfg || ""));
    assert.deepEqual(unpinned.map((r) => r.proname), [],
      "these functions do not pin the tenant schema and could be redirected by search_path");
  });

  await test("an invalid slug can never become a schema name", async () => {
    const tenancy = require("../lib/tenancy");
    for (const bad of ["a", "Harbour", "har bour", "har;bour", "public", "t_x\"; drop schema public; --"]) {
      assert.throws(() => tenancy.schemaForSlug(bad), /invalid slug/, `accepted ${bad}`);
    }
    assert.equal(tenancy.schemaForSlug("harbour-house"), "t_harbour_house");
    assert.equal(tenancy.schemaForSlug("default"), "public", "the legacy tenant must map to public");
  });


  await test("the existing deployment was adopted as the first tenant", async () => {
    const { rows } = await withOwner((c) => c.query(
      `select t.slug, t.status, count(u.id)::int as users
         from public.tenants t
         left join auth.users u on u.tenant_id = t.id
        group by t.slug, t.status`));
    assert.equal(rows.length, 1, "expected exactly one tenant after the backfill");
    assert.equal(rows[0].status, "active", "the pre-existing site must not be put on a trial");
    assert.ok(rows[0].users > 0, "existing logins were not attached to the tenant");
  });

  await test("no login is left without a tenant", async () => {
    const { rows } = await withOwner((c) =>
      c.query(`select count(*)::int as n from auth.users where tenant_id is null`));
    assert.equal(rows[0].n, 0);
  });

  // The whole point of the read-only expiry: a lapsed trial must not cost a
  // centre the evidence it already recorded.
  await test("a lapsed trial stops writing and keeps reading", async () => {
    const { rows: [t] } = await withOwner((c) => c.query(
      `insert into public.tenants (name, slug, status, trial_ends_at)
       values ('Trial Centre', 'trial-centre', 'trial', now() + interval '7 days')
       returning id`));

    const may = async () => (await withOwner((c) =>
      c.query(`select public.tenant_may_write($1) as ok`, [t.id]))).rows[0].ok;

    assert.equal(await may(), true, "a live trial cannot write");

    await withOwner((c) => c.query(
      `update public.tenants set trial_ends_at = now() - interval '1 minute' where id = $1`, [t.id]));
    assert.equal(await may(), false, "a lapsed trial can still write");

    // The row survives, which is what "read-only, not gone" means.
    const { rows } = await withOwner((c) =>
      c.query(`select status from public.tenants where id = $1`, [t.id]));
    assert.equal(rows.length, 1, "the lapsed tenant was deleted rather than expired");

    const { rows: [n] } = await withOwner((c) =>
      c.query(`select public.expire_lapsed_trials() as n`));
    assert.ok(n.n >= 1, "expire_lapsed_trials did not move the lapsed trial");

    const { rows: [after] } = await withOwner((c) =>
      c.query(`select status from public.tenants where id = $1`, [t.id]));
    assert.equal(after.status, "expired");
    assert.equal(await may(), false, "an expired tenant regained write access");

    await withOwner((c) => c.query(`delete from public.tenants where id = $1`, [t.id]));
  });

  await test("a tenant cannot be closed without a date", async () => {
    await assert.rejects(
      withOwner((c) => c.query(
        `insert into public.tenants (name, slug, status) values ('X', 'x-centre', 'closed')`)),
      /tenant_closed_has_date/,
      "a closed tenant with no closed_at was accepted");
  });

  console.log("\n== tenancy isolation (migration 020) ==");

  // A second centre, provisioned the way routes/tenants.js does it, with its
  // own admin and guard. Every request they make must run inside t_harbour
  // and see nothing of the legacy tenant in public — and vice versa.
  const tenancyLib = require("../lib/tenancy");
  let harbourId, harbourAdmin, harbourGuard, harbourResident;
  const hAdmin = client(base), hGuard = client(base);
  // The revocation section above ended the legacy guard's session; start a fresh one.
  assert.equal((await api.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } })).status, 200);
  await test("a second centre is provisioned with its own staff", async () => {
    await withOwner(async (c) => {
      await c.query(`delete from public.tenants where slug = 'harbour'`).catch(() => {});
      await c.query(`drop schema if exists t_harbour cascade`);
      const { rows } = await c.query(
        `insert into public.tenants (name, slug, status, terms_accepted_at, terms_version)
         values ('Harbour House', 'harbour', 'active', now(), 'test') returning id`);
      harbourId = rows[0].id;
      await tenancyLib.provisionSchema(c, "harbour", { siteName: "Harbour House" });
      harbourAdmin = (await c.query(`select auth.create_user($1, $2, $3, $4, $5) as id`,
        ["hadmin@harbour.example", PASSWORD, "Harbour Admin", "admin", harbourId])).rows[0].id;
      harbourGuard = (await c.query(`select auth.create_user($1, $2, $3, $4, $5) as id`,
        ["hguard@harbour.example", PASSWORD, "Harbour Guard", "guard", harbourId])).rows[0].id;
    });
    const inTenant = await withOwner((c) => c.query(`select role from t_harbour.profiles where id = $1`, [harbourAdmin]));
    assert.equal(inTenant.rows[0]?.role, "admin", "the new admin's profile is not in the tenant schema");
    const inPublic = await withOwner((c) => c.query(`select 1 from public.profiles where id = $1`, [harbourAdmin]));
    assert.equal(inPublic.rowCount, 0, "the new admin's profile leaked into public");
    assert.equal((await hAdmin.fetch("/api/session", { method: "POST", body: { email: "hadmin@harbour.example", password: PASSWORD } })).status, 200);
    assert.equal((await hGuard.fetch("/api/session", { method: "POST", body: { email: "hguard@harbour.example", password: PASSWORD } })).status, 200);
    const who = await hAdmin.fetch("/api/session");
    assert.equal(who.json.settings.site_name, "Harbour House", "the session reads the tenant's own settings");
  });

  await test("each centre lists only its own residents and staff", async () => {
    const made = await hAdmin.fetch("/api/residents", { method: "POST", body: { first_name: "Hana", last_name: "Harbourside", date_of_birth: "1988-02-02" } });
    assert.equal(made.status, 201, made.text);
    harbourResident = made.json.id;
    const where = await withOwner((c) => c.query(
      `select (select count(*)::int from t_harbour.residents where id = $1) as tenant,
              (select count(*)::int from public.residents where id = $1) as legacy`, [harbourResident]));
    assert.deepEqual(where.rows[0], { tenant: 1, legacy: 0 }, "the resident landed in the wrong schema");

    const theirs = await hGuard.fetch("/api/residents?q=&limit=1000");
    assert.equal(theirs.json.length, 1, "the harbour guard sees residents that are not theirs");
    assert.equal(theirs.json[0].id, harbourResident);
    const ours = await api.fetch("/api/residents?q=harbourside&limit=10");
    assert.equal(ours.json.length, 0, "the legacy guard can see a harbour resident");

    const staff = await hAdmin.fetch("/api/staff");
    assert.deepEqual(staff.json.map((s) => s.email).sort(), ["hadmin@harbour.example", "hguard@harbour.example"], "the staff list crossed tenants");
  });

  await test("a harbour admin cannot read, change, export or erase a legacy resident", async () => {
    const { rows } = await withOwner((c) => c.query(`select id from public.residents where status = 'active' limit 1`));
    const legacyId = rows[0].id;
    for (const path of [`/api/residents/${legacyId}/record`, `/api/residents/${legacyId}/compliance`, `/api/residents/${legacyId}/export?reason=test`, `/api/residents/${legacyId}/household`]) {
      const res = await hAdmin.fetch(path);
      // A refusal of any shape is fine (404 from the route, 400 from the tenant's
      // own function raising "Resident not found"); a 200 with data is not.
      assert.ok(res.status >= 400 || (res.status === 200 && Array.isArray(res.json) && res.json.length === 0), `${path} answered ${res.status}: ${res.text.slice(0, 80)}`);
    }
    const patch = await hAdmin.fetch(`/api/residents/${legacyId}`, { method: "PATCH", body: { first_name: "Hijacked" } });
    assert.ok([403, 404].includes(patch.status), `PATCH answered ${patch.status}`);
    const erase = await hAdmin.fetch(`/api/residents/${legacyId}`, { method: "DELETE", body: { reason: "test", confirm_name: "x" } });
    assert.ok(erase.status >= 400, `DELETE answered ${erase.status}`);
    const still = await withOwner((c) => c.query(`select first_name from public.residents where id = $1`, [legacyId]));
    assert.equal(still.rowCount, 1);
    assert.notEqual(still.rows[0].first_name, "Hijacked");
    const checkin = await hGuard.fetch("/api/checkins", { method: "POST", body: { resident_id: legacyId } });
    assert.ok(checkin.status >= 400, "a harbour guard recorded a check-in for a legacy resident");
  });

  await test("events recorded in a centre stay in that centre, online and via sync", async () => {
    const before = (await withOwner((c) => c.query(`select count(*)::int as n from public.checkin_events`))).rows[0].n;
    const live = await hGuard.fetch("/api/checkins", { method: "POST", body: { resident_id: harbourResident } });
    assert.equal(live.status, 200, live.text);
    const synced = await hGuard.fetch("/api/sync", { method: "POST", body: { events: [
      { ref: ref(), kind: "gate", direction: "in", resident_id: harbourResident, occurred_at: agoIso(120) },
    ] } });
    assert.equal(synced.json.results[0].status, "ok", synced.text);
    const after = (await withOwner((c) => c.query(`select count(*)::int as n from public.checkin_events`))).rows[0].n;
    assert.equal(after, before, "a harbour check-in reached the legacy schema");
    const theirs = await withOwner((c) => c.query(
      `select (select count(*)::int from t_harbour.checkin_events) as checkins,
              (select count(*)::int from t_harbour.gate_events) as gates`));
    assert.deepEqual(theirs.rows[0], { checkins: 1, gates: 1 });
  });

  await test("an invited staff member joins the inviter's centre", async () => {
    const res = await hAdmin.fetch("/api/staff", { method: "POST", body: { email: "hsup@harbour.example", full_name: "Harbour Super", role: "supervisor" } });
    assert.equal(res.status, 201, res.text);
    const { rows } = await withOwner((c) => c.query(
      `select u.tenant_id = $2 as right_tenant,
              exists (select 1 from t_harbour.profiles p where p.id = u.id) as in_tenant,
              exists (select 1 from public.profiles p where p.id = u.id) as in_public
         from auth.users u where u.id = $1`, [res.json.id, harbourId]));
    assert.deepEqual(rows[0], { right_tenant: true, in_tenant: true, in_public: false });
  });

  await test("settings, buildings and reports are per centre", async () => {
    const set = await hAdmin.fetch("/api/settings", { method: "PATCH", body: { feature_buildings: true, site_name: "Harbour House" } });
    assert.equal(set.status, 200, set.text);
    const legacy = await withOwner((c) => c.query(`select feature_buildings from public.app_settings`));
    assert.equal(legacy.rows[0].feature_buildings, false, "a harbour setting changed the legacy site");
    const b = await hAdmin.fetch("/api/buildings", { method: "POST", body: { name: "Pier" } });
    assert.equal(b.status, 201, b.text);
    const legacyB = await api.fetch("/api/buildings");
    assert.ok(!legacyB.json.some((x) => x.name === "Pier"), "a harbour building is visible to the legacy site");
    const rep = await hAdmin.fetch("/api/reports/attendance?from=2026-01-01&to=2026-12-31&reason=test&format=json");
    assert.equal(rep.status, 200, rep.text);
    assert.deepEqual(rep.json.rows.map((r) => r.resident), ["Hana Harbourside"]);
  });

  await test("only a platform admin can list, create and close centres", async () => {
    assert.equal((await api.fetch("/api/tenants")).status, 403);
    assert.equal((await hAdmin.fetch("/api/tenants")).status, 403);
    await withOwner((c) => c.query(`update auth.users set platform_admin = true where id = $1`, [guardId]));
    // A new login picks up the flag on the next request.
    const list = await api.fetch("/api/tenants");
    assert.equal(list.status, 200, list.text);
    const harbour = list.json.find((t) => t.slug === "harbour");
    assert.equal(harbour.residents, 1);
    assert.equal(harbour.staff, 3);
    assert.equal(list.json.find((t) => t.slug === "default").schema, "public");

    const bad = await api.fetch("/api/tenants", { method: "POST", body: { name: "X", slug: "public", admin_name: "A", admin_email: "a@b.c" } });
    assert.equal(bad.status, 400);
    const made = await api.fetch("/api/tenants", { method: "POST", body: { name: "Seaview", slug: "seaview", admin_name: "Sea Admin", admin_email: "seaadmin@seaview.example" } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.schema, "t_seaview");
    assert.equal(made.json.admin.delivered, false);
    assert.match(made.json.admin.link, /\?reset=/);
    const seaProfile = await withOwner((c) => c.query(`select role from t_seaview.profiles where id = $1`, [made.json.admin.id]));
    assert.equal(seaProfile.rows[0]?.role, "admin");

    const wrong = await api.fetch(`/api/tenants/${made.json.id}`, { method: "DELETE", body: { confirm_slug: "nope" } });
    assert.equal(wrong.status, 400);
    const closed = await api.fetch(`/api/tenants/${made.json.id}`, { method: "DELETE", body: { confirm_slug: "seaview" } });
    assert.equal(closed.status, 200, closed.text);
    const gone = await withOwner((c) => c.query(`select 1 from pg_namespace where nspname = 't_seaview'`));
    assert.equal(gone.rowCount, 0, "the closed centre's schema still exists");
    const status = await withOwner((c) => c.query(`select status from public.tenants where id = $1`, [made.json.id]));
    assert.equal(status.rows[0].status, "closed");
    const fresh = client(base);
    const loginAfter = await fresh.fetch("/api/session", { method: "POST", body: { email: "seaadmin@seaview.example", password: PASSWORD } });
    assert.equal(loginAfter.status, 401, "a closed centre's login still works");
    await withOwner((c) => c.query(`update auth.users set platform_admin = false where id = $1`, [guardId]));
  });

  await test("a suspended centre is refused at the door", async () => {
    await withOwner((c) => c.query(`update public.tenants set status = 'suspended' where id = $1`, [harbourId]));
    const res = await hGuard.fetch("/api/residents?q=&limit=10");
    assert.equal(res.status, 403, res.text);
    await withOwner((c) => c.query(`update public.tenants set status = 'active' where id = $1`, [harbourId]));
    assert.equal((await hGuard.fetch("/api/residents?q=&limit=10")).status, 200);
  });

  console.log("\n== IPAS alignment ==");

  // The revocation block above changed the password, which ends every session
  // for the account — including this client's. Everything below needs one.
  await api.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });

  await test("the register keeps sign-in records for 180 days, not seven years", async () => {
    const { rows } = await withOwner((c) =>
      c.query("select compliance_retention_days as d from public.app_settings"));
    assert.ok(rows[0].d <= 180,
      `register retention is ${rows[0].d} days; the verification policy allows 6 months`);
  });

  await test("a supervisor can record a TRC, and it becomes searchable", async () => {
    const found = await api.fetch("/api/residents?q=brennan");
    const id = found.json[0].id;

    // The fixture account is a guard, so lift it for this test only.
    await withOwner((c) => c.query(`update public.profiles set role='supervisor' where id=$1`, [guardId]));

    const res = await api.fetch(`/api/residents/${id}`, {
      method: "PATCH", body: { id_type: "trc", id_number: "TRC9998887" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.id_type, "TRC", "the type was not normalised to upper case");

    const byNumber = await api.fetch("/api/residents?q=TRC9998887");
    assert.equal(byNumber.json.length, 1, "the ID number is not searchable");
    assert.equal(byNumber.json[0].id, id);

    await withOwner((c) => c.query(`update public.profiles set role='guard' where id=$1`, [guardId]));
  });

  await test("a guard cannot record an ID", async () => {
    const found = await api.fetch("/api/residents?q=brennan");
    const res = await api.fetch(`/api/residents/${found.json[0].id}`, {
      method: "PATCH", body: { id_type: "TRC", id_number: "TRC0000000" },
    });
    assert.equal(res.status, 403, "a guard was able to write to the resident record");
  });

  await test("an unknown ID type is refused", async () => {
    const found = await api.fetch("/api/residents?q=brennan");
    const res = await api.fetch(`/api/residents/${found.json[0].id}`, {
      method: "PATCH", body: { id_type: "PASSPORT", id_number: "X1234567" },
    });
    assert.equal(res.status, 400);
  });

  // The two House Rules numbers must be reported as counts. The view must not
  // decide anything: reaching a threshold is the centre manager's call.
  await test("the rolling window counts only completed days, and reports both thresholds", async () => {
    const found = await api.fetch("/api/residents?q=brennan&compliance=1");
    const id = found.json[0].id;

    await withOwner(async (c) => {
      await c.query(`delete from public.daily_compliance where resident_id = $1`, [id]);
      // Three consecutive missed nights, all closed, inside the window.
      await c.query(
        `insert into public.daily_compliance
           (resident_id, compliance_date, required, presented, checkin_count, closed_at)
         select $1, public.site_today() - g, true, false, 0, now() from generate_series(1,3) g`, [id]);
      // A missed day that is still open (today) must not be counted yet.
      await c.query(
        `insert into public.daily_compliance
           (resident_id, compliance_date, required, presented, checkin_count, closed_at)
         values ($1, public.site_today(), true, false, 0, null)
         on conflict (resident_id, compliance_date) do nothing`, [id]);
    });

    const row = await api.fetch(`/api/residents/${id}/compliance`);
    assert.equal(row.json.absent_in_window, 3, "the open day was counted, or a closed one was missed");
    assert.equal(row.json.consecutive_missed, 3);
    assert.equal(row.json.warn_after_consecutive_nights, 3);
    assert.equal(row.json.absence_window_limit, 10);
    assert.equal(row.json.absence_window_days, 28);
    assert.ok(!("policy_verdict" in row.json), "the view is deciding something it should only report");
  });

  console.log("\n== password reset ==");

  // The whole point of this endpoint is that it answers before it knows
  // anything about you. If a stranger can tell a real staff address from a
  // made-up one, the reset flow has become a staff directory.
  await test("requesting a reset never reveals whether the address exists", async () => {
    const real = await api.fetch("/api/password-reset", { method: "POST", body: { email: EMAIL } });
    const fake = await api.fetch("/api/password-reset", {
      method: "POST", body: { email: "nobody-at-all@example.invalid" },
    });
    assert.equal(real.status, 200);
    assert.equal(fake.status, 200);
    assert.deepEqual(real.json, fake.json, "the two answers differ, which enumerates staff");
  });

  await test("an unknown token is refused", async () => {
    const res = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token: "not-a-real-token", password: "abcdefghijkl1" },
    });
    assert.equal(res.status, 400);
  });

  await test("a short password is refused before the token is spent", async () => {
    const token = await issueReset(EMAIL);
    const short = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token, password: "tooshort" },
    });
    assert.equal(short.status, 400);

    // The link must survive a rejected password, or one typo burns it.
    const good = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token, password: PASSWORD },
    });
    assert.equal(good.status, 200, "the link was consumed by a failed attempt");
  });

  await test("a reset link works once, ends every session, and is then dead", async () => {
    // A browser that is logged in with the old password.
    const held = client(base);
    await held.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    assert.equal((await held.fetch("/api/summary")).status, 200);

    const token = await issueReset(EMAIL);
    const NEWPW = "reset-me-please-1";

    const first = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token, password: NEWPW },
    });
    assert.equal(first.status, 200);

    // Revocation: the reset logs out whoever was already in.
    assert.equal((await held.fetch("/api/summary")).status, 401);

    // The new password works, and no session was handed out by the reset
    // itself — a stolen link must be a password change, not a login.
    const after = client(base);
    const login = await after.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: NEWPW } });
    assert.equal(login.status, 200);

    // Single use.
    const replay = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token, password: "another-password-1" },
    });
    assert.equal(replay.status, 400, "the link was replayable");

    // Put the shared fixture password back for the tests that follow.
    await withOwner((c) => c.query(`select auth.set_password($1, $2)`, [EMAIL, PASSWORD]));
  });

  await test("an expired link is refused", async () => {
    const token = await issueReset(EMAIL);
    await withOwner((c) => c.query(
      `update auth.password_resets set expires_at = now() - interval '1 minute' where used_at is null`));

    const res = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token, password: "expired-link-pw-1" },
    });
    assert.equal(res.status, 400);
  });

  await test("a deactivated account cannot be reset into", async () => {
    const token = await issueReset(EMAIL);
    await withOwner((c) => c.query(`update public.profiles set active = false where id = $1`, [guardId]));

    const res = await api.fetch("/api/password-reset/confirm", {
      method: "POST", body: { token, password: "disabled-user-pw-1" },
    });
    assert.equal(res.status, 400, "a disabled account was resettable");

    await withOwner((c) => c.query(`update public.profiles set active = true where id = $1`, [guardId]));
  });

  await test("logging out invalidates the cookie server-side", async () => {
    const fresh = client(base);
    await fresh.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    const held = fresh.cookie;

    await fresh.fetch("/api/session", { method: "DELETE" });

    // Replay the cookie the browser was told to drop: the session must be gone
    // from the database, not merely cleared from the browser.
    fresh.cookie = held;
    assert.equal((await fresh.fetch("/api/summary")).status, 401);
  });

  console.log("\n== resident management ==");

  // The admin page's Residents tab. Authorisation is the residents_supervisor
  // row policy; what this proves is that the routes neither add a way around
  // it nor lose its refusals, and that departure does what the register
  // needs it to do.
  // The revocation tests above ended every session the guard held; log the
  // guard client back in so the "guard cannot" probes are a guard, not anon.
  assert.equal((await api.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } })).status, 200);

  const supC = client(base);
  await withOwner((c) => c.query(`select auth.create_user($1, $2, $3, $4)`, [
    "sup2@hut.example", PASSWORD, "Sam Supervisor", "supervisor",
  ]));
  assert.equal((await supC.fetch("/api/session", { method: "POST", body: { email: "sup2@hut.example", password: PASSWORD } })).status, 200);
  let newId;

  await test("a supervisor adds a resident, and the guard then finds them", async () => {
    const res = await supC.fetch("/api/residents", {
      method: "POST",
      body: { first_name: "Testy", last_name: "Newcomer", date_of_birth: "1990-06-15", id_type: "trc", id_number: "trc9999" },
    });
    assert.equal(res.status, 201, res.text);
    newId = res.json.id;
    const found = await api.fetch("/api/residents?q=newcomer");
    assert.ok(found.json.some((r) => r.id === newId), "the guard cannot find the new resident");
    assert.equal(found.json.find((r) => r.id === newId).has_id, true);
    const rec = await supC.fetch(`/api/residents/${newId}/record`);
    assert.equal(rec.json.id_number, "TRC9999", "the ID was not upper-cased");
    // and the number is searchable even though lists never show it
    const byNumber = await api.fetch("/api/residents?q=trc9999");
    assert.ok(byNumber.json.some((r) => r.id === newId), "search by ID number stopped working");
  });

  await test("a guard cannot add, read for edit, or change a resident", async () => {
    const add = await api.fetch("/api/residents", { method: "POST", body: { first_name: "Nope", last_name: "Never", date_of_birth: "1990-01-01" } });
    assert.equal(add.status, 403, `guard add answered ${add.status}`);
    const rec = await api.fetch(`/api/residents/${newId}/record`);
    assert.equal(rec.status, 404, "a guard could read a date of birth through /record");
    const edit = await api.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { last_name: "Hacked" } });
    assert.equal(edit.status, 403, `guard edit answered ${edit.status}`);
  });

  await test("bad input is a message, not a constraint name", async () => {
    for (const [body, re] of [
      [{ first_name: "", last_name: "X", date_of_birth: "1990-01-01" }, /First name/],
      [{ first_name: "A", last_name: "B", date_of_birth: "2999-01-01" }, /future/],
      [{ first_name: "A", last_name: "B", date_of_birth: "1990-02-30" }, /real date/],
      [{ first_name: "A", last_name: "B", date_of_birth: "1990-01-01", id_type: "XYZ", id_number: "1" }, /TRC or IRP/],
    ]) {
      const res = await supC.fetch("/api/residents", { method: "POST", body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, re);
    }
  });

  await test("the edit record carries the date of birth for a supervisor, and edits stick", async () => {
    const rec = await supC.fetch(`/api/residents/${newId}/record`);
    assert.equal(rec.status, 200);
    assert.equal(rec.json.date_of_birth, "1990-06-15");
    const edit = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { last_name: "Newcomer-Smith", date_of_birth: "1991-06-15", id_type: null, id_number: null } });
    assert.equal(edit.status, 200, edit.text);
    const after = await supC.fetch(`/api/residents/${newId}/record`);
    assert.equal(after.json.last_name, "Newcomer-Smith");
    assert.equal(after.json.date_of_birth, "1991-06-15");
    assert.equal(after.json.id_number, null, "clearing the ID did not clear it");
  });

  await test("departing a resident stops the gate; reactivating restores it", async () => {
    const dep = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { status: "departed" } });
    assert.equal(dep.status, 200, dep.text);
    assert.equal(dep.json.status, "departed");
    assert.match(String(dep.json.departed_on), /^\d{4}-\d{2}-\d{2}$/, "departed_on should default to the site's today");

    const gate = await api.fetch("/api/gate-events", { method: "POST", body: { resident_id: newId, direction: "in" } });
    assert.equal(gate.status, 400);
    assert.match(gate.json.error, /not active/);

    const active = await api.fetch("/api/residents?q=newcomer");
    assert.ok(!active.json.some((r) => r.id === newId), "a departed resident still shows in the working list");
    const all = await supC.fetch("/api/residents?q=newcomer&departed=1");
    assert.ok(all.json.some((r) => r.id === newId), "the Departed view does not show them");

    const back = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { status: "active" } });
    assert.equal(back.status, 200);
    assert.equal(back.json.departed_on, null);
    const gate2 = await api.fetch("/api/gate-events", { method: "POST", body: { resident_id: newId, direction: "in" } });
    assert.equal(gate2.status, 200, "reactivated resident cannot be signed in");
  });

  console.log("\n== buildings and rooms ==");

  let castleId, roomId;
  await test("a guard cannot add a building; a supervisor can", async () => {
    const asGuard = await api.fetch("/api/buildings", { method: "POST", body: { name: "Castle" } });
    assert.equal(asGuard.status, 403);
    const res = await supC.fetch("/api/buildings", { method: "POST", body: { name: "Castle" } });
    assert.equal(res.status, 201, res.text);
    castleId = res.json.id;
    const dup = await supC.fetch("/api/buildings", { method: "POST", body: { name: "Castle" } });
    assert.equal(dup.status, 409, "a duplicate building name must be refused");
  });

  await test("rooms are added in a batch, with a capacity", async () => {
    const res = await supC.fetch(`/api/buildings/${castleId}/rooms`, {
      method: "POST",
      body: { rooms: [{ floor: "1F", number: "12", capacity: 2 }, { floor: "1F", number: "13" }, { floor: "", number: "G1", capacity: 3 }] },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.length, 3);
    roomId = res.json.find((r) => r.number === "12").id;
    const bad = await supC.fetch(`/api/buildings/${castleId}/rooms`, { method: "POST", body: { rooms: [{ number: "X", capacity: 99 }] } });
    assert.equal(bad.status, 400, "capacity outside 1..30 must be refused");
  });

  await test("a resident is moved into a room and every card says so", async () => {
    const move = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { room_id: roomId } });
    assert.equal(move.status, 200, move.text);
    assert.equal(move.json.room_id, roomId);
    const list = await api.fetch("/api/residents?q=Newcomer&limit=10");
    const row = list.json.find((r) => r.id === newId);
    assert.equal(row.room_label, "Castle · 1F · 12");
    assert.equal(row.building, "Castle");
    const nowhere = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { room_id: "00000000-0000-4000-8000-000000000000" } });
    assert.equal(nowhere.status, 400, "a room that does not exist is a 400");
    const record = await supC.fetch(`/api/residents/${newId}/record`);
    assert.equal(record.json.room_id, roomId, "the edit sheet gets the room");
  });

  await test("occupancy lists the room, its occupants and who is on site", async () => {
    const res = await api.fetch("/api/buildings");
    assert.equal(res.status, 200);
    const castle = res.json.find((b) => b.id === castleId);
    const room = castle.rooms.find((r) => r.id === roomId);
    assert.equal(room.occupants, 1);
    assert.equal(room.residents[0].id, newId);
    assert.ok(["in", "out"].includes(room.residents[0].presence));
    const guardWrite = await api.fetch(`/api/rooms/${roomId}`, { method: "PATCH", body: { capacity: 4 } });
    assert.equal(guardWrite.status, 403);
  });

  await test("an occupied room or building cannot be removed; an empty one can", async () => {
    assert.equal((await supC.fetch(`/api/rooms/${roomId}`, { method: "DELETE" })).status, 409);
    assert.equal((await supC.fetch(`/api/buildings/${castleId}`, { method: "DELETE" })).status, 409);
    const clear = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { room_id: null } });
    assert.equal(clear.status, 200);
    assert.equal(clear.json.room_id, null);
    assert.equal((await supC.fetch(`/api/rooms/${roomId}`, { method: "DELETE" })).status, 200);
    const after = await api.fetch("/api/buildings");
    assert.equal(after.json.find((b) => b.id === castleId).rooms.length, 2);
  });

  console.log("\n== evacuation and roll call ==");

  await test("the feature switches default off and reach the terminal", async () => {
    const res = await api.fetch("/api/session");
    assert.equal(res.json.settings.feature_buildings, false);
    assert.equal(res.json.settings.feature_evacuation, false);
    const asGuard = await api.fetch("/api/settings", { method: "PATCH", body: { feature_evacuation: true } });
    assert.equal(asGuard.status, 403);
  });

  await test("an evacuation need is one code from the list, set by a supervisor", async () => {
    const bad = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { evac_need: "diabetic" } });
    assert.equal(bad.status, 400, "free text must be refused");
    const ok = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { evac_need: "mobility" } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.evac_need, "mobility");
    const asGuard = await api.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { evac_need: "none" } });
    assert.equal(asGuard.status, 403);
    const list = await api.fetch("/api/evacuation");
    assert.equal(list.status, 200);
    const row = list.json.find((r) => r.id === newId);
    assert.equal(row.evac_need, "mobility");
    assert.ok(["in", "out"].includes(row.presence));
  });

  let rcId;
  await test("a guard runs a roll call: start, mark twice, end", async () => {
    rcId = "dddddddd-1111-4000-8000-000000000001";
    const start = await api.fetch("/api/roll-calls", { method: "POST", body: { id: rcId, kind: "drill" } });
    assert.equal(start.status, 201, start.text);
    assert.equal(start.json.kind, "drill");
    const active = await api.fetch("/api/roll-calls/active");
    assert.equal(active.json.id, rcId);
    const m1 = await api.fetch(`/api/roll-calls/${rcId}/marks`, { method: "POST", body: { resident_id: newId, ref: ref() } });
    assert.equal(m1.status, 200, m1.text);
    const m2 = await api.fetch(`/api/roll-calls/${rcId}/marks`, { method: "POST", body: { resident_id: newId, ref: ref() } });
    assert.equal(m2.status, 200, "a second mark is a no-op, not an error");
    const again = await api.fetch("/api/roll-calls/active");
    assert.equal(again.json.marks.length, 1);
    const end = await api.fetch(`/api/roll-calls/${rcId}/end`, { method: "POST", body: {} });
    assert.equal(end.status, 200);
    assert.ok(end.json.ended_at);
    assert.equal((await api.fetch("/api/roll-calls/active")).json, null);
    const record = await api.fetch("/api/roll-calls");
    assert.equal(record.json.find((r) => r.id === rcId).accounted, 1);
  });

  await test("a roll call recorded offline syncs in order: start, marks, end", async () => {
    const id = "dddddddd-1111-4000-8000-000000000002";
    const t0 = agoIso(600);
    const res = await api.fetch("/api/sync", { method: "POST", body: { events: [
      { ref: ref(), kind: "rollcall_start", roll_call_id: id, rc_kind: "incident", occurred_at: t0 },
      { ref: ref(), kind: "rollcall_mark", roll_call_id: id, resident_id: newId, occurred_at: agoIso(500) },
      { ref: ref(), kind: "rollcall_end", roll_call_id: id, occurred_at: agoIso(400) },
      { ref: ref(), kind: "rollcall_mark", roll_call_id: "dddddddd-1111-4000-8000-0000000000ff", resident_id: newId, occurred_at: agoIso(300) },
    ] } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.results.map((r) => r.status), ["ok", "ok", "ok", "rejected"]);
    assert.match(res.json.results[3].error, /No such roll call/);
    const record = await api.fetch("/api/roll-calls");
    const rc = record.json.find((r) => r.id === id);
    assert.equal(rc.kind, "incident");
    assert.equal(rc.accounted, 1);
    assert.ok(rc.ended_at);
  });

  console.log("\n== households ==");

  let kidId;
  await test("a supervisor links a child to a parent; the family shows on the list", async () => {
    const kid = await supC.fetch("/api/residents", { method: "POST", body: { first_name: "Tiny", last_name: "Newcomer", date_of_birth: "2020-01-01" } });
    assert.equal(kid.status, 201, kid.text);
    kidId = kid.json.id;
    const asGuard = await api.fetch(`/api/residents/${kidId}`, { method: "PATCH", body: { household_with: newId } });
    assert.equal(asGuard.status, 403);
    const join = await supC.fetch(`/api/residents/${kidId}`, { method: "PATCH", body: { household_with: newId } });
    assert.equal(join.status, 200, join.text);
    assert.ok(join.json.household_id, "no household id came back");
    const members = await supC.fetch(`/api/residents/${newId}/household`);
    assert.equal(members.json.length, 2);
    assert.equal(members.json[0].is_adult, true, "adults first");
    const list = await api.fetch("/api/evacuation");
    const row = list.json.find((r) => r.id === kidId);
    assert.match(row.household_label, /Newcomer.* family \(2\)/);   // the parent was renamed Newcomer-Smith earlier
    assert.equal(row.is_adult, false);
    const self = await supC.fetch(`/api/residents/${kidId}`, { method: "PATCH", body: { household_with: kidId } });
    assert.equal(self.status, 400);
  });

  await test("leaving the family prunes it once empty", async () => {
    const leave = await supC.fetch(`/api/residents/${kidId}`, { method: "PATCH", body: { household_id: null } });
    assert.equal(leave.status, 200, leave.text);
    assert.equal(leave.json.household_id, null);
    const left = await supC.fetch(`/api/residents/${newId}/household`);
    assert.equal(left.json.length, 1, "the parent is still in a household of one until they leave too");
    await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { household_id: null } });
    const { rows } = await withOwner((c) => c.query(`select count(*)::int as n from public.households`));
    assert.equal(rows[0].n, 0, "an empty household was not pruned");
    const bad = await supC.fetch(`/api/residents/${newId}`, { method: "PATCH", body: { household_id: "00000000-0000-4000-8000-000000000000" } });
    assert.equal(bad.status, 400, "household_id can only be cleared through this route");
  });

  console.log("\n== reports ==");

  await test("a report needs a reason and a supervisor; a guard is refused", async () => {
    const today = siteToday();
    const noReason = await supC.fetch(`/api/reports/register?from=${today}&to=${today}`);
    assert.equal(noReason.status, 400);
    const asGuard = await api.fetch(`/api/reports/register?from=${today}&to=${today}&reason=test`);
    assert.equal(asGuard.status, 403);
    const unknown = await supC.fetch(`/api/reports/secrets?reason=test`);
    assert.equal(unknown.status, 404);
    const tooLong = await supC.fetch(`/api/reports/register?from=2020-01-01&to=2022-01-01&reason=test`);
    assert.equal(tooLong.status, 400);
    const list = await api.fetch("/api/reports");
    assert.equal(list.json.length, 6);
  });

  await test("the register and attendance reports come as CSV and JSON, and the export is logged", async () => {
    const today = siteToday();
    const from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const csv = await supC.fetch(`/api/reports/register?from=${from}&to=${today}&reason=HIQA+inspection`);
    assert.equal(csv.status, 200, csv.text);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.headers.get("content-disposition"), /register-.*\.csv/);
    assert.match(csv.text, /^\ufeff?date,resident,age,required,presented,first_seen,check_ins,closed\r\n/);   // fetch strips the BOM
    const att = await supC.fetch(`/api/reports/attendance?from=${from}&to=${today}&reason=HIQA+inspection&format=json`);
    assert.equal(att.status, 200, att.text);
    assert.equal(att.json.title, "Attendance summary");
    const me = att.json.rows.find((r) => /Newcomer/.test(r.resident));
    assert.ok(me, "the supervisor's resident is missing from attendance");
    assert.ok("days_required" in me && "days_missed" in me);
    const occ = await supC.fetch(`/api/reports/occupancy?reason=inspection&format=json`);
    assert.equal(occ.status, 200);
    const evac = await supC.fetch(`/api/reports/evacuation?reason=inspection&format=json`);
    assert.ok(evac.json.rows.some((r) => /Newcomer/.test(r.resident)));
    const drills = await supC.fetch(`/api/reports/roll-calls?from=${from}&to=${today}&reason=inspection&format=json`);
    assert.ok(drills.json.rows.length >= 1, "the drill recorded earlier is missing");
    const { rows } = await withOwner((c) => c.query(`select row_id, note from public.admin_audit where table_name = 'reports' order by at`));
    assert.ok(rows.length >= 5, "report exports were not logged");
    assert.match(rows[0].note, /HIQA inspection \[/);
  });

  console.log("\n== audit trail ==");

  await test("a supervisor's edit is on the record, with before and after", async () => {
    const supId = (await withOwner((c) => c.query(`select id from auth.users where email = 'sup2@hut.example'`))).rows[0].id;
    const { rows } = await withOwner((c) => c.query(
      `select actor_id, action, old_row->>'last_name' as before, new_row->>'last_name' as after
         from public.admin_audit where table_name = 'residents' and row_id = $1 order by at`, [newId]));
    assert.ok(rows.length >= 2, `expected an insert and updates, found ${rows.length}`);
    assert.equal(rows[0].action, "insert");
    assert.equal(rows[0].actor_id, supId, "the insert is not attributed to the supervisor");
    const rename = rows.find((r) => r.after === "Newcomer-Smith");
    assert.ok(rename, "the rename is not in the audit");
    assert.equal(rename.before, "Newcomer");
  });

  await test("a guard cannot read the audit; an admin can", async () => {
    const asGuard = await withIdentity(guardId, (c) => c.query(`select count(*)::int as n from public.admin_audit`));
    assert.equal(asGuard.rows[0].n, 0);
    const adminId = (await withOwner((c) => c.query(`select id from auth.users where email = 'head@hut.example'`))).rows[0]?.id;
    if (adminId) {
      const asAdmin = await withIdentity(adminId, (c) => c.query(`select count(*)::int as n from public.admin_audit`));
      assert.ok(asAdmin.rows[0].n > 0);
    }
  });

  await test("a staff member can no longer rename themselves", async () => {
    const { rows } = await withIdentity(guardId, (c) => c.query(
      `update public.profiles set full_name = 'Somebody Else' where id = auth.uid() returning id`));
    assert.equal(rows.length, 0, "the self-rename policy is still in place");
  });

  await test("every login attempt is on the record, with its outcome", async () => {
    const probe = client(base);
    await probe.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: "wrong-wrong-wrong" } });
    await probe.fetch("/api/session", { method: "POST", body: { email: "ghost@hut.example", password: "wrong-wrong-wrong" } });
    await probe.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    const { rows } = await withOwner((c) => c.query(
      `select outcome, email from auth.login_events order by id desc limit 3`));
    assert.deepEqual(rows.map((r) => r.outcome).reverse(), ["bad_password", "unknown_email", "ok"]);
    assert.ok(rows.every((r) => r.email), "email not recorded");
    const fromGuard = await withIdentity(guardId, (c) => c.query(`select count(*) from auth.login_events`).then(() => "readable", (e) => e.code));
    assert.equal(fromGuard, "42501", "a request role can read login events");
  });

  await test("the reset endpoint is throttled per IP", async () => {
    const probe = client(base);
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await probe.fetch("/api/password-reset", { method: "POST", body: { email: `nobody${i}@hut.example` } });
    }
    assert.equal(last.status, 429, "the ninth reset request in five minutes was not refused");
  });

  await test("the health view says whether close-out is behind", async () => {
    const res = await api.fetch("/api/session/health");
    assert.equal(res.status, 200, res.text);
    assert.equal(typeof res.json.close_out_behind, "boolean");
    assert.ok(res.json.site_today, "site_today missing");
    await withOwner((c) => c.query(`insert into public.job_runs (job, ok, result) values ('close-out-compliance-days', true, '0')`));
    const after = await api.fetch("/api/session/health");
    assert.ok(after.json.last_close_out_run, "a recorded run is not reported");
  });

  await test("an applied migration edited on disk is shouted about at boot", async () => {
    await withOwner((c) => c.query(`update public.schema_migrations set checksum = 'not-the-real-one' where name = '001_platform.sql'`));
    const lines = [];
    await migrate({ log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /WARNING: 001_platform.sql has changed/.test(l)), "no drift warning");
    // put it back so later boots in this cluster are quiet
    const real = require("crypto").createHash("sha256").update(require("fs").readFileSync(require("path").join(__dirname, "..", "migrations", "001_platform.sql"), "utf8"), "utf8").digest("hex");
    await withOwner((c) => c.query(`update public.schema_migrations set checksum = $1 where name = '001_platform.sql'`, [real]));
  });

  console.log("\n== codes by email at login (migration 021) ==");

  const mfaAdmin = client(base), mfaSup = client(base);
  const lastCode = () => {
    const m = (global.__mailSink || []).slice().reverse().find((x) => /login code/.test(x.subject));
    return m && (m.text.match(/\b(\d{6})\b/) || [])[1];
  };
  await test("the switch is off by default and a guard's login is one step", async () => {
    await withOwner((c) => c.query(`select auth.create_user($1, $2, $3, $4)`, ["mfaadmin@hut.example", PASSWORD, "Mfa Admin", "admin"]));
    await withOwner((c) => c.query(`select auth.create_user($1, $2, $3, $4)`, ["mfasup@hut.example", PASSWORD, "Mfa Super", "supervisor"]));
    const login = await mfaAdmin.fetch("/api/session", { method: "POST", body: { email: "mfaadmin@hut.example", password: PASSWORD } });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.ok, true, "with the switch off, an admin login must be one step");
    const on = await mfaAdmin.fetch("/api/settings", { method: "PATCH", body: { mfa_email: true } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.mfa_email, true);
    const guard = client(base);
    const g = await guard.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    assert.equal(g.json.ok, true, "a guard must not be asked for a code");
  });

  let challenge;
  await test("a supervisor's password opens no session until the emailed code is typed", async () => {
    const first = await mfaSup.fetch("/api/session", { method: "POST", body: { email: "mfasup@hut.example", password: PASSWORD } });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.mfa_required, true);
    assert.match(first.json.email_hint, /^m•••@hut\.example$/);
    challenge = first.json.challenge;
    assert.equal((await mfaSup.fetch("/api/session")).status, 401, "a session existed before the code");
    const code = lastCode();
    assert.match(code || "", /^\d{6}$/, "no code was emailed");
    const wrong = await mfaSup.fetch("/api/session/mfa", { method: "POST", body: { challenge, code: code === "000000" ? "111111" : "000000" } });
    assert.equal(wrong.status, 401);
    const right = await mfaSup.fetch("/api/session/mfa", { method: "POST", body: { challenge, code, trust_device: true } });
    assert.equal(right.status, 200, right.text);
    assert.equal((await mfaSup.fetch("/api/session")).status, 200, "the code did not open a session");
    const again = await mfaSup.fetch("/api/session/mfa", { method: "POST", body: { challenge, code } });
    assert.equal(again.status, 401, "a used challenge must not open a second session");
    const { rows } = await withOwner((c) => c.query(`select outcome from auth.login_events where email = 'mfasup@hut.example' order by at`));
    assert.deepEqual(rows.map((r) => r.outcome).slice(-3), ["mfa_sent", "mfa_failed", "ok"]);
  });

  await test("a trusted device skips the code for thirty days; a new password forgets it", async () => {
    await mfaSup.fetch("/api/session", { method: "DELETE" });
    const back = await mfaSup.fetch("/api/session", { method: "POST", body: { email: "mfasup@hut.example", password: PASSWORD } });
    assert.equal(back.json.ok, true, "the trusted device was asked for a code again");
    await withOwner((c) => c.query(`select auth.set_password($1, $2)`, ["mfasup@hut.example", PASSWORD]));
    // set_password ends sessions; the device survives it (the API forgets
    // devices only on a reset link, which proves the mailbox). Simulate that.
    await withOwner((c) => c.query(`delete from auth.mfa_devices d using auth.users u where u.id = d.user_id and u.email = 'mfasup@hut.example'`));
    const asked = await mfaSup.fetch("/api/session", { method: "POST", body: { email: "mfasup@hut.example", password: PASSWORD } });
    assert.equal(asked.json.mfa_required, true, "with no trusted device the code must be asked for again");
  });

  await test("five wrong codes end the challenge, and the switch cannot be turned on without mail", async () => {
    const fresh = client(base);
    const first = await fresh.fetch("/api/session", { method: "POST", body: { email: "mfasup@hut.example", password: PASSWORD } });
    const code = lastCode();
    for (let i = 0; i < 5; i++) {
      const bad = await fresh.fetch("/api/session/mfa", { method: "POST", body: { challenge: first.json.challenge, code: code === "999999" ? "111111" : "999999" } });
      assert.equal(bad.status, 401);
    }
    const late = await fresh.fetch("/api/session/mfa", { method: "POST", body: { challenge: first.json.challenge, code } });
    assert.equal(late.status, 401, "the right code opened a challenge that had five wrong guesses");

    delete process.env.HUT_MAIL_SINK;
    const refused = await mfaAdmin.fetch("/api/settings", { method: "PATCH", body: { mfa_email: true } });
    assert.equal(refused.status, 400, "the switch was accepted with no mail service");
    process.env.HUT_MAIL_SINK = "1";
    const off = await mfaAdmin.fetch("/api/settings", { method: "PATCH", body: { mfa_email: false } });
    assert.equal(off.status, 200, off.text);
  });

  console.log("\n== where a login comes from (migration 022) ==");

  const from = (cc) => ({ "x-hut-test-country": cc });
  await test("a guard from home on a new device logs in; the country is on the record", async () => {
    const g = client(base);
    const res = await g.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD }, headers: from("IE") });
    assert.equal(res.json.ok, true, res.text);
    assert.match(g.cookie, /hut_device=/, "the device was not remembered");
    const { rows } = await withOwner((c) => c.query(`select country, risk from auth.login_events where email = $1 order by at desc limit 1`, [EMAIL]));
    assert.equal(rows[0].country, "IE");
    assert.equal(rows[0].risk, "new_device");
    await g.fetch("/api/session", { method: "DELETE" });
    const again = await g.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD }, headers: from("IE") });
    assert.equal(again.json.ok, true);
    const { rows: r2 } = await withOwner((c) => c.query(`select risk from auth.login_events where email = $1 order by at desc limit 1`, [EMAIL]));
    assert.equal(r2[0].risk, null, "a device seen before still counted as new");
  });

  await test("a supervisor abroad is refused, and told who to write to", async () => {
    const s = client(base);
    const res = await s.fetch("/api/session", { method: "POST", body: { email: "mfasup@hut.example", password: PASSWORD }, headers: from("FR") });
    assert.equal(res.status, 403, res.text);
    assert.match(res.json.error, /Ireland/);
    assert.match(res.json.error, /security@tenzing\.ie/);
    assert.equal((await s.fetch("/api/session")).status, 401);
    const { rows } = await withOwner((c) => c.query(`select outcome, country, risk from auth.login_events where email = 'mfasup@hut.example' order by at desc limit 1`));
    assert.equal(rows[0].outcome, "blocked_abroad");
    assert.equal(rows[0].country, "FR");
    assert.match(rows[0].risk, /abroad/);
  });

  await test("a guard abroad must type an emailed code; without mail they are refused with the contact", async () => {
    const g = client(base);
    const res = await g.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD }, headers: from("FR") });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.mfa_required, true, "a guard abroad was let in without a code");
    const code = lastCode();
    const done = await g.fetch("/api/session/mfa", { method: "POST", body: { challenge: res.json.challenge, code } });
    assert.equal(done.status, 200, done.text);
    delete process.env.HUT_MAIL_SINK;
    const h = client(base);
    const refused = await h.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD }, headers: from("FR") });
    assert.equal(refused.status, 403, refused.text);
    assert.match(refused.json.error, /security@tenzing\.ie/);
    process.env.HUT_MAIL_SINK = "1";
  });

  await test("a new device after three wrong passwords needs the code; an unknown address does not", async () => {
    const n = client(base);
    for (let i = 0; i < 3; i++) await n.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: "wrong-wrong-wrong" }, headers: from("IE") });
    const res = await n.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD }, headers: from("IE") });
    assert.equal(res.json.mfa_required, true, "new device plus recent failures should need a code");
    assert.deepEqual(res.json.risk, ["new_device", "recent_failures"]);
    const u = client(base);
    await withOwner((c) => c.query(`delete from auth.login_events where email = $1 and outcome = 'bad_password'`, [EMAIL]));
    const unknown = await u.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD }, headers: from("NONE") });
    assert.equal(unknown.json.ok, true, "an unknown address must not count as abroad");
  });

  await test("home countries are a site setting with a strict shape", async () => {
    const bad = await mfaAdmin.fetch("/api/settings", { method: "PATCH", body: { home_countries: "ireland" } });
    assert.equal(bad.status, 400);
    const ok = await mfaAdmin.fetch("/api/settings", { method: "PATCH", body: { home_countries: "ie, gb" } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.home_countries, "IE,GB");
    const s = client(base);
    const gb = await s.fetch("/api/session", { method: "POST", body: { email: "mfasup@hut.example", password: PASSWORD }, headers: from("GB") });
    assert.notEqual(gb.status, 403, "GB is home now and must not be refused");
    await mfaAdmin.fetch("/api/settings", { method: "PATCH", body: { home_countries: "IE" } });
  });

  console.log("\n== staff management ==");

  // The admin's Staff tab. Authorisation lives in the database — the create
  // and reset functions re-check is_admin(), and deactivation/role changes go
  // through the profiles_admin_all policy — so what this section proves is
  // that the API neither adds a way around that nor loses the refusals.
  const SUPER_EMAIL = "nadia@hut.example";
  const SUPER_PASSWORD = "another-long-password";
  const adminC = client(base);

  await test("an admin can create an account that can then log in", async () => {
    await withOwner((c) => c.query(`select auth.create_user($1, $2, $3, $4)`, [
      "head@hut.example", PASSWORD, "Head Manager", "admin",
    ]));
    const login = await adminC.fetch("/api/session", { method: "POST", body: { email: "head@hut.example", password: PASSWORD } });
    assert.equal(login.status, 200);

    const res = await adminC.fetch("/api/staff", {
      method: "POST",
      body: { email: SUPER_EMAIL, full_name: "Nadia Supervisor", role: "supervisor" },
    });
    assert.equal(res.status, 201, res.text);
    assert.ok(res.json.id);
    // Mail is not configured in the suite, so the link comes back to the admin.
    assert.equal(res.json.delivered, false);
    assert.match(res.json.link, /\?reset=/, "no link returned when mail is unconfigured");

    // No password exists yet: nothing logs in.
    const fresh = client(base);
    const early = await fresh.fetch("/api/session", { method: "POST", body: { email: SUPER_EMAIL, password: "anything-at-all-12" } });
    assert.equal(early.status, 401, "an invited account logged in before choosing a password");

    // The link is the forgot-password link: use it to choose one.
    const token = new URL(res.json.link).searchParams.get("reset");
    const chosen = await fresh.fetch("/api/password-reset/confirm", { method: "POST", body: { token, password: SUPER_PASSWORD } });
    assert.equal(chosen.status, 200, chosen.text);
    const newLogin = await fresh.fetch("/api/session", { method: "POST", body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
    assert.equal(newLogin.status, 200, "the invited account could not log in after choosing a password");
    const who = await fresh.fetch("/api/session");
    assert.equal(who.json.profile.role, "supervisor");
  });

  await test("an admin can send a login link; a guard cannot", async () => {
    const list = await adminC.fetch("/api/staff");
    const nadia = list.json.find((s) => s.email === SUPER_EMAIL);
    // The invite link was spent above, so a fresh one is issued — and comes
    // back to the admin, since mail is unconfigured here.
    const first = await adminC.fetch(`/api/staff/${nadia.id}/link`, { method: "POST", body: {} });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.delivered, false);
    assert.match(first.json.link, /\?reset=/);
    // A second one seconds later hits the per-account gap.
    const tooSoon = await adminC.fetch(`/api/staff/${nadia.id}/link`, { method: "POST", body: {} });
    assert.equal(tooSoon.status, 400);
    assert.match(tooSoon.json.error, /less than a minute/);
    const guardC = client(base);
    await guardC.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    const refused = await guardC.fetch(`/api/staff/${nadia.id}/link`, { method: "POST", body: {} });
    assert.equal(refused.status, 403);
  });

  await test("export downloads with a logged reason; erase needs the name typed back", async () => {
    // A fresh resident for this, since newId is erased by the next test.
    const made = await supC.fetch("/api/residents", { method: "POST", body: { first_name: "Export", last_name: "Candidate", date_of_birth: "1985-01-02" } });
    const rid = made.json.id;
    const admin = client(base);
    await admin.fetch("/api/session", { method: "POST", body: { email: "head@hut.example", password: PASSWORD } });

    const noReason = await admin.fetch(`/api/residents/${rid}/export`);
    assert.equal(noReason.status, 400);
    const guardTry = await api.fetch(`/api/residents/${rid}/export?reason=curious`);
    assert.equal(guardTry.status, 403);
    const supTry = await supC.fetch(`/api/residents/${rid}/export?reason=curious`);
    assert.equal(supTry.status, 403, "a supervisor could export");

    const ok = await admin.fetch(`/api/residents/${rid}/export?reason=SAR%20received`);
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.headers.get("content-disposition"), /attachment; filename="record-Candidate-Export-/);
    assert.equal(ok.json.resident.first_name, "Export");
    assert.ok(Array.isArray(ok.json.changes));
    const noted = await withOwner((c) => c.query(`select note from public.admin_audit where action = 'export' and row_id = $1`, [rid]));
    assert.deepEqual(noted.rows.map((r) => r.note), ["SAR received"]);

    const wrongName = await admin.fetch(`/api/residents/${rid}`, { method: "DELETE", body: { reason: "test", confirm_name: "Someone Else" } });
    assert.equal(wrongName.status, 400);
    assert.match(wrongName.json.error, /does not match/);
    const supErase = await supC.fetch(`/api/residents/${rid}`, { method: "DELETE", body: { reason: "test", confirm_name: "Export Candidate" } });
    assert.equal(supErase.status, 403, "a supervisor could erase");
    const erased = await admin.fetch(`/api/residents/${rid}`, { method: "DELETE", body: { reason: "test", confirm_name: "export  candidate" } });
    assert.equal(erased.status, 200, erased.text);
    assert.equal(erased.json.erased, true);
    const gone = await supC.fetch(`/api/residents/${rid}/record`);
    assert.equal(gone.status, 404);
  });

  await test("settings: staff read, admins write, Postgres judges the timezone", async () => {
    const read = await api.fetch("/api/settings");
    assert.equal(read.status, 200);
    assert.equal(read.json.local_timezone, "Europe/Dublin");
    const guardWrite = await api.fetch("/api/settings", { method: "PATCH", body: { site_name: "Hacked" } });
    assert.equal(guardWrite.status, 403);
    const supWrite = await supC.fetch("/api/settings", { method: "PATCH", body: { site_name: "Hacked" } });
    assert.equal(supWrite.status, 403, "a supervisor changed settings");

    const admin = client(base);
    await admin.fetch("/api/session", { method: "POST", body: { email: "head@hut.example", password: PASSWORD } });
    const badTz = await admin.fetch("/api/settings", { method: "PATCH", body: { local_timezone: "Mars/Olympus" } });
    assert.equal(badTz.status, 400);
    assert.match(badTz.json.error, /timezone/i);
    const badHour = await admin.fetch("/api/settings", { method: "PATCH", body: { due_soon_after_hour: 25 } });
    const badIdle = await admin.fetch("/api/settings", { method: "PATCH", body: { idle_lock_minutes: 0 } });
    assert.equal(badIdle.status, 400, "an idle lock of zero minutes must be refused");
    assert.equal(badHour.status, 400);
    const okW = await admin.fetch("/api/settings", { method: "PATCH", body: { site_name: "Harbour House", warn_after_consecutive_nights: 4 } });
    assert.equal(okW.status, 200, okW.text);
    assert.equal(okW.json.site_name, "Harbour House");
    assert.equal(okW.json.warn_after_consecutive_nights, 4);
    const audited = await withOwner((c) => c.query(`select count(*)::int as n from public.admin_audit where table_name = 'app_settings'`));
    assert.ok(audited.rows[0].n >= 1, "the settings change was not audited");
    await admin.fetch("/api/settings", { method: "PATCH", body: { site_name: "Security Hut", warn_after_consecutive_nights: 3 } });
  });

  await test("export carries the change history; erasure removes it", async () => {
    const adminId = (await withOwner((c) => c.query(`select id from auth.users where email = 'head@hut.example'`))).rows[0].id;
    const exported = await withIdentity(adminId, (c) => c.query(`select public.export_resident_record($1) as e`, [newId]));
    const changes = exported.rows[0].e.changes;
    assert.ok(Array.isArray(changes) && changes.length >= 2, "export has no change history");
    await withIdentity(adminId, (c) => c.query(`select public.note_disclosure($1, 'subject access request')`, [newId]));
    const noted = await withOwner((c) => c.query(`select count(*)::int as n from public.admin_audit where action = 'export' and row_id = $1`, [newId]));
    assert.equal(noted.rows[0].n, 1, "the export was not noted");
    const refused = await withIdentity(guardId, (c) => c.query(`select public.note_disclosure($1, 'x')`, [newId]).then(() => "allowed", (e) => e.code));
    assert.equal(refused, "42501", "a guard could note a disclosure");

    await withIdentity(adminId, (c) => c.query(`select public.erase_resident($1, 'test')`, [newId]));
    const left = await withOwner((c) => c.query(
      `select action, old_row, new_row, note from public.admin_audit where table_name = 'residents' and row_id = $1`, [newId]));
    assert.ok(left.rows.every((r) => r.action === "delete" && r.old_row === null && r.new_row === null),
      `identifying audit rows survived erasure: ${JSON.stringify(left.rows).slice(0, 200)}`);
  });

  await test("a guard cannot create, promote or disable anyone", async () => {
    const guardC = client(base);
    await guardC.fetch("/api/session", { method: "POST", body: { email: EMAIL, password: PASSWORD } });

    const create = await guardC.fetch("/api/staff", {
      method: "POST",
      body: { email: "sneaky@hut.example", full_name: "Sneaky", role: "admin" },
    });
    assert.equal(create.status, 400);
    assert.match(create.json.error, /administrator/);

    const list = await guardC.fetch("/api/staff");
    assert.equal(list.status, 200); // profiles are staff-visible by design
    const admin = list.json.find((s) => s.email === "head@hut.example");
    const demote = await guardC.fetch(`/api/staff/${admin.id}/role`, { method: "POST", body: { role: "guard" } });
    assert.equal(demote.status, 404, "a guard's role change did not fail closed");
    const disable = await guardC.fetch(`/api/staff/${admin.id}/active`, { method: "POST", body: { active: false } });
    assert.equal(disable.status, 404, "a guard's deactivation did not fail closed");
  });

  await test("a duplicate email and a bad address are refused cleanly", async () => {
    const dup = await adminC.fetch("/api/staff", {
      method: "POST",
      body: { email: SUPER_EMAIL, full_name: "Again", role: "guard" },
    });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /already exists/);

    const bad = await adminC.fetch("/api/staff", {
      method: "POST",
      body: { email: "not-an-address", full_name: "Short", role: "guard" },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /email/i);
  });

  await test("disabling an account ends its session; enabling restores access", async () => {
    const list = await adminC.fetch("/api/staff");
    const target = list.json.find((s) => s.email === SUPER_EMAIL);

    const superC = client(base);
    await superC.fetch("/api/session", { method: "POST", body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
    assert.equal((await superC.fetch("/api/summary")).status, 200);

    const off = await adminC.fetch(`/api/staff/${target.id}/active`, { method: "POST", body: { active: false } });
    assert.equal(off.status, 200);
    assert.equal((await superC.fetch("/api/summary")).status, 401, "a disabled account kept its session");

    const on = await adminC.fetch(`/api/staff/${target.id}/active`, { method: "POST", body: { active: true } });
    assert.equal(on.status, 200);
    const relogin = client(base);
    assert.equal((await relogin.fetch("/api/session", { method: "POST", body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } })).status, 200);
  });

  await test("an admin password reset logs the account out everywhere", async () => {
    const list = await adminC.fetch("/api/staff");
    const target = list.json.find((s) => s.email === SUPER_EMAIL);

    const superC = client(base);
    await superC.fetch("/api/session", { method: "POST", body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
    assert.equal((await superC.fetch("/api/summary")).status, 200);

    const res = await adminC.fetch(`/api/staff/${target.id}/password`, { method: "POST", body: { password: "a-brand-new-password" } });
    assert.equal(res.status, 200);
    assert.equal((await superC.fetch("/api/summary")).status, 401, "the old session survived the reset");

    const relogin = client(base);
    assert.equal((await relogin.fetch("/api/session", { method: "POST", body: { email: SUPER_EMAIL, password: "a-brand-new-password" } })).status, 200);
  });

  await test("an admin can change a role, but not their own", async () => {
    const list = await adminC.fetch("/api/staff");
    const target = list.json.find((s) => s.email === SUPER_EMAIL);
    const self = list.json.find((s) => s.email === "head@hut.example");

    const res = await adminC.fetch(`/api/staff/${target.id}/role`, { method: "POST", body: { role: "admin" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.role, "admin");
    await adminC.fetch(`/api/staff/${target.id}/role`, { method: "POST", body: { role: "supervisor" } });

    const own = await adminC.fetch(`/api/staff/${self.id}/role`, { method: "POST", body: { role: "guard" } });
    assert.equal(own.status, 400);
    assert.match(own.json.error, /own role/);

    const lockout = await adminC.fetch(`/api/staff/${self.id}/active`, { method: "POST", body: { active: false } });
    assert.equal(lockout.status, 400);
    assert.match(lockout.json.error, /own account/);
  });

  console.log("\n== the static tier ==");

  await test("only public/ is reachable", async () => {
    const escapes = [
      "/../migrations/002_schema.sql",
      "/../migrations/001_platform.sql",
      "/../docs/KNOWN-ISSUES.md",
      "/../lib/auth.js",
      "/%2e%2e/migrations/002_schema.sql",
      "/../../etc/passwd",
    ];
    for (const path of escapes) {
      const res = await api.fetch(path);
      assert.ok(res.status === 404 || res.status === 403, `${path} answered ${res.status}`);
      assert.ok(!/create table|DATABASE_URL|root:/.test(res.text), `${path} served content`);
    }
  });

  await test("the two apps are served", async () => {
    for (const path of ["/", "/index.html", "/checkin.html", "/admin.html", "/org.html", "/app-common.js", "/app-common.css", "/offline.js", "/sw.js"]) {
      const res = await api.fetch(path);
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
    }
  });

  await test("the security headers the host config used to declare are sent", async () => {
    const res = await api.fetch("/index.html");
    const want = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
    };
    for (const [header, value] of Object.entries(want)) {
      assert.equal(res.headers.get(header), value, `${header} was "${res.headers.get(header)}"`);
    }
    // `no-cache` does not mean "do not store" — the browser keeps the file and
    // asks whether it changed, so an unchanged page still costs a 304 with no
    // body. It is what stops a guard reloading after a deploy getting the old
    // page from cache, and it is the spelling the scheduler uses too.
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  // The CSP is computed from the files on disk at boot. If someone edits an
  // inline <script> and the hash is not recomputed, the browser silently
  // refuses to run the app — so assert the hashes match what is actually
  // being served, not merely that a CSP exists.
  await test("the CSP hashes the inline scripts instead of allowing them all", async () => {
    const res = await api.fetch("/index.html");
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "no CSP sent");
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "script-src still allows 'unsafe-inline'");
    assert.ok(!/style-src[^;]*unsafe-inline/.test(csp), "style-src still allows 'unsafe-inline'");
    assert.ok(!/cdn\.jsdelivr\.net|supabase/.test(csp), "CSP still names a third-party origin");
    assert.match(csp, /frame-ancestors 'none'/);

    const crypto = require("crypto");
    for (const page of ["/index.html", "/checkin.html", "/admin.html", "/org.html"]) {
      const html = (await api.fetch(page)).text;
      for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        const hash = crypto.createHash("sha256").update(m[1], "utf8").digest("base64");
        assert.ok(csp.includes(`'sha256-${hash}'`), `an inline script in ${page} is not hashed into the CSP`);
      }
      // The page's own <style> block is admitted by hash too; without it the
      // page renders unstyled and nothing reports an error.
      const styleSrc = (csp.match(/style-src[^;]*/) || [""])[0];
      for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        const hash = crypto.createHash("sha256").update(m[1], "utf8").digest("base64");
        assert.ok(styleSrc.includes(`'sha256-${hash}'`), `the <style> block in ${page} is not hashed into style-src`);
      }
    }
  });

  await test("api responses are never cached", async () => {
    const res = await api.fetch("/api/session");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  await test("/healthz reports the database, not just the process", async () => {
    const res = await api.fetch("/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  server.close();
  await closePool();
  console.log(`\nPASS: ${passed} HTTP assertions.`);
}

main().catch(async (err) => {
  console.error(`\nFAIL: ${err.message}`);
  if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  await closePool().catch(() => {});
  process.exit(1);
});

// The reset token only exists in the email, so tests mint one the same way
// routes/password-reset.js does and hand the plaintext back.
async function issueReset(email) {
  const crypto = require("crypto");
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest();
  await withOwner((c) => c.query(`delete from auth.password_resets`));
  const { rows } = await withOwner((c) =>
    c.query(`select auth.create_password_reset($1, $2, 60) as full_name`, [email, hash]));
  assert.ok(rows[0].full_name, `create_password_reset returned null for ${email}`);
  return token;
}
