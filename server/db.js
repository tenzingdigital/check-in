"use strict";

/* ============================================================================
   db.js — the connection pool, and the one function that binds a request to
   the database's own security model.

   This is the most important file in server/. Everything the old Supabase
   deployment got for free from PostgREST — a request arriving with an identity
   and running under row-level security — happens here, in about thirty lines.
   ========================================================================= */

import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

// TLS is decided by the connection string, not guessed from the hostname.
//
// Render's two URLs need different answers: the internal one is reachable over
// the private network and its server does not offer TLS, so forcing it breaks
// the connection outright; the external one requires TLS and presents a chain
// Node's default store does not carry. Sniffing which is which from the
// hostname is exactly the kind of cleverness that fails at 3am on a rename, so
// instead `sslmode` in the URL says — pg parses it, the same spelling libpq
// and psql use.
//
//   internal (the blueprint wires this in):  ...@dpg-xxxx-a/hut
//   external (migrations from your machine): ...@…render.com/hut?sslmode=require
//
// With no sslmode the driver connects in the clear, which is right for the
// private network and for the throwaway cluster the test suites build.
export const pool = new Pool({
  connectionString,
  // A hut has a handful of terminals. The cap exists to stay well inside
  // Render's connection limit on the smallest Postgres plans, not because
  // concurrency is expected.
  max: Number(process.env.PGPOOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// A pooled client that throws in the background must not take the process with
// it: pg emits 'error' on idle clients when the database restarts (Render
// restarts Postgres for maintenance), and an unhandled 'error' event is fatal.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

// The only two roles a request may run as. Spelled as constants because
// `SET LOCAL ROLE` cannot be parameterised — the value is interpolated into
// SQL, so it must never be able to come from a request.
export const ROLE_ANON = "anon";
export const ROLE_AUTHENTICATED = "authenticated";

/**
 * Run `fn` inside a transaction bound to one identity.
 *
 * This is the exact equivalent of what Supabase did per request, and the
 * reason schema.sql did not have to change when the app moved off it:
 *
 *   set local role authenticated;                  -- table grants apply
 *   set local request.jwt.claim.sub = '<user id>'; -- auth.uid() returns this
 *
 * Every policy in schema.sql, every is_staff() check, every SECURITY DEFINER
 * function that reads auth.uid() then behaves exactly as it did before. The
 * API layer deliberately does NOT re-implement authorisation in JavaScript:
 * if this function is correct, the database is still the thing deciding who
 * may read a date of birth, and that decision is still covered by the
 * acceptance suite.
 *
 * `SET LOCAL` (not `SET`) is load-bearing. The setting is scoped to the
 * transaction and is discarded on COMMIT or ROLLBACK, so a pooled connection
 * cannot hand one guard's identity to the next request. There is no code path
 * here that issues a session-level SET.
 *
 * @param {string|null} uid  the authenticated user's id, or null for anon
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withIdentity(uid, fn) {
  const role = uid ? ROLE_AUTHENTICATED : ROLE_ANON;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    if (uid) {
      // set_config(..., true) is the function form of SET LOCAL, and unlike
      // SET it takes parameters — so the user id is bound, never interpolated.
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    }
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` as the connection's own (owning) role, outside any request identity.
 *
 * Reserved for the things that exist below the security model rather than
 * inside it: verifying a password, creating and deleting sessions, and the
 * nightly maintenance functions. Nothing that serves resident data may use
 * this — resident data goes through withIdentity() so that RLS applies.
 */
export async function withOwner(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
