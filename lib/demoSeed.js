// lib/demoSeed.js — the sample centre a trial can start with.
/* ============================================================================

   A trial that opens on an empty list teaches nobody anything: every screen is
   an empty state, the attention list has nothing in it, and the roll call has
   nobody to find. So a person who asks for sample data gets a centre that
   looks like a real morning — residents in rooms, families, a day of check-ins
   already recorded, a few people who need attention, and somebody on an
   authorised absence.

   Three rules this file follows.

   1. EVERY ROW IT WRITES IS REGISTERED in public.tenant_demo_rows, so Admin
      can clear exactly these people and nothing else. A trial can become a
      real register, and fabricated residents must never sit in a statutory
      record beside real ones.

   2. THE NAMES ARE OBVIOUSLY FICTIONAL and the same every time. They are not
      generated from anybody's data, and a support call about "Aoife Brennan"
      is immediately recognisable as a demo.

   3. IT WRITES THE TABLES DIRECTLY rather than calling record_checkin(), which
      requires is_staff() and reads auth.uid(). Provisioning runs as the owner
      with no session identity, so it cannot use the RPC — the same reason
      seed-today.js writes checkin_events and daily_compliance itself.

   Called from routes/signup.js inside the provisioning transaction. If it
   throws, the whole centre is rolled back: a half-seeded trial is worse than
   an empty one.
   ========================================================================= */

// A settled cast. Order matters only in that the first names listed get the
// interesting states, so the list reads deliberately rather than randomly.
const PEOPLE = [
  // [first, last, ageYears, evacNeed, household]
  ['Aoife',    'Brennan',        34, 'mobility', 'brennan'],
  ['Cormac',   'Brennan',         9, 'none',     'brennan'],
  ['Chidi',    'Okonkwo',        41, 'none',     null],
  ['Marek',    'Nowak',          29, 'none',     null],
  ['Síle',     'Ó Súilleabháin', 52, 'sight',    null],
  ['John',     'Fitzgerald',     63, 'none',     null],
  ['Dmytro',   'Kovalenko',      37, 'carer',    'kovalenko'],
  ['Olena',    'Kovalenko',      35, 'none',     'kovalenko'],
  ['Sofiia',   'Kovalenko',       4, 'none',     'kovalenko'],
  ['Nour',     'Haddad',         27, 'none',     null],
  ['Amara',    'Kone',           31, 'none',     null],
  ['Tomasz',   'Wójcik',         45, 'hearing',  null],
  ['Fatima',   'Al-Sayed',       38, 'none',     'alsayed'],
  ['Yusuf',    'Al-Sayed',       12, 'none',     'alsayed'],
  ['Grace',    'Adeyemi',        24, 'none',     null],
  ['Liam',     'Byrne',          58, 'none',     null],
  ['Ana',      'Popescu',        33, 'none',     null],
  ['Ibrahim',  'Diallo',         26, 'none',     null],
  ['Mary',     'Walsh',          71, 'mobility', null],
  ['Pavel',    'Horváth',        40, 'none',     null],
  ['Blessing', 'Eze',            22, 'none',     null],
  ['Andrii',   'Shevchenko',     30, 'none',     null],
  ['Leila',    'Karimi',         36, 'none',     null],
  ['Seán',     'Ó Ceallaigh',    49, 'none',     null],
  ['Miriam',   'Tesfaye',        28, 'none',     null],
  ['Hassan',   'Mahmoud',        44, 'none',     null],
  ['Justyna',  'Kowalska',       32, 'none',     null],
  ['Emeka',    'Nwosu',          25, 'none',     null],
  ['Rania',    'Boutros',        39, 'other',    null],
  ['Patrick',  'Doyle',          55, 'none',     null],
];

