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
const { HttpError, dateParam, translateDbError } = require('../lib/api');
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
  // The nightly House Rules reminder by email (032). No longer read: 054
  // folded it into nightly_email below; the column goes in a later migration.
  notify_thresholds_email:       { kind: 'bool' },
  // The one nightly email (054), to the staff ticked for the safeguarding alert.
  nightly_email:                 { kind: 'bool' },
  // The Sunday Weekly register update by email (035). Recipients are a flag
  // on the staff record (POST /api/staff/:id/weekly-report, migration 037),
  // not a setting.
  weekly_report_email:           { kind: 'bool' },
  // Attach the Sunday update as a Word document — names residents (052).
  weekly_report_attach_document: { kind: 'bool' },
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
// The self check-in tablet's photograph (migration 057)
// ---------------------------------------------------------------------------
//   PUT    /api/settings/kiosk-photo   administrators — raw image bytes
//   DELETE /api/settings/kiosk-photo   administrators
//   GET    /api/settings/kiosk-photo   any staff member — the Settings preview
//
// The PUT body is not JSON: server.js mounts a raw parser on this exact path,
// ahead of the blanket express.json() for the rest of /api, so req.body here
// is a Buffer of the image itself and its declared type is the request's own
// Content-Type header. set_site_photo() (057) checks size and declared type
// again — the real security boundary — but sniffing the file's own magic
// bytes here catches the much more common mistake of a wrong extension or a
// renamed file, with a sentence written for whoever is uploading rather than
// a database error.
const KIOSK_PHOTO_TYPES = {
  // JPEG: FF D8 FF, the Start Of Image marker plus the byte every JPEG
  // variant (JFIF, EXIF, ...) begins its next marker with.
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // PNG: the fixed 8-byte signature every PNG file opens with.
  'image/png': (b) => b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  // WebP: a RIFF container carrying a WEBP payload — bytes 0-3 'RIFF', a
  // 4-byte little-endian chunk size, then bytes 8-11 'WEBP'.
  'image/webp': (b) => b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
};

router.put('/kiosk-photo', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, "Only an administrator can set the tablet's photograph");

  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new HttpError(400, 'No photograph was uploaded');
  }
  const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const sniff = KIOSK_PHOTO_TYPES[contentType];
  if (!sniff || !sniff(bytes)) {
    throw new HttpError(400, 'That file is not a JPEG, PNG or WebP image');
  }

  await db.withIdentity(req.session.userId, (client) =>
    client.query('select public.set_site_photo($1, $2, $3)', ['kiosk', contentType, bytes]))
    .catch((err) => { throw translateDbError(err); });

  res.json({ ok: true, content_type: contentType, bytes: bytes.length });
}));

router.delete('/kiosk-photo', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, "Only an administrator can remove the tablet's photograph");
  await db.withIdentity(req.session.userId, (client) => client.query('select public.clear_site_photo($1)', ['kiosk']));
  res.status(204).end();
}));

router.get('/kiosk-photo', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`select * from site_photo('kiosk')`);
    return rows[0];
  });
  if (!row) throw new HttpError(404, 'No photograph has been set');
  res.setHeader('Content-Type', row.content_type);
  res.send(row.bytes);
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
  // schemaForUser has always returned the tenant's status and this discarded
  // it — so unlike every withIdentity route, the one destructive endpoint here
  // was not gated on the centre being allowed to write. tenant_may_write()'s
  // comment is explicit that a lapsed trial keeps reading, exporting and
  // erasing but loses writing; deleting the register is not an exception.
  const { rows } = await db.withOwner((client) =>
    client.query('select public.tenant_may_write($1) as ok', [t.tenantId]));
  if (!rows[0] || !rows[0].ok) {
    throw new HttpError(403, 'This centre cannot make changes at the moment.');
  }
  return t;
}

router.get('/demo-data', wrap(async (req, res) => {
  // Reads the sample-resident count on an owner connection with RLS bypassed,
  // so it needs the same gate as the delete rather than none at all.
  if (req.session.role !== 'admin') {
    throw new HttpError(403, 'Only an administrator can see the sample data');
  }
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
const jobs = require('../jobs');
const prefs = require('../lib/emailPrefs');

// Same rule as the nightly job (jobs.js reportLink()): PUBLIC_URL, or no
// link at all — never one built from the request. A route has a Host and
// an X-Forwarded-Proto to fall back on, but this app sets trust proxy with
// no Host allowlist, and the CSRF check only compares Origin to Host, which
// a direct request satisfies. Synthesising a link from either would let an
// authenticated admin cause a genuine, DKIM-signed email to reach every
// ticked supervisor and administrator carrying an origin nobody chose.
// compose() already handles link being absent.
// `params` lands the reader on the report and the week it is about — same
// shape as jobs.js reportLink(), and read by readDeepLink() in admin.html.
function reportLink(params) {
  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return null;
  const query = params ? `?${new URLSearchParams(params)}` : '';
  return `${configured}/admin.html${query}`;
}

router.post('/weekly-report/send', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can send the weekly report');
  // The route runs under db.withIdentity, as the caller, who cannot read
  // public.tenants; the slug is looked up as the owner first, from the
  // admin's own row (see lib/emailPrefs.js slugForUser()).
  const slug = await db.withOwner((c) => prefs.slugForUser(c, req.session.userId));
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: [s] } = await client.query(
      `select site_name, weekly_report_attach_document as attach, to_char(site_today(), 'YYYY-MM-DD') as today from app_settings where id`);
    // Recipients are the staff ticked to receive it (migration 037), not a
    // setting: every address is a known person with a login.
    const staff = await weekly.recipients(client);
    if (!staff.length) throw new HttpError(400, 'Tick at least one supervisor or admin to receive it under Staff first');
    const { from, to } = weekly.lastWeek(s.today);
    await client.query('select note_report($1, $2, $3, $4)', ['weekly', 'sent by hand', from, to]);
    const { rows } = await client.query('select * from weekly_register_rows($1, $2)', [from, to]);
    // One document for everyone: it is the same file, and the sentences in it
    // come from the same rows the audit row above was written for.
    const doc = s.attach ? weekly.document({ siteName: s.site_name, from, to, rows, generatedOn: s.today }) : null;
    let sent = 0;
    for (const r of staff) {
      const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'weekly_report' });
      const { subject, text, html } = weekly.compose({
        siteName: s.site_name, from, to, rows,
        link: reportLink({ tab: 'reports', report: 'weekly', from, to }),
        unsubscribe, attached: !!doc,
      });
      const mailed = await mail.send({
        to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe),
        ...(doc ? { attachments: [{ filename: doc.filename, content: doc.buffer, contentType: doc.contentType }] } : {}),
      });
      if (mailed.delivered) sent += 1;
    }
    return { sent, recipients: staff.length, from, to };
  });
  res.json(out);
}));

