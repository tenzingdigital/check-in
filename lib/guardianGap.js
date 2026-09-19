// lib/guardianGap.js — asking the September question at the moment it matters.
/* ============================================================================

   Migration 054 wrote down the fact this file acts on:

     "a parent signed OUT at the gate in the evening and did not come back;
      she had checked in earlier so the register read 'verified present'; her
      children were on site with nobody responsible; nothing said so until
      Monday."

   guardian_gap_households() has been able to state that since 054. The only
   thing missing was somebody asking it before the next midnight. This runs
   after every gate event, which is the moment a gap can open or close — a
   guardian signing out opens one, a guardian signing back in closes it, and
   nothing else changes the answer except a supervision arrangement being
   recorded.

   Idempotent by construction. It does not diff, remember, or track state
   between calls: it asks for the gaps that exist now, opens a row for each one
   that has no open row, and closes every open row whose household is no longer
   in the list. Run it twice and the second run does nothing. Miss a run and
   the next one catches up. That is the same contract close_out_compliance_days()
   has, and for the same reason — a scheduler, or a request, may always fail.

   It is called AFTER the response to the guard has been sent. A person at a
   door waiting on a push round trip is a worse product, and a failure to
   notify must never fail the movement itself: the register is the record, the
   alert is a courtesy on top of it.
   ========================================================================= */

const db = require('../database');
const push = require('./push');

/**
 * Evaluate one centre's guardian gaps, open and close alert rows, and notify.
 *
 * @param schema    the tenant's schema (from tenancy.schemaForUser)
 * @param tenantId  public.tenants.id
 * @returns { opened, closed, notified } — counts, never names
 */
async function evaluate(schema, tenantId) {
  const result = { opened: 0, closed: 0, notified: 0 };

  // The gaps as they stand. security definer and reading base tables, so this
  // answers the same for the owner connection as it does for a staff session
  // — which is exactly why 054 computed it as a function rather than a view
  // (every v_* view filters on is_staff(), false for the owner).
  const current = await db.withOwnerIn(schema, async (client) => (await client.query(
    `select household_id, children_on_site from guardian_gap_households()`)).rows);
  const now = new Map(current.map((r) => [r.household_id, r.children_on_site]));

  const { opened, closed } = await db.withOwner(async (client) => {
    const { rows: open } = await client.query(
      `select id, household_id from public.guardian_gap_alerts
        where tenant_id = $1 and closed_at is null`, [tenantId]);
    const openIds = new Map(open.map((r) => [r.household_id, r.id]));

    // Closed first: a gap that ended is the good news, and closing it before
    // opening anything means a household that closed and reopened in the same
    // instant cannot collide on the one-open-row index.
    const ended = open.filter((r) => !now.has(r.household_id)).map((r) => r.id);
    if (ended.length) {
      await client.query(
        `update public.guardian_gap_alerts set closed_at = now() where id = any($1::uuid[])`, [ended]);
    }

    const fresh = [];
    for (const [householdId, children] of now) {
      if (openIds.has(householdId)) continue;          // already open, already said
      // on conflict do nothing: two gate events landing together both see no
      // open row, and the partial unique index lets exactly one of them win.
      const { rows } = await client.query(
        `insert into public.guardian_gap_alerts (tenant_id, household_id, children_on_site)
         values ($1, $2, $3)
         on conflict (tenant_id, household_id) where closed_at is null do nothing
         returning id`, [tenantId, householdId, children]);
      if (rows[0]) fresh.push(rows[0].id);
    }
    return { opened: fresh, closed: ended.length };
  });

  result.opened = opened.length;
  result.closed = closed;
  if (!opened.length) return result;

  // Somebody to tell: the staff at this centre who have ticked
  // safeguarding_alert. The tick already exists (041) and already decides who
  // gets the nightly email; a phone is another way of reaching the same people,
  // not a second list to keep in step.
  const recipients = await db.withOwnerIn(schema, async (client) => (await client.query(
    `select p.id from profiles p where p.safeguarding_alert and p.active`)).rows.map((r) => r.id));

  if (!recipients.length || !push.isConfigured()) {
    // The gap is recorded either way. notified_at stays null, which is how the
    // centre can see that a gap was found and nobody was reachable.
    return result;
  }

  const siteName = await db.withOwnerIn(schema, async (client) =>
    (await client.query(`select site_name from app_settings where id`)).rows[0]?.site_name || 'Your centre');

  // The payload. No household, no child, no count, no id — see lib/push.js.
  // "Open CheckSteady" is the whole instruction; the app says the rest once it
  // has a session, on a screen that is already on the access log.
  const sent = await push.sendToUsers(recipients, {
    kind: 'guardian-gap',
    site: siteName,
    url: '/?alert=guardian-gap',
    // One tag for this kind, so a second alert replaces the first on the
    // lock screen rather than stacking. A person with four notifications
    // about the same thing reads none of them.
    tag: 'guardian-gap',
  });

  // notified_at is set only when a device actually took the message. Recipients
  // who are ticked but have no phone subscribed, or whose every subscription
  // has been dropped, leave it null — which is the difference between "nobody
  // needed telling" and "we found it and could not tell anyone", and the second
  // is a thing a centre has to be able to see.
  if (sent.sent > 0) {
    await db.withOwner((client) => client.query(
      `update public.guardian_gap_alerts set notified_at = now(), notified_count = $2
        where id = any($1::uuid[])`, [opened, sent.sent]));
  } else {
    console.warn(`[guardian-gap] ${opened.length} gap(s) opened and no device was reached`
      + ` (${recipients.length} staff ticked, ${sent.devices} subscribed device(s))`);
  }
  result.notified = sent.sent;
  return result;
}

/**
 * Run evaluate() without ever throwing into the caller.
 *
 * The gate route calls this after it has answered the guard. A failure to
 * notify must not fail, delay or roll back the movement: the register is the
 * record and it is already written by the time this runs.
 */
function evaluateInBackground(schema, tenantId, label = '') {
  setImmediate(() => {
    evaluate(schema, tenantId)
      .then((r) => {
        if (r.opened || r.closed) {
          console.log(`[guardian-gap] ${label}opened ${r.opened}, closed ${r.closed}, notified ${r.notified} device(s)`);
        }
      })
      .catch((err) => console.error(`[guardian-gap] ${label}${err && err.message}`));
  });
}

module.exports = { evaluate, evaluateInBackground };
