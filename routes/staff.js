// Staff account management — the admin's Staff tab.
//
// Same posture as every other router: thin transport, no authorisation logic
// here. Creating an account and resetting a password go through the
// admin_create_staff / admin_set_staff_password SECURITY DEFINER functions,
// which re-check is_admin() themselves; deactivation and role changes
// are plain updates that the profiles_admin_all policy allows only to admins,
// so a non-admin's update simply matches no rows. The list is readable by any
// staff member by design — profiles are staff-visible so the log can show who
// did what, and auth.users grants `authenticated` exactly the credential-free
// columns selected here.
const express = require('express');
const crypto = require('crypto');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const mail = require('../lib/mail');
const { HttpError, translateDbError, uuidParam } = require('../lib/api');

const router = express.Router();

// GET /api/staff — every account, active first.
router.get('/', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select p.id, u.email, p.full_name, p.role, p.active, p.weekly_report,
              u.last_sign_in_at, p.created_at
         from profiles p
         join auth.users u on u.id = p.id
        order by p.active desc, p.role, p.full_name`,
    );
    return rows;
  });
  res.json(rows);
}));

// POST /api/staff — create an account and email its owner a link to choose
// a password. No password is typed by the administrator, ever: the account
// starts with a hash nobody can match (migration 013) and the link is the
// same single-use, one-day token the forgot-password flow uses.
//
// With mail unconfigured the link is returned to the administrator instead,
// so it can be handed over — that is no more than they could do before by
// choosing the password themselves, and it is said so in the response.
router.post('/', wrap(async (req, res) => {
  const { email, full_name, role } = req.body || {};
  const cleanEmail = String(email || '').trim();

  const id = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select admin_invite_staff($1, $2, $3) as id',
      [cleanEmail, String(full_name || ''), String(role || 'guard')],
    );
    return rows[0].id;
  }).catch((err) => { throw translateDbError(err); });

  const sent = await sendLoginLink(req, cleanEmail, { invite: true });
  res.status(201).json({ id, ...sent });
}));

// POST /api/staff/:id/link — send (again) the link to choose a password.
// Replaces typing a new password for somebody: it logs the account out
// everywhere only once its owner uses it, and nobody but them sees it.
router.post('/:id/link', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');

  // Admin-only, and the target must exist: read the email under the
  // caller's identity, where the staff-visible columns of auth.users are
  // granted, then confirm the role with the admin policy on profiles.
  const target = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select u.email, p.full_name from auth.users u join profiles p on p.id = u.id where u.id = $1`, [id]);
    return rows[0];
  });
  if (!target) throw new HttpError(404, 'No such account.');
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can send a login link.');

  const sent = await sendLoginLink(req, target.email, { invite: false });
  res.json(sent);
}));

// Mint the token, store its digest, and send it. Returns what the admin
// needs to know: whether it was emailed, and — only when mail is not
// configured — the link itself.
async function sendLoginLink(req, email, { invite }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const TTL_MINUTES = 24 * 60;

  const fullName = await db.withOwner(async (client) => {
    const { rows } = await client.query(
      'select auth.create_password_reset($1, $2, $3) as full_name',
      [email, tokenHash, TTL_MINUTES],
    );
    return rows[0] && rows[0].full_name;
  });
  if (!fullName) throw new HttpError(400, 'A link was sent less than a minute ago, or the account is disabled.');

  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const base = configured || `${req.get('x-forwarded-proto') || req.protocol || 'https'}://${req.get('host')}`;
  const link = `${base}/?reset=${encodeURIComponent(token)}`;

  const siteName = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select site_name from app_settings limit 1');
    return rows[0] && rows[0].site_name;
  });

  const message = invite
    ? mail.inviteEmail({ fullName, siteName, link, hours: 24, invitedBy: req.session.fullName })
    : mail.resetEmail({ fullName, link, minutes: TTL_MINUTES });
  const { delivered } = await mail.send({ to: email, subject: message.subject, text: message.text });

  return delivered
    ? { delivered: true, email }
    : { delivered: false, email, link, note: 'Email is not configured on this service, so the link was not sent. Pass it on yourself; it works once and expires in 24 hours.' };
}

