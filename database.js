// Postgres connection pool, migration runner, and the transaction helpers every
// route uses.
//
// Deliberately shaped like the scheduler's database.js — same exports, same
// migration table, same SET LOCAL trick for row-level security — so that moving
// between the two codebases means reading the same file twice, not learning two
// designs. Where the two differ, it is because the tenancy models differ: the
// scheduler binds an ORGANIZATION per transaction (withOrg), this app binds a
// USER (withIdentity), because its policies are written against auth.uid().
try { require('dotenv').config(); } catch (_) { /* env comes from the host */ }

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}

// TLS is decided by the connection string, not guessed from the hostname.
//
// Render's two URLs need different answers: the internal one is reachable over
// the private network and its server does not offer TLS, so forcing it breaks
// the connection outright; the external one requires TLS and presents a chain
// Node's default store does not carry. `sslmode` in the URL says which — pg
// parses it, the same spelling libpq and psql use.
//
//   internal (the blueprint wires this in):  ...@dpg-xxxx-a/hut
//   external (migrations from your machine): ...@…render.com/hut?sslmode=require
//
// With no sslmode the driver connects in the clear, which is right for the
// private network and for the throwaway cluster the test suites build.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // A hut has a handful of terminals. The cap exists to stay well inside
  // Render's connection limit on the smallest Postgres plans, not because
  // concurrency is expected.
  max: Number(process.env.PGPOOL_MAX || 8),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// An IDLE client's connection dying is not a program error — it is Postgres
// restarting, failing over, or a network blip, and the pool's own job is to
// discard that client and carry on. But `pg` emits it as an 'error' EVENT, and
// an 'error' event with no listener is a hard throw in Node, which would take
// the whole service down every time Render restarted the database.
pool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] [db] idle client error (pool will recover):`,
    err && err.message ? err.message : err);
});

// The workhorse. Every non-transactional read goes through this.
function query(text, params) { return pool.query(text, params); }

// Run fn inside a transaction, rolling back if it throws.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // The ROLLBACK itself can throw — most obviously when the connection has
    // already died, which is exactly when `err` matters most. Unguarded, that
    // second failure REPLACES the original error on its way to the caller.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The only two roles a request may run as. Spelled as constants because
// `SET LOCAL ROLE` cannot be parameterised — the value is interpolated into
// SQL, so it must never be able to come from a request.
const ROLE_ANON = 'anon';
const ROLE_AUTHENTICATED = 'authenticated';

// Run fn inside a transaction bound to one identity, so RLS policies apply.
//
// This is the equivalent of the scheduler's withOrg(), and the reason
// migrations/002_schema.sql did not have to change when this app moved off
// Supabase: it is exactly what a Supabase request did per call.
//
//   SET LOCAL ROLE authenticated;                  -- table grants apply
//   SET LOCAL request.jwt.claim.sub = '<user id>'; -- auth.uid() returns this
//
// Every policy, every is_staff() check, every SECURITY DEFINER function that
// reads auth.uid() then behaves as written. Routes deliberately do NOT
// re-implement authorisation in JavaScript: if this function is correct, the
// database is still the thing deciding who may read a date of birth.
//
// SET LOCAL lasts only to the end of THIS transaction, which is what makes it
// safe on a pooled connection reused across users. There is no code path here
// that issues a session-level SET.
function withIdentity(userId, fn) {
  return withTransaction(async (client) => {
    await client.query(`SET LOCAL ROLE ${userId ? ROLE_AUTHENTICATED : ROLE_ANON}`);
    if (userId) {
      // set_config(..., true) is the function form of SET LOCAL, and unlike
      // SET it takes parameters — so the user id is bound, never interpolated.
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(userId)]);
    }
    return fn(client);
  });
}

// Run fn as the connection's own (owning) role, outside any request identity.
//
// Reserved for the things that exist below the security model rather than
// inside it: verifying a password, creating and deleting sessions, and the
// nightly maintenance functions. Nothing that serves resident data may use
// this — resident data goes through withIdentity() so that RLS applies.
async function withOwner(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// An arbitrary but fixed advisory-lock key. It only has to be the same in every
// instance of this app and unlikely to collide with another lock in the same
// database.
const MIGRATION_LOCK_KEY = 8141973;

// Apply pending migrations in filename order, recording each in
// schema_migrations. Called by server.js's boot() before it listens, so an
// instance never serves traffic against a schema it has not applied.
//
// Two differences from the scheduler's otherwise identical runner, both forced
// by this app rather than chosen:
//
//   * The whole run holds a Postgres advisory lock. This service can run more
//     than one instance, and two booting together on a deploy would otherwise
//     both try to apply the same file.
//   * migrations/002_schema.sql creates roles and grants, so it must run as the
//     owning role — hence withOwner rather than the pool's default path.
//
// Accepts an optional { withOwner } so tests can drive it against a different
// connection without touching the module-level pool.
async function migrate({ withOwner: owner = withOwner, log = console.log } = {}) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);

  return owner(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query('SELECT name FROM schema_migrations');
      const done = new Set(rows.map(r => r.name));

      const applied = [];
      for (const f of files) {
        if (done.has(f)) continue;
        const sql = fs.readFileSync(path.join(dir, f), 'utf8');
        // One transaction per migration: a file that fails part-way leaves
        // nothing behind. That is why the .sql files carry no BEGIN/COMMIT.
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw new Error(`${f}: ${err.message}`);
        }
        applied.push(f);
        log(`[migrate] applied ${f}`);
      }
      if (applied.length === 0) log(`[migrate] up to date (${files.length} migrations)`);
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  });
}

async function closePool() { await pool.end(); }

module.exports = { query, withTransaction, withIdentity, withOwner, migrate, closePool, pool };
