// Optional end-to-end test of the offline path, in a real Chromium.
//
//   ./test/e2e.sh
//
// Not part of check.sh, because it needs Playwright, and this app has three
// dependencies on purpose. Install it without touching package.json:
//
//   npm install --no-save playwright
//
// What it proves that the HTTP suite cannot: the service worker serves the
// page with the network cut, the encrypted register copy is searchable, a
// tap made offline is queued and shown as such, the queue survives a reload,
// it is sent and flagged on reconnect, and a logout made offline ends the
// server session once the link returns.

const { chromium } = require("playwright");
const assert = require("assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:3111";
const EMAIL = "gina@hut.example", PASSWORD = "correct-horse-battery";

async function launch() {
  try { return await chromium.launch(); }
  catch (e) { return chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }); }
}

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
  page.on("console", (m) => { if (m.type() === "error") console.error("console.error:", m.text()); });

  const step = (s) => console.log("  ..", s);

  step("login");
  await page.goto(BASE + "/index.html");
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("#loginBtn");
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("button.card").length > 0);
  await page.waitForFunction(() => document.getElementById("netState").textContent === "Online");
  await page.evaluate(() => navigator.serviceWorker.ready);
  step("service worker ready, register on screen, pill says Online");

  const name = await page.locator("button.card .name").first().textContent();

  step("go offline");
  await ctx.setOffline(true);
  await page.waitForFunction(() => document.getElementById("netState").classList.contains("off"));

  step("sign a resident in while offline");
  await page.locator("button.card").first().click();
  await page.waitForSelector("#detail:not([hidden])");
  await page.click("#doIn");
  await page.waitForFunction(() => /queued/i.test(document.getElementById("toast").textContent));
  await page.waitForFunction(() => document.querySelector("button.card .pill.queued") !== null);
  const pill = await page.locator("#netState").textContent();
  assert.match(pill, /Offline · 1 queued/);
  step("card shows Queued; pill: " + pill);

  step("reload while still offline: page must load from the worker and carry on");
  await page.reload();
  await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll("button.card").length > 0);
  assert.ok(await page.locator("button.card .pill.queued").count() >= 1, "queued overlay lost on reload");
  const q = await page.locator("#q");
  await q.fill(name.split(" ")[1].slice(0, 3).toLowerCase());
  await page.waitForFunction((n) => [...document.querySelectorAll("button.card .name")].some((e) => e.textContent === n), name);
  step("offline search against the encrypted copy works");

  step("back online: the queue should sync");
  await ctx.setOffline(false);
  await page.waitForFunction(() => /been sent/.test(document.getElementById("toast").textContent), null, { timeout: 40000 });
  await page.waitForFunction(() => document.getElementById("netState").textContent === "Online");
  const today = new Date().toISOString().slice(0, 10);
  const log = await page.evaluate(async (d) => (await fetch(`/api/gate-events?date=${d}`)).json(), today);
  const entry = log.find((e) => e.resident_name === name && e.kind === "in");
  assert.ok(entry, "synced event missing from the log");
  assert.equal(entry.late_entry, true, "synced event not flagged");
  step("gate log shows the synced event flagged late_entry");

  step("check-in page: same drill");
  await page.goto(BASE + "/checkin.html");
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("button.card").length > 0);
  await page.waitForFunction(() => document.getElementById("netState").textContent === "Online");

  step("the header tiles filter the list");
  // Nobody has checked in yet in this fixture, so Seen is the empty state.
  await page.click('.stats button[data-filter="seen"]');
  await page.waitForFunction(() => document.querySelector('.stats button[data-filter="seen"]').getAttribute("aria-pressed") === "true");
  await page.waitForFunction(() => /Nobody has been seen yet today/.test(document.getElementById("searchResults").textContent));
  await page.click('.stats button[data-filter="not_seen"]');
  await page.waitForFunction(() => document.querySelector('.stats button[data-filter="not_seen"]').getAttribute("aria-pressed") === "true");
  await page.waitForFunction(() => /Showing \d+ not seen today/.test(document.getElementById("filterLine").textContent));
  const notYet = await page.locator("button.card .pill").allTextContents();
  assert.ok(notYet.length > 0 && notYet.every((t) => /not yet/i.test(t)), `Not seen filter showed: ${notYet.slice(0, 3).join(", ")}`);
  await page.click("#showAll");                                   // the way back
  await page.waitForFunction(() => document.getElementById("filterLine").hidden === true);
  await page.waitForFunction(() => [...document.querySelectorAll('.stats button[data-filter]')].every((b) => b.getAttribute("aria-pressed") === "false"));

  await ctx.setOffline(true);
  await page.waitForFunction(() => document.getElementById("netState").classList.contains("off"));
  await page.locator("button.card").first().click();
  await page.waitForSelector("#detail:not([hidden])");
  await page.click("#doCheckin");
  await page.waitForFunction(() => /queued/i.test(document.getElementById("toast").textContent));
  await page.waitForFunction(() => document.querySelector("button.card .pill.queued") !== null);
  await ctx.setOffline(false);
  await page.waitForFunction(() => /been sent/.test(document.getElementById("toast").textContent), null, { timeout: 40000 });
  const seen = await page.evaluate(async () => (await fetch(`/api/residents?q=&limit=5&compliance=1`)).json());
  assert.ok(seen.some((r) => r.seen_today), "no resident seen today after the synced check-in");
  step("synced check-in satisfied the day");
  // ...and the Seen tile now finds exactly that person.
  await page.click('.stats button[data-filter="seen"]');
  await page.waitForFunction(() => document.querySelectorAll("button.card").length === 1
    && /seen today/i.test(document.querySelector("button.card .pill").textContent));
  await page.click('.stats button[data-filter="seen"]');
  step("Seen tile shows the synced resident");

  step("a supervisor records an ID through the inline editor");
  {
    const sup = await ctx.newPage();
    await sup.goto(BASE + "/checkin.html");
    // The guard's session cookie is shared by the context; log out of it
    // first so the supervisor login is a clean one.
    await sup.evaluate(() => fetch("/api/session", { method: "DELETE" }));
    await sup.reload();
    await sup.waitForSelector("#login:not([hidden])");
    await sup.fill("#email", "sam@hut.example");
    await sup.fill("#password", "correct-horse-battery");
    await sup.click("#loginBtn");
    await sup.waitForSelector("#app:not([hidden])");
    await sup.waitForFunction(() => document.querySelectorAll("button.card").length > 0);
    await sup.locator("button.card").first().click();
    await sup.waitForSelector("#detail:not([hidden])");
    await sup.click("#editId");
    await sup.click('#idForm .seg button[data-type="IRP"]');
    await sup.fill("#idNumber", "irp1234567");
    await sup.click("#idSave");
    await sup.waitForFunction(() => /IRP IRP1234567/.test(document.querySelector("#detail .idline").textContent));
    assert.equal(await sup.locator("#idForm").count(), 0, "the editor should close after saving");

    step("the Admin page: a supervisor adds a resident and marks them departed");
    assert.equal(await sup.locator("#adminLink").isHidden(), false, "the Admin link should show for a supervisor");
    await sup.goto(BASE + "/admin.html");
    await sup.waitForSelector("#panelResidents:not([hidden])");
    await sup.waitForFunction(() => document.querySelectorAll("#residentList button.card").length > 0);
    assert.equal(await sup.locator("#tabStaff").isHidden(), true, "Staff must be hidden from a supervisor");
    await sup.click("#showAdd");
    await sup.fill("#afFirst", "Zelda");
    await sup.fill("#afLast", "Testperson");
    await sup.fill("#afDob", "1992-03-04");
    await sup.click('#addForm .seg button[data-type="TRC"]');
    await sup.fill("#afNumber", "trc55555");
    await sup.click("#afSave");
    await sup.waitForFunction(() => [...document.querySelectorAll("#residentList .name")].some((e) => e.textContent === "Zelda Testperson"));
    await sup.fill("#q", "testperson");
    await sup.waitForFunction(() => document.querySelectorAll("#residentList button.card").length === 1);
    await sup.locator("#residentList button.card").first().click();
    await sup.waitForSelector("#detail:not([hidden])");
    assert.equal(await sup.inputValue("#efDob"), "1992-03-04", "the edit sheet should carry the date of birth");
    sup.once("dialog", (d) => d.accept());
    await sup.click("#depart");
    await sup.waitForFunction(() => document.querySelector('#statusFilter button[data-status="departed"]').getAttribute("aria-pressed") === "true");
    await sup.waitForFunction(() => [...document.querySelectorAll("#residentList .pill")].some((e) => /departed/i.test(e.textContent)));
    step("departed resident shows under the Departed view");
    await sup.goto(BASE + "/checkin.html");
    await sup.waitForSelector("#app:not([hidden])");
    // Back to the guard for the remaining steps.
    await sup.evaluate(() => fetch("/api/session", { method: "DELETE" }));
    await sup.close();
    await page.evaluate(async () => { await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "gina@hut.example", password: "correct-horse-battery" }) }); });
    await page.reload();
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForFunction(() => document.getElementById("netState").textContent === "Online");
  }

  step("logout while offline, then reconnect: the server session must end");
  await ctx.setOffline(true);
  await page.waitForFunction(() => document.getElementById("netState").classList.contains("off"));
  await page.click("#logoutBtn");
  await page.waitForSelector("#login:not([hidden])");
  await ctx.setOffline(false);
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector("#login:not([hidden])", { timeout: 15000 });
  const who = await page.evaluate(async () => (await fetch("/api/session")).status);
  assert.equal(who, 401, "the offline logout did not end the server session on reconnect");
  step("offline logout finished on reconnect");

  await browser.close();
  console.log("\nE2E PASS");
})().catch((e) => { console.error("E2E FAIL:", e.message); process.exit(1); });
