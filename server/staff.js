"use strict";

/* ============================================================================
   staff.js — account administration.

   This replaces the Supabase dashboard's Authentication → Users screen, which
   is where staff accounts used to be created. Run it from a machine that can
   reach the database (Render → your service → Shell, or locally with the
   external DATABASE_URL):

     node server/staff.js list
     node server/staff.js add gina@hut.example "Gina Guard" guard
     node server/staff.js passwd gina@hut.example
     node server/staff.js disable gina@hut.example
     node server/staff.js enable  gina@hut.example

   `add` and `passwd` prompt for the password rather than taking it as an
   argument, so it never lands in shell history, in `ps` output, or in Render's
   command log.

   Deletion is deliberately not offered. gate_events.guard_id and
   checkin_events.guard_id are ON DELETE RESTRICT, so the database refuses to
   erase the identity behind a historical audit trail — `disable` is the
   supported way to revoke access, and it takes effect on the next request
   because sessionFromToken() joins profiles.active on every call.
   ========================================================================= */

import readline from "node:readline";
import { closePool, withOwner } from "./db.js";

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => { rl.close(); resolve(a); });

    // Suppress the echo so a shoulder-surfer in the hut does not read the
    // password off the screen.
    process.stdout.write(question);
    rl.output.write = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readPassword() {
  const first = await ask("Password (min 12 characters): ", { hidden: true });
  const again = await ask("Repeat: ", { hidden: true });
  if (first !== again) throw new Error("Passwords do not match.");
  if (first.length < 12) throw new Error("Password must be at least 12 characters.");
  return first;
}

const COMMANDS = {
  async list() {
    const { rows } = await withOwner((c) =>
      c.query(
        `select u.email, p.full_name, p.role, p.active, u.last_sign_in_at
           from public.profiles p join auth.users u on u.id = p.id
          order by p.active desc, p.role, p.full_name`,
      ),
    );
    if (!rows.length) return console.log("No staff accounts yet. Add one with: node server/staff.js add …");
    for (const r of rows) {
      const seen = r.last_sign_in_at ? new Date(r.last_sign_in_at).toISOString().slice(0, 16).replace("T", " ") : "never";
      console.log(
        `${r.active ? " " : "✗"} ${r.email.padEnd(32)} ${r.full_name.padEnd(24)} ${r.role.padEnd(11)} last sign-in ${seen}`,
      );
    }
  },

  async add(email, fullName, role = "guard") {
    if (!email || !fullName) throw new Error('usage: add <email> "<full name>" [guard|supervisor|admin]');
    const password = await readPassword();
    const { rows } = await withOwner((c) =>
      c.query(`select auth.create_user($1, $2, $3, $4) as id`, [email, password, fullName, role]),
    );
    console.log(`Created ${email} as ${role} (${rows[0].id}). The profiles row was created by trigger.`);
  },

  async passwd(email) {
    if (!email) throw new Error("usage: passwd <email>");
    const password = await readPassword();
    const { rows } = await withOwner((c) => c.query(`select auth.set_password($1, $2) as ok`, [email, password]));
    if (!rows[0].ok) throw new Error(`No account with email ${email}`);
    console.log(`Password changed for ${email}. Every existing session for that account has been ended.`);
  },

  async disable(email) { await setActive(email, false); },
  async enable(email)  { await setActive(email, true);  },
};

async function setActive(email, active) {
  if (!email) throw new Error(`usage: ${active ? "enable" : "disable"} <email>`);
  const { rows } = await withOwner(async (c) => {
    const res = await c.query(
      `update public.profiles p set active = $2
         from auth.users u where u.id = p.id and lower(u.email) = lower($1)
       returning p.id`,
      [email, active],
    );
    // Disabling ends the account's sessions immediately rather than waiting
    // for the next request to notice. Both paths work; doing both means
    // "revoked" is true even if the profiles join is ever loosened.
    if (res.rows[0] && !active) {
      await c.query(`delete from auth.sessions where user_id = $1`, [res.rows[0].id]);
    }
    return res;
  });
  if (!rows[0]) throw new Error(`No account with email ${email}`);
  console.log(`${email} is now ${active ? "active" : "disabled"}.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`usage: node server/staff.js <${Object.keys(COMMANDS).join("|")}> [args]`);
    process.exit(2);
  }
  try {
    await fn(...args);
  } catch (err) {
    console.error(`error: ${err.message}`);
    await closePool().catch(() => {});
    process.exit(1);
  }
  await closePool();
}

main();