// POST /api/staff/:id/active — enable or disable an account. Disabling ends
// access on the very next request (sessionFromToken joins profiles.active).
router.post('/:id/active', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');
  const active = req.body?.active === true;

  // The one check the database cannot express: the admin locking themselves
  // out mid-shift. Another admin can still disable this one.
  if (!active && id === req.session.userId) {
    throw new HttpError(400, 'You cannot deactivate your own account.');
  }

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'update profiles set active = $2 where id = $1 returning id, active',
      [id, active],
    );
    return rows[0];
  });

  // No row means the id does not exist — or the caller is not an admin, in
  // which case the RLS policy made the update match nothing. The two are
  // told apart so a refusal is a 403 like every other refusal (the
  // permission matrix holds every route to that), and an unknown id a 404.
  if (!row) throw req.session.role === 'admin' ? new HttpError(404, 'No such account.') : new HttpError(403, 'Only an administrator can disable or enable an account.');
  res.json(row);
}));

// POST /api/staff/:id/role — promote or demote an account.
router.post('/:id/role', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');
  const role = String(req.body?.role || '');
  if (!['guard', 'supervisor', 'admin'].includes(role)) {
    throw new HttpError(400, 'role must be guard, supervisor or admin');
  }
  if (id === req.session.userId) {
    throw new HttpError(400, 'You cannot change your own role.');
  }

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'update profiles set role = $2 where id = $1 returning id, role',
      [id, role],
    );
    return rows[0];
  });

  if (!row) throw req.session.role === 'admin' ? new HttpError(404, 'No such account.') : new HttpError(403, 'Only an administrator can change a role.');
  res.json(row);
}));

// POST /api/staff/:id/weekly-report — tick or untick whether this account
// receives the Sunday Weekly register update. Only a supervisor or admin may
// run the report it summarises, so a guard must never carry the flag: the
// database refuses it (profiles_weekly_report_not_guard, migration 037),
// surfacing here as a plain 400 via translateDbError, and a demotion to
// guard clears the flag by trigger rather than fail because of it. The
// update itself is the authorisation check (profiles_admin_all), same as
// /:id/active and /:id/role — a non-admin's update matches no rows before
// the constraint is ever reached.
router.post('/:id/weekly-report', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');
  const on = req.body?.on === true;

  const row = await db.withIdentity(req.session.userId, async (client) => {
    // A guard cannot carry the flag: the check constraint
    // (profiles_weekly_report_not_guard, migration 037) is the real
    // guarantee, reached by any writer, but 23514 is in
    // USER_FACING_SQLSTATES and translateDbError forwards a check
    // constraint's message verbatim — text Postgres wrote, naming the
    // constraint, not text written for a manager to read. This pre-check
    // gives the 400 an actual sentence instead. Scoped to an admin caller
    // ticking someone on: anyone else's request is already refused below,
    // by the update matching no rows, the same as every other route here.
    if (on && req.session.role === 'admin') {
      const { rows: [target] } = await client.query('select role from profiles where id = $1', [id]);
      if (target && target.role === 'guard') {
        throw new HttpError(400, 'A guard cannot receive the weekly report. Promote them to supervisor or admin first.');
      }
    }
    const { rows } = await client.query(
      'update profiles set weekly_report = $2 where id = $1 returning id, weekly_report',
      [id, on],
    );
    return rows[0];
  }).catch((err) => { throw translateDbError(err); });

  if (!row) throw req.session.role === 'admin' ? new HttpError(404, 'No such account.') : new HttpError(403, 'Only an administrator can change who receives the weekly report.');
  res.json(row);
}));

// POST /api/staff/:id/password — reset a password. Ends every session the
// account holds, so "they know the old password" stops being useful now.
router.post('/:id/password', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');

  const ok = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select admin_set_staff_password($1, $2) as ok',
      [id, String(req.body?.password || '')],
    );
    return rows[0].ok;
  }).catch((err) => { throw translateDbError(err); });

  if (!ok) throw new HttpError(404, 'No such account.');
  res.json({ ok: true });
}));

module.exports = router;
module.exports.sendLoginLink = sendLoginLink;
