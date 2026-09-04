// lib/tenancy.js — mapping a tenant to its schema, and creating one.
/* ============================================================================

   Each business gets its own PostgreSQL schema. See docs/MULTI-TENANCY.md for
   why that was chosen over a tenant_id column: in short, isolation becomes
   structural rather than a predicate 56 places have to remember, and a
   mistake raises "relation does not exist" instead of quietly returning
   another centre's residents.

   The schema name NEVER comes from user input. It is derived from the slug
   already stored in public.tenants, which a table constraint has validated
   against ^[a-z][a-z0-9-]{1,38}[a-z0-9]$ before it could be written, and it is
   quoted with quote_ident on the way into DDL. Two locks on a door that
   should never be approached in the first place.
   ========================================================================= */

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'tenant', 'template.sql');

// The deployment that predates tenancy keeps its objects in public and is the
// tenant with this slug. Moving a live register into a t_ schema to prove a
// point would be risk with no benefit.
const LEGACY_SLUG = 'default';

// Belt and braces. public.tenants already enforces this shape; re-checking
// here means a corrupted or hand-edited row cannot reach DDL.
const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

// Names a customer may not take. Some would collide with a real schema
// (public, auth, extensions), the rest would be misleading in a URL or in
// support ("which admin?"). The slug is customer-visible, so this is a product
// decision as much as a safety one.
const RESERVED_SLUGS = new Set([
  'public', 'auth', 'extensions', 'pg_catalog', 'information_schema',
  'admin', 'api', 'www', 'app', 'mail', 'support', 'status', 'billing',
  'tenant', 'tenants', 'checksteady',
]);

function schemaForSlug(slug) {
  if (slug === LEGACY_SLUG) return 'public';
  const s = String(slug || '');
  if (!SLUG_RE.test(s) || RESERVED_SLUGS.has(s)) {
    throw new Error(`refusing to build a schema name from an invalid slug: ${slug}`);
  }
  // Hyphens are legal in a quoted identifier but make every hand-written query
  // awkward, so they become underscores. The mapping is total and one-way, and
  // the slug remains the customer-visible handle.
  return `t_${s.replace(/-/g, '_')}`;
}

// Which schema should this request read and write? One query, cached nowhere:
// a tenant that was suspended a second ago must not be served from a cache.
async function schemaForUser(client, userId) {
  const { rows } = await client.query(
    `select t.id, t.slug, t.status, u.platform_admin
       from auth.users u
       join public.tenants t on t.id = u.tenant_id
      where u.id = $1`,
    [userId],
  );
  if (!rows[0]) throw new Error('user belongs to no tenant');
  return { schema: schemaForSlug(rows[0].slug), status: rows[0].status, tenantId: rows[0].id, platformAdmin: !!rows[0].platform_admin };
}

// The search_path a request runs with. The tenant first, so every unqualified
// name in a route resolves there; public for the shared helpers; extensions
// for pg_trgm and pgcrypto. The legacy tenant IS public.
function searchPath(schema) {
  return schema === 'public' ? 'public, extensions' : `${schema}, public, extensions`;
}

function template() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

// Create the schema and everything in it.
//
// Opens its own transaction, because withOwner() hands out a bare pooled
// client and does NOT wrap one. A half-built tenant — a schema with tables but
// no policies, say — would be worse than no tenant at all, so this is all or
// nothing. It also keeps the template's `set local check_function_bodies`
// scoped to this transaction rather than leaking to the next borrower of the
// connection.
//
// Pass a client that is not already in a transaction.
async function provisionSchema(client, slug, { siteName, timezone } = {}) {
  const schema = schemaForSlug(slug);
  if (schema === 'public') {
    throw new Error('refusing to provision over the legacy public schema');
  }

  // quote_ident through the database rather than string-escaping here, so the
  // quoting rules are Postgres's own.
  const { rows } = await client.query('select quote_ident($1) as q', [schema]);
  const quoted = rows[0].q;

  await client.query('begin');
  try {
    await client.query(`create schema ${quoted}`);
    // The request roles need to see the schema; the grants on what is in it
    // travel with the template.
    await client.query(`grant usage on schema ${quoted} to anon, authenticated`);
    await client.query(template().split('__TENANT__').join(quoted));

    // Every tenant needs exactly one settings row; the table is a singleton by
    // constraint and the template ships it empty.
    await client.query(
      `insert into ${quoted}.app_settings (site_name, local_timezone)
       values ($1, coalesce($2, 'Europe/Dublin'))`,
      [siteName || 'Your centre', timezone || null],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }

  return schema;
}

// Deprovisioning is only ever reached from the deletion timeline in the DPA.
// It is a separate, deliberate act, never a side effect of a trial lapsing.
async function dropSchema(client, slug) {
  const schema = schemaForSlug(slug);
  if (schema === 'public') throw new Error('refusing to drop the public schema');
  const { rows } = await client.query('select quote_ident($1) as q', [schema]);
  await client.query(`drop schema if exists ${rows[0].q} cascade`);
  return schema;
}

module.exports = {
  schemaForSlug,
  schemaForUser,
  searchPath,
  provisionSchema,
  dropSchema,
  template,
  LEGACY_SLUG,
  RESERVED_SLUGS,
  TEMPLATE_PATH,
};
