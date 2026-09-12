// Centres — the operator's view. Stage 5 of docs/PRODUCT-ROADMAP.md.
//
//   GET    /api/tenants            every centre with its counts
//   POST   /api/tenants            { name, slug, timezone?, admin_name, admin_email }
//   DELETE /api/tenants/:id        { confirm_slug }  closes the centre and drops its schema
//
// Only a platform admin (auth.users.platform_admin, set in SQL by the
// operator) may call these. No resident data crosses this route: the counts
// are counts, and the schema name is derived from the validated slug in
// public.tenants and quoted by Postgres before it reaches DDL.

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const tenancy = require('../lib/tenancy');
const { HttpError, uuidParam } = require('../lib/api');
const { sendLoginLink } = require('./staff');

const router = express.Router();

function platformOnly(req) {
  if (!req.session || req.session.platformAdmin !== true) {
    throw new HttpError(403, 'Only a platform administrator can manage centres');
  }
}

async function counts(client, schema) {
  const { rows } = await client.query('select quote_ident($1) as q', [schema]);
  const q = rows[0].q;
  const exists = await client.query('select 1 from pg_namespace where nspname = $1', [schema]);
  if (!exists.rowCount) return { residents: null, staff: null, last_close_out: null, site_name: null };
  const { rows: c } = await client.query(
    `select (select count(*)::int from ${q}.residents where status = 'active') as residents,
            (select count(*)::int from ${q}.profiles where active) as staff,
            (select max(ran_at) from ${q}.job_runs where job = 'close-out-compliance-days' and ok) as last_close_out,
            (select site_name from ${q}.app_settings limit 1) as site_name`);
  return c[0];
}

router.get('/tenants', wrap(async (req, res) => {
  platformOnly(req);
  const rows = await db.withOwner(async (client) => {
    const { rows: tenants } = await client.query(
      `select t.id, t.name, t.slug, t.status, t.created_at, t.trial_ends_at, t.closed_at,
              (select count(*)::int from auth.users u where u.tenant_id = t.id) as logins
         from public.tenants t order by t.created_at`);
    for (const t of tenants) {
      t.schema = tenancy.schemaForSlug(t.slug);
      Object.assign(t, t.status === 'closed' ? { residents: null, staff: null, last_close_out: null } : await counts(client, t.schema));
    }
    return tenants;
  });
  res.json(rows);
}));

router.post('/tenants', wrap(async (req, res) => {
  platformOnly(req);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Centre name is required (2 to 120 characters)');
  const slug = String(body.slug || '').trim().toLowerCase();
  let schema;
  try { schema = tenancy.schemaForSlug(slug); } catch (_) { throw new HttpError(400, 'Slug must be 3 to 40 lowercase letters, digits and hyphens, and not a reserved word'); }
  if (schema === 'public') throw new HttpError(400, 'That slug is the existing deployment');
  const timezone = String(body.timezone || 'Europe/Dublin').trim();
  const adminName = String(body.admin_name || '').trim();
  const adminEmail = String(body.admin_email || '').trim();
  if (!adminName || adminEmail.indexOf('@') < 1) throw new HttpError(400, 'The first administrator needs a name and an email address');

  const out = await db.withOwner(async (client) => {
    try { await client.query('select now() at time zone $1', [timezone]); }
    catch (_) { throw new HttpError(400, 'Unknown timezone. Use a name like Europe/Dublin.'); }
    const dup = await client.query('select 1 from public.tenants where slug = $1', [slug]);
    if (dup.rowCount) throw new HttpError(409, 'That slug is taken');

    const { rows } = await client.query(
      `insert into public.tenants (name, slug, status, terms_accepted_at, terms_version, terms_accepted_by_email)
       values ($1, $2, 'active', now(), 'operator-provisioned', $3) returning id`,
      [name, slug, adminEmail]);
    const tenantId = rows[0].id;
    try {
      await tenancy.provisionSchema(client, slug, { siteName: name, timezone });
      const { rows: u } = await client.query(
        `select auth.create_user_invited($1, $2, 'admin', $3) as id`, [adminEmail, adminName, tenantId]);
      return { id: tenantId, adminId: u[0].id };
    } catch (err) {
      await client.query('delete from public.tenants where id = $1', [tenantId]).catch(() => {});
      await tenancy.dropSchema(client, slug).catch(() => {});
      if (err && err.code === '23505') throw new HttpError(409, 'That email address already has an account');
      throw err;
    }
  });

  const sent = await sendLoginLink(req, adminEmail, { invite: true });
  res.status(201).json({ id: out.id, slug, schema, admin: { id: out.adminId, ...sent } });
}));

// Closing is the end of the DPA's deletion timeline, so it asks for the slug
// typed back, refuses the legacy tenant, and is recorded on the tenants row.
// The logins stay (on delete restrict, so the audit trail keeps its names)
// but can no longer sign in: their centre's profiles are gone with the schema.
router.delete('/tenants/:id', wrap(async (req, res) => {
  platformOnly(req);
  const id = uuidParam(req.params.id, 'tenant id');
  const confirm = String((req.body || {}).confirm_slug || '').trim();
  const out = await db.withOwner(async (client) => {
    const { rows } = await client.query('select id, slug, status from public.tenants where id = $1', [id]);
    const t = rows[0];
    if (!t) throw new HttpError(404, 'No such centre');
    if (t.slug === tenancy.LEGACY_SLUG) throw new HttpError(400, 'The existing deployment cannot be closed from here');
    if (confirm !== t.slug) throw new HttpError(400, 'Type the centre\'s slug to confirm');
    await client.query(`delete from auth.sessions s using auth.users u where u.id = s.user_id and u.tenant_id = $1`, [id]);
    await tenancy.dropSchema(client, t.slug);
    await client.query(`update public.tenants set status = 'closed', closed_at = now() where id = $1 and status <> 'closed'`, [id]);
    return t;
  });
  res.json({ ok: true, slug: out.slug });
}));

module.exports = router;
