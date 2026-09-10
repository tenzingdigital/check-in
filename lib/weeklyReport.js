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

function compose({ siteName, from, to, rows }) {
  const name = siteName || 'CheckSteady';
  const title = `${name}: Weekly register update, ${dayMonth(from)} to ${dayMonth(to, true)}`;
  const parts = SECTIONS.map((section) => {
    const lines = rows.filter((r) => r.section === section).map((r) => `- ${r.line}`);
    return `${section}\n${lines.length ? lines.join('\n') : '(none)'}`;
  });
  const text = `${title}\n\n${parts.join('\n\n')}\n\n` +
    'Nights are counted at midnight, site time. An absence inside an authorised absence ' +
    'recorded in CheckSteady is approved; any other is not. The full report, printable and ' +
    'as CSV, is under Admin → Reports.';
  return { subject: title, text };
}

module.exports = { SECTIONS, lastWeek, compose };
