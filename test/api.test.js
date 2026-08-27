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
const app = require('../server');
const { closePool, withIdentity, withOwner, migrate } = require('../database');

const PASSWORD = "correct-horse-battery";
const EMAIL = "gina@hut.example";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`   ok  ${name}`);
}

/* ------------------------------------------------------------------------
   A cookie-holding HTTP client, which is all the front end is
   ---------------------------------------------------------------------- */

function client(base) {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async fetch(path, { method = "GET", body, headers = {} } = {}) {
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
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
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

async function main() {
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

  // A migration whose row is missing is one the runner would apply again. The
  // .sql files are written to be re-runnable, so that is survivable — but it
  // must be true, because a half-recorded tracking table is what a restored
  // backup looks like.
  await test("a missing row makes the runner re-apply that migration, cleanly", async () => {
    const target = "002_schema.sql";
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

    const today = new Date().toISOString().slice(0, 10);
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

  await test("a malformed id is a 400, not a 500", async () => {
    const res = await api.fetch("/api/residents/not-a-uuid/compliance");
    assert.equal(res.status, 400);
  });

  await test("an RPC's own refusal reaches the guard intact", async () => {
    const found = await api.fetch("/api/residents?q=brennan");
    const res = await api.fetch("/api/compliance-annotations", {
      method: "POST",
      body: { resident_id: found.json[0].id, date: "1999-01-01", note: "no such day" },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /No register row/);
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
    for (const path of ["/", "/index.html", "/checkin.html", "/app-common.js", "/app-common.css"]) {
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
    assert.ok(!/cdn\.jsdelivr\.net|supabase/.test(csp), "CSP still names a third-party origin");
    assert.match(csp, /frame-ancestors 'none'/);

      const crypto = require("crypto");
    for (const m of res.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const hash = crypto.createHash("sha256").update(m[1], "utf8").digest("base64");
      assert.ok(csp.includes(`'sha256-${hash}'`), "an inline script in index.html is not hashed into the CSP");
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
