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
const tenancy = require('../lib/tenancy');
const { clearDemoCentre } = require('../lib/demoSeed');

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
  holiday_max_days:              { kind: 'int', min: 1, max: 90 },
  late_entry_window_hours:       { kind: 'int', min: 1, max: 168 },
  idle_lock_minutes:             { kind: 'int', min: 1, max: 720 },
  // Per-site switches for the buildings and evacuation features (017).
  feature_buildings:             { kind: 'bool' },
  feature_evacuation:            { kind: 'bool' },
  feature_households:            { kind: 'bool' },
  feature_visitors:              { kind: 'bool' },
  feature_door_checkin:          { kind: 'bool' },
  // Codes by email at login for supervisors and admins (021).
  mfa_email:                     { kind: 'bool' },
  // The nightly House Rules reminder by email (032).
  notify_thresholds_email:       { kind: 'bool' },
  // The Sunday Weekly register update by email (035).
  weekly_report_email:           { kind: 'bool' },
  weekly_report_recipients:      { kind: 'emails' },
  // Where logins are expected from (022): ISO codes, comma-separated.
  home_countries:                { kind: 'countries' },
};

router.get('/', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`select ${Object.keys(COLUMNS).join(', ')}, updated_at from app_settings limit 1`);
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
    } else if (rule.kind === 'countries') {
      v = String(v || '').toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z]{2}(,[A-Z]{2})*$/.test(v)) throw new HttpError(400, 'home countries must be two-letter codes separated by commas, e.g. IE or IE,GB');
    } else if (rule.kind === 'emails') {
      // Comma-separated addresses; empty clears. Same shape as a staff invite.
      const parts = String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (parts.length > 10) throw new HttpError(400, 'At most ten addresses');
      for (const p of parts) {
        if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(p) || p.length > 120) throw new HttpError(400, `${p} is not an email address`);
      }
      v = parts.length ? parts.join(',') : null;
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
  // A code nobody can receive is a lockout: the switch needs a working mail
  // service before it may be turned on.
  if (body.mfa_email === true || body.mfa_email === 'true') {
    const mail = require('../lib/mail');
    if (!mail.isConfigured() && process.env.HUT_MAIL_SINK !== '1') {
      throw new HttpError(400, 'Configure email (RESEND_API_KEY and MAIL_FROM) before requiring codes by email');
    }
  }

  const row = await db.withIdentity(req.session.userId, async (client) => {
    if (Object.prototype.hasOwnProperty.call(body, 'local_timezone')) {
      // Postgres is the authority on what a timezone name is.
      try { await client.query('select now() at time zone $1', [String(body.local_timezone).trim()]); }
      catch (_) { throw new HttpError(400, 'Unknown timezone. Use a name like Europe/Dublin.'); }
    }
    const { rows } = await client.query(
      `update app_settings set ${sets.join(', ')}, updated_at = now() where id returning ${Object.keys(COLUMNS).join(', ')}, updated_at`,
      args,
    );
    return rows[0];
  });
  if (!row) throw new HttpError(403, 'Only an administrator can change settings');
  res.json(row);
}));

// ---------------------------------------------------------------------------
// Sample data — what a trial started with, and how to be rid of it
// ---------------------------------------------------------------------------
//   GET    /api/settings/demo-data   how many sample residents are left
//   DELETE /api/settings/demo-data   remove exactly those, and nothing else
//
// A trial that started with sample residents may become a real register.
// Fabricated people must never sit in a statutory record beside real ones, so
// every row the seed wrote is registered in public.tenant_demo_rows
// (migration 034) and this removes exactly that set. Anything the centre added
// itself — including a real resident moved into a sample room — stays, which
// is why the rooms are only removed when nothing is left in them.
//
// Runs as the owner because the registry lives in public and the delete
// crosses into the tenant's schema, so the caller's admin role is checked here
// explicitly rather than by a row policy.
async function demoContext(req) {
  const t = await db.withOwner((client) => tenancy.schemaForUser(client, req.session.userId));
  return t;
}

router.get('/demo-data', wrap(async (req, res) => {
  const t = await demoContext(req);
  const n = await db.withOwner(async (client) => (await client.query(
    `select count(*)::int as n from public.tenant_demo_rows
      where tenant_id = $1 and kind = 'resident'`, [t.tenantId])).rows[0].n);
  res.json({ residents: n });
}));

router.delete('/demo-data', wrap(async (req, res) => {
  if (req.session.role !== 'admin') {
    throw new HttpError(403, 'Only an administrator can clear the sample data');
  }
  const t = await demoContext(req);
  const out = await db.withOwner((client) =>
    clearDemoCentre(client, { schema: t.schema, tenantId: t.tenantId }));
  res.json(out);
}));

// ---------------------------------------------------------------------------
// POST /api/settings/weekly-report/send — last week's Weekly register update
// to the saved recipients, now. Administrators; on the audit record like an
// export, so a manual send has a trail.
// ---------------------------------------------------------------------------
const mail = require('../lib/mail');
const weekly = require('../lib/weeklyReport');

router.post('/weekly-report/send', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can send the weekly report');
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: [s] } = await client.query(
      `select site_name, weekly_report_recipients as recipients, to_char(site_today(), 'YYYY-MM-DD') as today from app_settings where id`);
    if (!s || !s.recipients) throw new HttpError(400, 'Add at least one recipient under Settings first');
    const { from, to } = weekly.lastWeek(s.today);
    await client.query('select note_report($1, $2, $3, $4)', ['weekly', 'sent by hand', from, to]);
    const { rows } = await client.query('select * from weekly_register_rows($1, $2)', [from, to]);
    const { subject, text } = weekly.compose({ siteName: s.site_name, from, to, rows });
    const recipients = s.recipients.split(',');
    let sent = 0;
    for (const to_ of recipients) {
      const r = await mail.send({ to: to_, subject, text });
      if (r.delivered) sent += 1;
    }
    return { sent, recipients: recipients.length, from, to };
  });
  res.json(out);
}));

module.exports = router;
