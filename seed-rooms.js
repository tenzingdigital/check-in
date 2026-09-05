// seed-rooms.js — DEMO DATA. Put every resident in a room.
//
// For demo databases only, like seed.sql and seed-today.js: it invents
// buildings and assigns people to rooms at random, so it must never run
// against a register that holds real people (GDPR Art. 5(1)(d) — accuracy).
//
// What it does, in one transaction:
//   1. If the centre has NO buildings yet, it creates Slaney Manor's three —
//      Castle, Courtyard and Manor House — with floors and numbered rooms.
//      A centre that already has buildings keeps them exactly as they are.
//   2. Every active resident without a room is placed in a room with a free
//      bed, in the order the rooms are shown on the Buildings tab. Members of
//      a household are placed together where a room has space for all of
//      them. Residents who already have a room are left where they are.
//   3. If the beds run out, the rest stay unassigned and the log says how
//      many.
//
// Re-running it converges: nothing is moved, only the unplaced are placed.
//
// Two ways to run it:
//   DATABASE_URL="postgres://…" node seed-rooms.js     (by hand)
//   SEED_ROOMS=1                                       (once, at boot —
//     server.js calls run() after migrate; remove the env var afterwards)

const db = require('./database');

// Floors and rooms per building. Numbers are text, as on a door.
const DEMO_BUILDINGS = [
  { name: 'Castle',      floors: [['Ground', 1, 10, 3], ['1F', 11, 20, 3]] },
  { name: 'Courtyard',   floors: [['Ground', 1, 12, 3], ['1F', 13, 24, 3]] },
  { name: 'Manor House', floors: [['Ground', 1, 8, 4], ['1F', 9, 16, 4], ['2F', 17, 24, 4]] },
];

async function createDemoBuildings(client) {
  let sort = 10;
  for (const b of DEMO_BUILDINGS) {
    const { rows } = await client.query(
      `insert into public.buildings (name, sort) values ($1, $2) returning id`, [b.name, sort]);
    sort += 10;
    let rsort = 10;
    for (const [floor, from, to, capacity] of b.floors) {
      for (let n = from; n <= to; n += 1) {
        await client.query(
          `insert into public.rooms (building_id, floor, number, capacity, sort) values ($1, $2, $3, $4, $5)`,
          [rows[0].id, floor, String(n), capacity, rsort]);
        rsort += 10;
      }
    }
  }
}

// Rooms with a free bed, in display order, with how many beds are free.
const FREE_ROOMS_SQL = `
select rm.id, rm.capacity - count(r.id)::int as free
from public.rooms rm
join public.buildings b on b.id = rm.building_id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
group by rm.id, rm.capacity, b.sort, b.name, rm.sort, rm.floor, rm.number
having rm.capacity > count(r.id)
order by b.sort, b.name, rm.sort, rm.floor, rm.number`;

// The unplaced, grouped so a family arrives as one unit. Singles are
// shuffled by a stable hash so the same names do not always share a room.
const UNPLACED_SQL = `
select coalesce(household_id::text, id::text) as unit, array_agg(id) as ids
from public.residents
where status = 'active' and room_id is null
group by 1
order by array_length(array_agg(id), 1) desc, md5(min(id::text))`;

async function run() {
  return db.withOwner(async (client) => {
    await client.query('begin');
    try {
      const { rows: existing } = await client.query(`select count(*)::int as n from public.buildings`);
      let created = false;
      if (existing[0].n === 0) { await createDemoBuildings(client); created = true; }

      const { rows: rooms } = await client.query(FREE_ROOMS_SQL);
      const { rows: units } = await client.query(UNPLACED_SQL);

      let placed = 0;
      const leftover = [];
      for (const u of units) {
        // A whole household in one room where a room can take them; a family
        // larger than any free room is split across the next free beds.
        let room = rooms.find(r => r.free >= u.ids.length);
        const ids = [...u.ids];
        while (ids.length) {
          if (!room || room.free <= 0) room = rooms.find(r => r.free > 0);
          if (!room) { leftover.push(...ids); break; }
          const take = ids.splice(0, room.free);
          await client.query(`update public.residents set room_id = $1 where id = any($2::uuid[])`, [room.id, take]);
          room.free -= take.length;
          placed += take.length;
        }
      }
      await client.query('commit');
      console.log(`seed-rooms: ${created ? 'created ' + DEMO_BUILDINGS.length + ' demo buildings; ' : ''}placed ${placed} resident(s)` +
        (leftover.length ? `; ${leftover.length} left without a bed — add rooms and run again` : ''));
      return { created, placed, unplaced: leftover.length };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
}

module.exports = { run };

if (require.main === module) {
  run().then(() => db.closePool()).catch((err) => { console.error(err); process.exit(1); });
}