// Rooms: one building, two floors, enough beds for the cast with a few
// vacancies so the Vacancies report has something to say.
const FLOORS = [
  { floor: 'Ground', numbers: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'], capacity: 3 },
  { floor: 'First',  numbers: ['1', '2', '3', '4', '5', '6', '7'],  capacity: 3 },
];

// Deterministic pseudo-randomness, so a demo centre is the same one every
// time and a screenshot taken today matches one taken tomorrow.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const q = (schema, sql) => sql.split('__T__').join(schema);

/**
 * Fill a freshly provisioned tenant schema with a sample centre.
 *
 * @param client     a pg client already inside the provisioning transaction
 * @param schema     the tenant's schema, already quoted by the caller
 * @param tenantId   public.tenants.id, for the demo-row registry
 * @param adminId    the first administrator's profile id — every sample
 *                   check-in and movement is attributed to them, because
 *                   guard_id is NOT NULL and must reference a real profile
 */
async function seedDemoCentre(client, { schema, tenantId, adminId }) {
  const rand = rng(20260909);
  const demo = { resident: [], building: [], household: [] };

  // The features a trial should be able to see. They default to false so an
  // existing centre never has a screen appear unasked (docs/PRODUCT-ROADMAP,
  // Stage 1) — but a trial exists precisely to show what the product does, so
  // a sample centre turns them on.
  await client.query(q(schema, `
    update __T__.app_settings
       set feature_buildings = true, feature_evacuation = true,
           feature_households = true, feature_visitors = true`));

  // ---- the building and its rooms -----------------------------------------
  const { rows: [building] } = await client.query(
    q(schema, `insert into __T__.buildings (name, sort) values ($1, 0) returning id`),
    ['Main House']);
  demo.building.push(building.id);

  const roomIds = [];
  let sort = 0;
  for (const f of FLOORS) {
    for (const number of f.numbers) {
      const { rows: [room] } = await client.query(
        q(schema, `insert into __T__.rooms (building_id, floor, number, capacity, sort)
                   values ($1, $2, $3, $4, $5) returning id`),
        [building.id, f.floor, number, f.capacity, sort++]);
      roomIds.push(room.id);
    }
  }

  // ---- households ---------------------------------------------------------
  const households = new Map();
  for (const [, , , , hh] of PEOPLE) {
    if (hh && !households.has(hh)) {
      const { rows: [h] } = await client.query(
        q(schema, `insert into __T__.households default values returning id`));
      households.set(hh, h.id);
      demo.household.push(h.id);
    }
  }

  // ---- the residents ------------------------------------------------------
  // A family shares a room; everyone else is spread across the rest, leaving
  // a couple of rooms empty so Vacancies is not a list of zeroes.
  const residents = [];
  const roomForHousehold = new Map();
  let nextRoom = 0;
  for (const [first, last, age, need, hh] of PEOPLE) {
    let roomId;
    if (hh) {
      if (!roomForHousehold.has(hh)) roomForHousehold.set(hh, roomIds[nextRoom++ % roomIds.length]);
      roomId = roomForHousehold.get(hh);
    } else {
      roomId = roomIds[nextRoom++ % roomIds.length];
    }
    // A birthday somewhere in the year, so ages are not all the same date.
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - age);
    dob.setUTCMonth(Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));
    // Only adults carry an identity document, and only some of them, so both
    // "ID recorded" and "no ID recorded" appear on the list.
    const hasId = age >= 18 && rand() < 0.7;
    const { rows: [r] } = await client.query(
      q(schema, `insert into __T__.residents
                   (first_name, last_name, date_of_birth, room_id, evac_need, household_id,
                    id_type, id_number, registered_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, now() - ($9 || ' days')::interval)
                 returning id`),
      [first, last, dob.toISOString().slice(0, 10), roomId, need,
       hh ? households.get(hh) : null,
       hasId ? (rand() < 0.5 ? 'TRC' : 'IRP') : null,
       hasId ? 'SAMPLE' + String(100000 + Math.floor(rand() * 899999)) : null,
       30 + Math.floor(rand() * 300)]);
    demo.resident.push(r.id);
    residents.push({ id: r.id, adult: age >= 18, name: `${first} ${last}` });
  }

  // ---- who is on site right now -------------------------------------------
  // Roughly four in five, so the In & out tiles and the roll call both have a
  // realistic count rather than everybody or nobody.
  for (const r of residents) {
    const inside = rand() < 0.8;
    await client.query(
      q(schema, `insert into __T__.gate_events (resident_id, guard_id, kind, occurred_at, recorded_at)
                 values ($1, $2, $3, now() - ($4 || ' minutes')::interval, now())`),
      [r.id, adminId, inside ? 'in' : 'out', 10 + Math.floor(rand() * 600)]);
  }

  // ---- the register: three weeks of history, and today --------------------
  // The shapes this deliberately produces, so every state on the register and
  // every column of the Absences table has an example:
  //
  //   index 2, 3   never seen at all        -> state 'never'
  //   index 4..6   a run of recent misses   -> the attention list, and a
  //                                            consecutive-nights count at or
  //                                            over the figure in Settings
  //   index 7      an authorised absence    -> "Away until", excluded from
  //                                            the missed-night counts
  //   everyone else: seen almost every day, and seen today at a scattered time
  const DAYS = 21;
  const never = new Set([residents[2].id, residents[3].id]);
  const missing = new Set([residents[4].id, residents[5].id, residents[6].id]);

  for (const [i, r] of residents.entries()) {
    if (!r.adult) continue;                 // under 18 is not required to check in
    if (never.has(r.id)) continue;          // no history at all

    for (let back = DAYS; back >= 0; back--) {
      // The people on the attention list stop appearing over the last few days.
      const missedRun = missing.has(r.id) && back <= 3;
      const ordinaryMiss = !missedRun && back > 0 && rand() < 0.06;
      const presented = !missedRun && !ordinaryMiss;
      const isToday = back === 0;
      // Today is still in progress: about one in six has not been seen yet,
      // which is what the register's "Not seen" tile is for.
      if (isToday && (!presented || rand() < 0.16)) {
        await client.query(
          q(schema, `insert into __T__.daily_compliance
                       (resident_id, compliance_date, required, presented, checkin_count)
                     values ($1, (now() at time zone (select local_timezone from __T__.app_settings))::date, true, false, 0)
                     on conflict do nothing`), [r.id]);
        continue;
      }
      if (!presented) {
        await client.query(
          q(schema, `insert into __T__.daily_compliance
                       (resident_id, compliance_date, required, presented, checkin_count, closed_at)
                     values ($1,
                             ((now() at time zone (select local_timezone from __T__.app_settings))::date - $2::int),
                             true, false, 0, now())
                     on conflict do nothing`), [r.id, back]);
        continue;
      }
      // A check-in somewhere between 07:00 and 21:00 local.
      const hour = 7 + Math.floor(rand() * 14);
      const minute = Math.floor(rand() * 60);
      const at = `((now() at time zone (select local_timezone from __T__.app_settings))::date - $2::int
                   + make_interval(hours => $3, mins => $4))
                  at time zone (select local_timezone from __T__.app_settings)`;
      await client.query(
        q(schema, `insert into __T__.checkin_events (resident_id, guard_id, occurred_at, recorded_at)
                   values ($1, $5, ${at}, now())`),
        [r.id, back, hour, minute, adminId]);
      await client.query(
        q(schema, `insert into __T__.daily_compliance
                     (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
                   values ($1,
                           ((now() at time zone (select local_timezone from __T__.app_settings))::date - $2::int),
                           true, true, ${at}, 1, case when $2::int = 0 then null else now() end)
                   on conflict do nothing`),
        [r.id, back, hour, minute]);
    }
    void i;
  }

  // ---- an authorised absence ----------------------------------------------
  // So the register shows a resident "Away until" a date rather than missing,
  // and the Absences table has an example of a run that does not count.
  await client.query(
    q(schema, `insert into __T__.authorised_absences
                 (resident_id, from_date, to_date, reason, approved_by)
               values ($1,
                       (now() at time zone (select local_timezone from __T__.app_settings))::date - 1,
                       (now() at time zone (select local_timezone from __T__.app_settings))::date + 3,
                       'family', $2)`),
    [residents[7].id, adminId]);

  // ---- register every row, so Admin can clear exactly these ---------------
  for (const kind of Object.keys(demo)) {
    for (const rowId of demo[kind]) {
      await client.query(
        `insert into public.tenant_demo_rows (tenant_id, kind, row_id) values ($1, $2, $3)
         on conflict do nothing`, [tenantId, kind, rowId]);
    }
  }

  return { residents: demo.resident.length, rooms: roomIds.length, buildings: 1 };
}

