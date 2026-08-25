"use strict";

/* ============================================================================
   migrate.js — apply db/platform.sql then db/schema.sql.

     node server/migrate.js

   Both files are written to be re-runnable (`create ... if not exists`,
   `create or replace`), so this is safe against an existing database as well
   as a fresh one. It is what Render's deploy hook runs, and what you run by
   hand the first time against the external DATABASE_URL.

   The one caveat schema.sql already carries: residents.search_key is a
   generated column, so changing how names are normalised needs a migration
   rather than a re-run.

   Order is not negotiable — schema.sql references auth.users and auth.uid(),
   which platform.sql creates.
   ========================================================================= */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, withOwner } from "./db.js";

const DB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const FILES = ["platform.sql", "schema.sql"];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  for (const file of FILES) {
    const sql = await fs.readFile(path.join(DB_DIR, file), "utf8");
    process.stdout.write(`applying db/${file} … `);
    // One statement batch per file, inside pg's implicit transaction for a
    // multi-statement query: a syntax error part-way through rolls the whole
    // file back rather than leaving the schema half-applied.
    await withOwner((client) => client.query(sql));
    console.log("ok");
  }

  await closePool();
  console.log("Database is up to date.");
}

main().catch(async (err) => {
  console.error(`\nmigration failed: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
});
