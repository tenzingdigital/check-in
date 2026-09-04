// Staff account management — the admin's Staff tab.
//
// Same posture as every other router: thin transport, no authorisation logic
// here. Creating an account and resetting a password go through the
// admin_create_staff / admin_set_staff_password SECURITY DEFINER functions,
// which re-check public.is_admin() themselves; deactivation and role changes
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
      `select p.id, u.email, p.full_name, p.role, p.active,
              u.last_sign_in_at, p.created_at
         from public.profiles p
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
      'select public.admin_invite_staff($1, $2, $3) as id',
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
      `select u.email, p.full_name from auth.users u join public.profiles p on p.id = u.id where u.id = $1`, [id]);
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
    const { rows } = await client.query('select site_name from public.app_settings limit 1');
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
      'update public.profiles set active = $2 where id = $1 returning id, active',
      [id, active],
    );
    return rows[0];
  });

  // No row means the id does not exist — or the caller is not an admin, in
  // which case the RLS policy made the update match nothing. Fails closed.
  if (!row) throw new HttpError(404, 'No such account, or not authorised.');
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
      'update public.profiles set role = $2 where id = $1 returning id, role',
      [id, role],
    );
    return rows[0];
  });

  if (!row) throw new HttpError(404, 'No such account, or not authorised.');
  res.json(row);
}));

// POST /api/staff/:id/password — reset a password. Ends every session the
// account holds, so "they know the old password" stops being useful now.
router.post('/:id/password', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');

  const ok = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select public.admin_set_staff_password($1, $2) as ok',
      [id, String(req.body?.password || '')],
    );
    return rows[0].ok;
  }).catch((err) => { throw translateDbError(err); });

  if (!ok) throw new HttpError(404, 'No such account.');
  res.json({ ok: true });
}));

module.exports = router;