/**
 * Remove everything seedDemoCentre wrote, and nothing else.
 *
 * Residents cascade to their check-ins, movements and compliance rows. Rooms
 * and buildings go only if nothing real moved into them in the meantime, which
 * is why the building delete is allowed to fail quietly: a centre that put its
 * own residents in the sample rooms keeps the rooms.
 */
async function clearDemoCentre(client, { schema, tenantId }) {
  const { rows } = await client.query(
    `select kind, row_id from public.tenant_demo_rows where tenant_id = $1`, [tenantId]);
  const of = (k) => rows.filter((r) => r.kind === k).map((r) => r.row_id);

  const residents = of('resident');
  let removed = 0;
  let keptResidents = 0;
  if (residents.length) {
    // Only rows that are still the sample people. The registry records a row
    // id and nothing about what was seeded there, so on the id alone this
    // would delete whoever now holds it — and the admin bar promises "nothing
    // you added yourself is touched". A centre that renamed a sample resident
    // into a real one has made that row real: it stays, and is reported, the
    // same way an occupied sample room stays. Names are the fingerprint we
    // have; PEOPLE is the list this module seeded from.
    const seeded = PEOPLE.map(([first, last]) => `${first}|${last}`);
    const { rowCount } = await client.query(
      q(schema, `delete from __T__.residents
                  where id = any($1::uuid[])
                    and (first_name || '|' || last_name) = any($2::text[])`),
      [residents, seeded]);
    removed = rowCount;
    keptResidents = residents.length - removed;
  }
  // Households are empty once their members are gone.
  if (of('household').length) {
    await client.query(
      q(schema, `delete from __T__.households h where h.id = any($1::uuid[])
                   and not exists (select 1 from __T__.residents r where r.household_id = h.id)`),
      [of('household')]).catch(() => {});
  }
  // Rooms and buildings only if still empty. A centre that moved real people
  // into the sample rooms keeps them, and says so.
  let keptRooms = false;
  for (const b of of('building')) {
    try {
      await client.query(
        q(schema, `delete from __T__.rooms r where r.building_id = $1
                     and not exists (select 1 from __T__.residents x where x.room_id = r.id)`), [b]);
      const { rowCount } = await client.query(
        q(schema, `delete from __T__.buildings b where b.id = $1
                     and not exists (select 1 from __T__.rooms r where r.building_id = b.id)`), [b]);
      if (!rowCount) keptRooms = true;
    } catch (_) { keptRooms = true; }
  }

  await client.query(`delete from public.tenant_demo_rows where tenant_id = $1`, [tenantId]);
  return { residents: removed, keptRooms, keptResidents };
}

module.exports = { seedDemoCentre, clearDemoCentre, DEMO_RESIDENT_COUNT: PEOPLE.length };
