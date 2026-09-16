// The Sunday Weekly Register Update as an email — shared by the weekly job
// (jobs.js, `node jobs.js weekly`) and the send-now route
// (routes/settings.js), so the two can never differ. The rows and their
// sentences come from weekly_register_rows() (migration 035); this file only
// lays them out: compose() as the email (counts and a link), document() as
// the Word document the centre manager forwards to head office (names,
// rooms and dates — attached only where the centre has turned that on,
// migration 052).

const { layout, textFooter } = require('./mail');
const { docx, DOCX_CONTENT_TYPE } = require('./docx');

const SECTIONS = ['Room updates', 'Resident absences', 'Updates from the weekend', 'Resident removals', 'Weekly register change'];

// The return covers Sunday night to Saturday night: `to` is the most recent
// Saturday strictly before todayIso, `from` is six days earlier. Anchoring
// to the most recent Saturday rather than "yesterday" means run on Sunday
// or any later day that week, it is the same week — so a Monday resend
// after a missed Sunday (node jobs.js weekly --force, README §5) sends the
// same return a Sunday run would have sent, not the wrong week.
// todayIso is the site's date, 'YYYY-MM-DD'.
function lastWeek(todayIso) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  // Days back to the most recent Saturday strictly before today: Sunday → 1,
  // Monday → 2, … Saturday → 7.
  const back = ((d.getUTCDay() + 1) % 7) || 7;
  const to = new Date(d); to.setUTCDate(to.getUTCDate() - back);
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - 6);
  return { from: iso(from), to: iso(to) };
}

function dayMonth(iso, withYear) {
  const d = new Date(`${iso}T00:00:00Z`);
  const opts = { day: 'numeric', month: 'long', timeZone: 'UTC' };
  if (withYear) opts.year = 'numeric';
  return d.toLocaleDateString('en-IE', opts);
}

// "Saturday 12 September 2026" — the document is read by people who write
// the same words by hand today, so it uses their full form.
function longDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// The two sections whose rows carry an approval status (migration 035): a
// span is 'approved', 'not approved' or 'partly approved'. Removals and room
// updates have no such notion, so they get a plain count.
const APPROVAL_SECTIONS = new Set(['Resident absences', 'Updates from the weekend']);

// The email body: counts and a link, never a resident name, room, date of
// birth, identity number or child marker (docs/GDPR.md, "What leaves by
// email"). The names go in the attached document, when the centre has
// turned that on — see document() below. rows only ever contributes numbers
// here: nothing from row.resident or row.line is read. `link` is built by
// the caller (the web tier has a request to build one from; the nightly job
// does not, and passes none), so when it is absent the email still sends,
// naming where the detail lives instead of a broken or relative link.
function compose({ siteName, from, to, rows, link, unsubscribe, attached = false }) {
  const name = siteName || 'CheckSteady';
  const title = `${name}: Weekly register update, ${dayMonth(from)} to ${dayMonth(to, true)}`;
  // The same five figures twice: as sentences for the plain part, and as
  // label/value/note for the house layout's table. One pass, so the two can
  // never disagree about a number.
  const table = [];
  const counts = SECTIONS.map((section) => {
    const inSection = rows.filter((r) => r.section === section);
    if (!APPROVAL_SECTIONS.has(section)) {
      table.push({ label: section, value: String(inSection.length) });
      return `${section}: ${inSection.length}`;
    }
    // "with nights not approved" describes the nights, not the span: a span
    // that is 'not approved' or only 'partly approved' both have at least
    // one unauthorised night and both call for the same look, but only the
    // first is fully "not approved" — the app records facts and never
    // decides, so the label must stay true for both. A zero count is
    // suppressed: a bare number then means nothing outstanding, and the
    // parenthetical appearing at all is itself the signal to look.
    const notApproved = inSection.filter((r) => r.status !== 'approved').length;
    table.push({
      label: section,
      value: String(inSection.length),
      note: notApproved ? `${notApproved} with nights not approved` : null,
    });
    return notApproved
      ? `${section}: ${inSection.length} (${notApproved} with nights not approved)`
      : `${section}: ${inSection.length}`;
  });
  const openLine = link ? `Open the app: ${link}` : null;
  const detail = 'The detail behind these counts — names, rooms and dates — is in the app ' +
    'under Admin → Reports, where it can also be downloaded as a spreadsheet.';
  const midnight = 'Nights are counted at midnight, site time. A night inside an authorised ' +
    'absence recorded in CheckSteady is approved; any other is not.';
  const attachedLine = attached ? 'The Weekly Register Update is attached as a Word document.' : null;
  const text = [title, counts.join('\n'), attachedLine, openLine, detail, midnight, textFooter(unsubscribe)].filter(Boolean).join('\n\n');
  const html = layout({
    siteName,
    heading: `Weekly register update, ${dayMonth(from)} to ${dayMonth(to, true)}`,
    paragraphs: attachedLine ? [attachedLine] : [],
    rows: table,
    cta: link ? { href: link, label: 'Open the weekly update' } : null,
    notes: [detail, midnight],
    unsubscribe,
    footer: attached ? 'The attached document names residents — treat it as you would the register itself.' : undefined,
  });
  return { subject: title, text, html };
}

