"use strict";

/* ============================================================================
   migrate.js — numbered SQL migrations, applied in order, exactly once.

   Run standalone:

     DATABASE_URL="postgres://…" node server/migrate.js

   Or let it happen on its own: index.js calls runMigrations() before the
   server starts listening, so a deploy migrates itself and an instance never
   serves traffic against a schema it has not applied.

   Migrations live in db/migrations, named `NNN_description.sql`, applied in
   filename order. To change the schema, **add a new file** — never edit one
   that has been applied. Applied files are recorded in `schema_migrations`
   along with a checksum, and this runner says so at boot if one has drifted.

   Two properties worth keeping:

     - Each migration runs inside one transaction, so a file that fails
       part-way leaves nothing behind. That is why the SQL files contain no
       `begin`/`commit` of their own.
     - The whole run holds a Postgres advisory lock, so two instances booting
       at the same moment — the normal case on a Render deploy — cannot both
       apply the same migration. The second waits, then finds nothing to do.
   ========================================================================= */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { closePool, withOwner } from "./db.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations",
);

// An arbitrary but fixed key. Any number works; it only has to be the same in
// every instance of this app and unlikely to collide with another advisory
// lock in the same database.
const LOCK_KEY = 8_141_973;

const TRACKING_TABLE = `
  create table if not exists public.schema_migrations (
    filename    text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now()
  )
`;

function checksum(sql) {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex").slice(0, 16);
}

async function listMigrations() {
  const names = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();          // NNN_ prefixes make lexical order the right order

  return Promise.all(
    names.map(async (filename) => {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
      return { filename, sql, checksum: checksum(sql) };
    }),
  );
}

/**
 * Apply every migration that has not been applied yet.
 *
 * @param {(msg: string) => void} log
 * @returns {Promise<{applied: string[], drifted: string[]}>}
 */
export async function runMigrations(log = console.log) {
  const migrations = await listMigrations();
  if (migrations.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);

  return withOwner(async (client) => {
    // Taken outside the per-migration transactions and released explicitly, so
    // it spans the whole run rather than one file.
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      await client.query(TRACKING_TABLE);
      const { rows } = await client.query(
        `select filename, checksum from public.schema_migrations`,
      );
      const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

      const done = [];
      const drifted = [];

      for (const migration of migrations) {
        const seen = applied.get(migration.filename);

        if (seen !== undefined) {
          // Already applied. If the file has changed since, the change is NOT
          // in the database — warn rather than fail, because the usual cause
          // is an edited comment and refusing to boot over that would be worse
          // than a loud log line for a system a guard depends on at 3am.
          if (seen !== migration.checksum) {
            drifted.push(migration.filename);
            log(`[migrate] WARNING: ${migration.filename} has changed since it was applied.`);
            log(`[migrate]          That change is NOT in the database. Add a new migration.`);
          }
          continue;
        }

        log(`[migrate] applying ${migration.filename} …`);
        await client.query("begin");
        try {
          await client.query(migration.sql);
          await client.query(
            `insert into public.schema_migrations (filename, checksum) values ($1, $2)`,
            [migration.filename, migration.checksum],
          );
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw new Error(`${migration.filename}: ${err.message}`);
        }
        done.push(migration.filename);
      }

      if (done.length === 0) log(`[migrate] up to date (${migrations.length} migrations)`);
      else log(`[migrate] applied ${done.length} of ${migrations.length}`);

      return { applied: done, drifted };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    }
  });
}

// Standalone invocation only. index.js imports runMigrations() instead.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. See README, 'Setup'.");
    process.exit(1);
  }
  try {
    await runMigrations();
    await closePool();
  } catch (err) {
    console.error(`\nmigration failed: ${err.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  }
}
