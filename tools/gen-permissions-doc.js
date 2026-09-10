#!/usr/bin/env node
// tools/gen-permissions-doc.js — write docs/PERMISSIONS.md from test/permissions.js.
//
//   node tools/gen-permissions-doc.js          rewrite the document
//   node tools/gen-permissions-doc.js --check  exit 1 if the document is stale
//
// The matrix lives in the test so the HTTP suite can hold the server to it;
// the document is generated from the same rows so the two cannot disagree.
// check.sh runs the --check form.

const fs = require('fs');
const path = require('path');
const rows = require('../test/permissions');
const { ROLES, expectFor } = rows;

const OUT = path.join(__dirname, '..', 'docs', 'PERMISSIONS.md');

const SYMBOL = { allow: '✓', deny: '✗', unauth: '—', hidden: 'hidden' };
const HEAD = ['Logged out', 'Guard', 'Supervisor', 'Admin', 'Platform admin'];

function table(area) {
  const lines = [
    `| What | ${HEAD.join(' | ')} |`,
    `|---|${HEAD.map(() => ':---:').join('|')}|`,
  ];
  for (const r of rows.filter((x) => x.area === area)) {
    const cells = ROLES.map((role) => SYMBOL[expectFor(r, role)]);
    const name = r.note ? `${r.name}<br><small>${r.note}</small>` : r.name;
    lines.push(`| ${name}<br><code>${r.method} ${r.path({ residentId: ':id', buildingId: ':id', roomId: ':id', rollCallId: ':id', staffId: ':id', tenantId: ':id', absenceWindowId: ':id', today: 'DATE' }).replace(/\?.*$/, '')}</code> | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

const areas = [...new Set(rows.map((r) => r.area))];

const doc = `# Permissions — who may do what

*Generated from \`test/permissions.js\` by \`tools/gen-permissions-doc.js\`. Do not
edit by hand: change the matrix, regenerate, and the HTTP suite will hold the
server to the new row. \`./check.sh\` fails if this file is stale.*

Four roles, one site each: a **guard** records at the gate and on the
register; a **supervisor** also manages residents, buildings and reports; an
**admin** also manages staff, settings, and a resident's rights (export,
erasure) and reads the access log. A **platform admin** is an admin of their
own site who may also provision and close centres; they see no other centre's
residents. Someone **logged out** can ask for a password-reset link and
nothing else.

Legend: ✓ allowed · ✗ refused (403) · — must log in first (401) · hidden
(404: the row policy makes the record not exist for that role). "Allowed"
means the role is not the reason a request would fail; it may still fail
validation.

${areas.map((a) => `## ${a}\n\n${table(a)}`).join('\n\n')}

## Field-level rules

These are not per-request permissions but per-column ones, enforced in the
database by which view or table a role can read. The SQL suite
(\`test/acceptance.sql\`) proves each.

| Data | Guard | Supervisor | Admin |
|---|:---:|:---:|:---:|
| Name, age, presence, register state | ✓ | ✓ | ✓ |
| Date of birth | ✗ (a view carries age only) | ✓ | ✓ |
| Identity document number | Detail sheet only, never a list; searchable | same | same |
| Room | ✓ | ✓ | ✓ |
| Evacuation need | Roll call, evacuation list and occupancy only; never the gate cards | same | same |
| Household | ✓ | ✓ | ✓ |
| Audit trail (who changed what) | ✗ | ✗ | ✓ |
| Access log (who viewed whom) | ✗ | ✗ | ✓ |
| Login attempts, countries, risk | ✗ | ✗ | ✗ (platform only, in SQL) |
| Another centre's anything | ✗ | ✗ | ✗ |

## Where each rule is enforced

* **Row policies and \`SECURITY DEFINER\` functions in Postgres** carry every
  rule about residents, events, buildings, roll calls, reports, settings and
  staff. A request runs as the \`authenticated\` role inside the caller's own
  schema with their user id set on the transaction; the route cannot bypass
  the policy because it holds no other credential.
* **The route** turns a refusal (\`42501\`) into a 403 with the message the
  function author wrote, and checks the two things the database cannot see:
  the platform-admin flag for organisation routes, and an administrator
  disabling or demoting themselves.
* **The session** decides logged-in or not (401) before any route runs.
`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== doc) {
    console.error('docs/PERMISSIONS.md is stale: run node tools/gen-permissions-doc.js');
    process.exit(1);
  }
  console.log('docs/PERMISSIONS.md matches test/permissions.js');
} else {
  fs.writeFileSync(OUT, doc);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${rows.length} rows)`);
}