// The Word document: the centre manager's Sunday layout, as she sends it to
// head office today, so she can review, edit and forward it rather than
// retype it. Headings in her order and case; one bullet per row, the row's
// own sentence; the absences she must act on carry her instruction and the
// yellow she uses. Names, rooms and dates are here on purpose — it is the
// document, not the email — and nothing the report does not already show
// (no date of birth, identity number or evacuation need).
const DOC_HEADINGS = [
  ['Room updates', 'Room Updates:'],
  ['Resident absences', 'Resident Absences:'],
  ['Updates from the weekend', 'Updates from the Weekend:'],
  ['Resident removals', 'Resident Removals:'],
  ['Weekly register change', 'Weekly Register Change:'],
];
function instruction(status) {
  if (status === 'not approved') return ' Please mark as unauthorised absence.';
  if (status === 'partly approved') return ' Please mark the nights not approved as unauthorised absence.';
  return '';
}
function document({ siteName, from, to, rows, generatedOn }) {
  const blocks = [
    { kind: 'title', text: 'Weekly Register Update' },
    { kind: 'subtitle', text: `${siteName || 'CheckSteady'} · Week ending ${longDate(to)}` },
    { kind: 'underline', text: `Updates for the period between ${longDate(from)} and ${longDate(to)}` },
  ];
  for (const [section, heading] of DOC_HEADINGS) {
    blocks.push({ kind: 'heading', text: heading });
    const inSection = rows.filter((r) => r.section === section);
    if (!inSection.length) { blocks.push({ kind: 'bullet', text: 'None.' }); continue; }
    for (const r of inSection) {
      const extra = instruction(r.status);
      blocks.push({ kind: 'bullet', text: `${r.line}${extra}`, highlight: !!extra });
    }
  }
  blocks.push({ kind: 'para', text:
    `Produced by CheckSteady on ${longDate(generatedOn)}. Nights are counted at midnight, site time. ` +
    'A night inside an authorised absence recorded in CheckSteady is approved; any other is not.' });
  return {
    filename: `Weekly-Register-Update-week-ending-${to}.docx`,
    buffer: docx(blocks),
    contentType: DOCX_CONTENT_TYPE,
  };
}

// The staff ticked to receive the report (migration 037): active
// supervisors and admins with weekly_report set, joined to auth.users for
// the address. Shared by the nightly job and the send-now route so the two
// can never resolve a different set of people. Takes a client rather than
// opening its own: the job runs as the database owner, the route under the
// caller's identity (db.withIdentity), and each needs its own connection.
// The role filter is belt and braces: profiles_weekly_report_not_guard
// (migration 037) already refuses the combination at write time, but this
// query is the actual security boundary for who gets emailed, so it stays
// true on its own — including against a tenant schema provisioned before
// that constraint existed.
//
// Returns `{ id, email }` — the id is what the per-person unsubscribe link
// is minted from (049).
async function recipients(client) {
  const { rows } = await client.query(
    `select p.id, u.email from profiles p join auth.users u on u.id = p.id
      where p.active and p.weekly_report and p.role in ('supervisor', 'admin') and u.email is not null`);
  return rows;
}

module.exports = { SECTIONS, lastWeek, compose, document, recipients };
