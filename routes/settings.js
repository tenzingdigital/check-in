// Site settings: the app_settings row.
//
// Reading is any staff member's (the session endpoint already returns most
// of it); writing is the app_settings_write policy — admins only — so a
// supervisor's PATCH matches no rows and fails closed. Every value is also
// checked by the table's own constraints, which reach the browser as a 400
// with the constraint's message. Changes land in admin_audit by trigger.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError } = require('../lib/api');

const router = express.Router();

const COLUMNS = {
  site_name:                     { kind: 'text', max: 80 },
  local_timezone:                { kind: 'tz' },
  due_soon_after_hour:           { kind: 'int', min: 0, max: 23 },
  adult_age_years:               { kind: 'int', min: 1, max: 30 },
  event_retention_days:          { kind: 'int', min: 1, max: 3650 },
  compliance_retention_days:     { kind: 'int', min: 1, max: 36500 },
  absence_window_days:           { kind: 'int', min: 7, max: 365 },
  absence_window_limit:          { kind: 'int', min: 1, max: 365 },
  warn_after_consecutive_nights: { kind: 'int', min: 1, max: 90 },
  late_entry_window_hours:       { kind: 'int', min: 1, max: 168 },
  idle_lock_minutes:             { kind: 'int', min: 1, max: 720 },
  // Per-site switches for the buildings and evacuation features (017).
  feature_buildings:             { kind: 'bool' },
  feature_evacuation:            { kind: 'bool' },
  feature_households:            { kind: 'bool' },
};

router.get('/', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`select ${Object.keys(COLUMNS).join(', ')}, updated_at from public.app_settings limit 1`);
    return rows[0] || null;
  });
  res.json(row || {});
}));

router.patch('/', wrap(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const args = [];
  for (const [col, rule] of Object.entries(COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    let v = body[col];
    if (rule.kind === 'int') {
      v = Number.parseInt(v, 10);
      if (!Number.isFinite(v) || v < rule.min || v > rule.max) throw new HttpError(400, `${col.replace(/_/g, ' ')} must be between ${rule.min} and ${rule.max}`);
    } else if (rule.kind === 'bool') {
      if (v === true || v === 'true' || v === 1 || v === '1' || v === 'on') v = true;
      else if (v === false || v === 'false' || v === 0 || v === '0' || v === '' || v === null || v === 'off') v = false;
      else throw new HttpError(400, `${col.replace(/_/g, ' ')} must be true or false`);
    } else {
      v = String(v || '').trim();
      if (!v || (rule.max && v.length > rule.max)) throw new HttpError(400, `${col.replace(/_/g, ' ')} is required`);
    }
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to change');

  const row = await db.withIdentity(req.session.userId, async (client) => {
    if (Object.prototype.hasOwnProperty.call(body, 'local_timezone')) {
      // Postgres is the authority on what a timezone name is.
      try { await client.query('select now() at time zone $1', [String(body.local_timezone).trim()]); }
      catch (_) { throw new HttpError(400, 'Unknown timezone. Use a name like Europe/Dublin.'); }
    }
    const { rows } = await client.query(
      `update public.app_settings set ${sets.join(', ')}, updated_at = now() where id returning ${Object.keys(COLUMNS).join(', ')}, updated_at`,
      args,
    );
    return rows[0];
  });
  if (!row) throw new HttpError(403, 'Only an administrator can change settings');
  res.json(row);
}));

module.exports = router;
