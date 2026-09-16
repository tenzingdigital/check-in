// Families and child-supervision arrangements (migration 053).
//
//   GET  /api/households                       every household with members and the running arrangement; plus the unassigned
//   POST /api/households/:id/supervision       { carer_id, from_at, to_at, overnight }   supervisor+
//   GET  /api/households/:id/supervision?from&to  history, newest first
//   POST /api/supervision/:id/end              supervisor+
//
// Reads are for every staff member: the gate draws "children with …" from
// the same facts. Writes go through record_supervision()/end_supervision(),
// which refuse a guard, a carer inside the household, a child, a departed
// resident, an overlap, and a night without the overnight approval ticked.
// The arrangement holds no contact number and no note: the paper Appendix 5
// form on file keeps those (docs/reference/README.md).

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam, dateParam, translateDbError } = require('../lib/api');

const router = express.Router();

// v_resident_status and v_resident_room, never the residents table itself: a
// guard has no direct grant on residents (only a supervisor or admin does),
// so joining the raw table here would silently drop every row for a guard
// caller instead of erroring — the views already run as the table owner and
// carry everything this needs.
const MEMBER_SQL = `
  select v.id, rm.household_id, v.full_name,
         v.is_adult, v.age_years, v.presence, rm.room_label, rm.household_label, rm.household_size
    from v_resident_status v
    join v_resident_room rm on rm.id = v.id
   where v.status = 'active'
   order by rm.household_id, v.is_adult desc, v.last_name, v.first_name`;

router.get('/households', wrap(async (req, res) => {
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: members } = await client.query(MEMBER_SQL);
    const { rows: care } = await client.query('select * from v_household_care');
    const careById = new Map(care.map((c) => [c.household_id, c]));
    const byHousehold = new Map();
    const unassigned = [];
    for (const m of members) {
      const row = { id: m.id, full_name: m.full_name, is_adult: m.is_adult, age_years: m.age_years, room_label: m.room_label, presence: m.presence };
      if (!m.household_id) { unassigned.push(row); continue; }
      if (!byHousehold.has(m.household_id)) {
        byHousehold.set(m.household_id, { id: m.household_id, label: m.household_label, size: m.household_size, room_labels: [], members: [], care: null });
      }
      const h = byHousehold.get(m.household_id);
      h.members.push(row);
      if (m.room_label && !h.room_labels.includes(m.room_label)) h.room_labels.push(m.room_label);
    }
    const households = [...byHousehold.values()].map((h) => {
      const c = careById.get(h.id) || {};
      return {
        ...h,
        guardians: c.guardians ?? h.members.filter((m) => m.is_adult).length,
        children: c.children ?? h.members.filter((m) => !m.is_adult).length,
        guardians_on_site: c.guardians_on_site ?? 0,
        children_on_site: c.children_on_site ?? 0,
        care: c.arrangement_id ? { arrangement_id: c.arrangement_id, carer_id: c.carer_id, carer_name: c.carer_name, carer_room_label: c.carer_room_label, until: c.until, overnight: c.overnight } : null,
      };
    }).sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return { households, unassigned };
  });
  res.json(out);
}));

function tsParam(v, field) {
  const d = new Date(String(v || ''));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} must be a date and time`);
  return d.toISOString();
}

router.post('/households/:id/supervision', wrap(async (req, res) => {
  const household = uuidParam(req.params.id, 'household id');
  const body = req.body || {};
  const carer = uuidParam(body.carer_id, 'carer_id');
  const from = tsParam(body.from_at, 'from_at'), to = tsParam(body.to_at, 'to_at');
  const overnight = body.overnight === true;
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select record_supervision($1, $2, $3, $4, $5) as id', [household, carer, from, to, overnight]);
    const { rows: out } = await client.query(
      `select id, household_id, carer_id, from_at, to_at, overnight, recorded_by, recorded_at from supervision_arrangements where id = $1`, [rows[0].id]);
    return out[0];
  }).catch((err) => { throw translateDbError(err); });
  res.status(201).json(row);
}));

router.get('/households/:id/supervision', wrap(async (req, res) => {
  const household = uuidParam(req.params.id, 'household id');
  const from = dateParam(req.query.from, 'from'), to = dateParam(req.query.to || req.query.from, 'to');
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    // v_resident_status for the carer's name, not the residents table: this
    // is a staff-wide read (a guard included), and a guard has no direct
    // grant on residents.
    const { rows } = await client.query(
      `select a.id, a.carer_id, v.full_name as carer_name, rm.room_label as carer_room_label,
              a.from_at, a.to_at, a.overnight, a.recorded_at, a.ended_at, p.full_name as recorded_by_name
         from supervision_arrangements a
         join v_resident_status v on v.id = a.carer_id
         left join v_resident_room rm on rm.id = a.carer_id
         left join profiles p on p.id = a.recorded_by
         cross join (select local_timezone from app_settings where id) tz
        where a.household_id = $1
          and (a.from_at at time zone tz.local_timezone)::date <= $3::date
          and (a.to_at at time zone tz.local_timezone)::date >= $2::date
        order by a.from_at desc`, [household, from, to]);
    return rows;
  });
  res.json(rows);
}));

router.post('/supervision/:id/end', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'arrangement id');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select end_supervision($1)', [id]);
    const { rows } = await client.query('select id, ended_at from supervision_arrangements where id = $1', [id]);
    return rows[0];
  }).catch((err) => { throw translateDbError(err); });
  res.json(row);
}));

module.exports = router;
