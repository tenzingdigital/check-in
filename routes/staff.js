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
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
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

// POST /api/staff — create an account. The admin chooses the initial
// password and hands it over in person; there is no email flow to leak it
// through, which is the same posture staff.js takes.
router.post('/', wrap(async (req, res) => {
  const { email, full_name, role, password } = req.body || {};

  const id = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select public.admin_create_staff($1, $2, $3, $4) as id',
      [String(email || ''), String(password || ''), String(full_name || ''), String(role || 'guard')],
    );
    return rows[0].id;
  }).catch((err) => { throw translateDbError(err); });

  res.status(201).json({ id });
}));

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
