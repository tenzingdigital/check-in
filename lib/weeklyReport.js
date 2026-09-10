// The Sunday Weekly Register Update as an email — shared by the nightly job
// (jobs.js) and the send-now route (routes/settings.js), so the two can
// never differ. The rows and their sentences come from
// weekly_register_rows() (migration 035); this file only lays them out.

const SECTIONS = ['Resident absences', 'Updates from the weekend', 'Resident removals', 'Room updates'];

// The week that ended last night: the previous Sunday night through
// Saturday night, as nights. todayIso is the site's date, 'YYYY-MM-DD'.
function lastWeek(todayIso) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  const to = new Date(d); to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(d); from.setUTCDate(from.getUTCDate() - 7);
  return { from: iso(from), to: iso(to) };
}

function dayMonth(iso, withYear) {
  const d = new Date(`${iso}T00:00:00Z`);
  const opts = { day: 'numeric', month: 'long', timeZone: 'UTC' };
  if (withYear) opts.year = 'numeric';
  return d.toLocaleDateString('en-IE', opts);
}

// The two sections whose rows carry an approval status (migration 035): a
// span is 'approved', 'not approved' or 'partly approved'. Removals and room
// updates have no such notion, so they get a plain count.
const APPROVAL_SECTIONS = new Set(['Resident absences', 'Updates from the weekend']);

// Counts and a link, never a resident name, room, date of birth, identity
// number or child marker — that is the whole point of this function (see
// docs/GDPR.md, "What leaves by email"). rows only ever contributes numbers
// here: nothing from row.resident or row.line is read. `link` is built by
// the caller (the web tier has a request to build one from; the nightly job
// does not, and passes none), so when it is absent the email still sends,
// naming where the detail lives instead of a broken or relative link.
function compose({ siteName, from, to, rows, link }) {
  const name = siteName || 'CheckSteady';
  const title = `${name}: Weekly register update, ${dayMonth(from)} to ${dayMonth(to, true)}`;
  const counts = SECTIONS.map((section) => {
    const inSection = rows.filter((r) => r.section === section);
    if (!APPROVAL_SECTIONS.has(section)) return `${section}: ${inSection.length}`;
    const notApproved = inSection.filter((r) => r.status !== 'approved').length;
    return `${section}: ${inSection.length} (${notApproved} not approved by management)`;
  });
  const openLine = link ? `Open the report in the app: ${link}` : null;
  const detail = 'The detail behind these counts — names, rooms and dates — is in the app ' +
    'under Admin → Reports, where it can also be downloaded as a spreadsheet.';
  const midnight = 'Nights are counted at midnight, site time. An absence inside an authorised ' +
    'absence recorded in CheckSteady is approved; any other is not.';
  const text = [title, counts.join('\n'), openLine, detail, midnight].filter(Boolean).join('\n\n');
  return { subject: title, text };
}

// The staff ticked to receive the report (migration 037): active
// supervisors and admins with weekly_report set, joined to auth.users for
// the address. Shared by the nightly job and the send-now route so the two
// can never resolve a different set of people. Takes a client rather than
// opening its own: the job runs as the database owner, the route under the
// caller's identity (db.withIdentity), and each needs its own connection.
async function recipients(client) {
  const { rows } = await client.query(
    `select u.email from profiles p join auth.users u on u.id = p.id
      where p.active and p.weekly_report and u.email is not null`);
  return rows.map((r) => r.email);
}

module.exports = { SECTIONS, lastWeek, compose, recipients };