// POST /api/settings/nightly-email/send — tonight's email, now: the same
// message the 00:30 run would send about last night, to the staff ticked
// for it, switch or no switch, so an administrator can see what arrives
// before relying on it (the owner, 17 Sep 2026: "I want to be able to test
// the emails as they're working"). The message is built and sent by the
// job's own code (jobs.js nightlyByHand) as the owner in the caller's
// schema — the row queries read base tables the way the job does — after
// the audit row is written as the caller. No job_runs row, so tonight's
// real run is not "already sent".
router.post('/nightly-email/send', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can send the nightly email');
  const night = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: [s] } = await client.query(`select to_char(site_today() - 1, 'YYYY-MM-DD') as night from app_settings where id`);
    await client.query('select note_report($1, $2, $3, $4)', ['nightly', 'sent by hand', s.night, s.night]);
    return s.night;
  });
  const { schema } = await db.withOwner((c) => tenancy.schemaForUser(c, req.session.userId));
  const out = await db.withOwnerIn(schema, (client) => jobs.nightlyByHand(client, schema))
    .catch((err) => { throw new HttpError(400, err.message); });
  res.json({ ...out, night });
}));

// ---------------------------------------------------------------------------
// Permitted absence periods (migration 036; max_nights and PATCH: 050)
// ---------------------------------------------------------------------------
//   GET    /api/settings/absence-windows       any staff member
//   POST   /api/settings/absence-windows       administrators
//   PATCH  /api/settings/absence-windows/:id   administrators
//   DELETE /api/settings/absence-windows/:id   administrators
function maxNightsParam(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'Maximum nights must be a whole number between 1 and 365, or left blank');
  return n;
}

router.get('/absence-windows', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select id, name, from_date::text as from_date, to_date::text as to_date, max_nights from absence_windows order by from_date, id`);
    return rows;
  });
  res.json(rows);
}));

router.post('/absence-windows', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can change the permitted absence periods');
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'Give the period a name (up to 60 characters)');
  const from = dateParam(body.from_date, 'from_date');
  const to = dateParam(body.to_date, 'to_date');
  if (to < from) throw new HttpError(400, 'The last day must be on or after the first day');
  const maxNights = maxNightsParam(body.max_nights);
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `insert into absence_windows (name, from_date, to_date, max_nights, created_by) values ($1, $2, $3, $4, $5)
       returning id, name, from_date::text as from_date, to_date::text as to_date, max_nights`, [name, from, to, maxNights, req.session.userId]);
    return rows[0];
  }).catch((err) => { if (err && err.code === '42501') throw new HttpError(403, 'Only an administrator can change the permitted absence periods'); throw err; });
  res.status(201).json(row);
}));

router.patch('/absence-windows/:id', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can change the permitted absence periods');
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) throw new HttpError(400, 'Bad id');
  const body = req.body || {};
  const sets = [];
  const args = [id];
  const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Give the period a name (up to 60 characters)');
    set('name', name);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'from_date')) set('from_date', dateParam(body.from_date, 'from_date'));
  if (Object.prototype.hasOwnProperty.call(body, 'to_date')) set('to_date', dateParam(body.to_date, 'to_date'));
  if (Object.prototype.hasOwnProperty.call(body, 'max_nights')) set('max_nights', maxNightsParam(body.max_nights));
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `update absence_windows set ${sets.join(', ')} where id = $1
       returning id, name, from_date::text as from_date, to_date::text as to_date, max_nights`, args);
    return rows[0];
  }).catch((err) => {
    if (err && err.code === '23514') throw new HttpError(400, 'The last day must be on or after the first day');
    if (err && err.code === '42501') throw new HttpError(403, 'Only an administrator can change the permitted absence periods');
    throw err;
  });
  if (!row) throw new HttpError(404, 'No such period');
  res.json(row);
}));

router.delete('/absence-windows/:id', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can change the permitted absence periods');
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) throw new HttpError(400, 'Bad id');
  const n = await db.withIdentity(req.session.userId, async (client) => {
    const { rowCount } = await client.query('delete from absence_windows where id = $1', [id]);
    return rowCount;
  });
  if (!n) throw new HttpError(404, 'No such period');
  res.json({ ok: true });
}));

module.exports = router;
