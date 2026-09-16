// lib/nightlyEmail.js — the one nightly email: "Tonight at <site>".
//
// The House Rules reminder (032) and the overnight safeguarding alert (041)
// were two messages at two times to two audiences, and a manager reading
// both at breakfast still had nothing that said a mother had signed out and
// left her children. This is one message, after the 00:30 snapshot, to the
// staff ticked for the safeguarding alert, with four sections in a fixed
// order — each a count and a link:
//
//   Children on site without a guardian        overnight_guardian_gaps (054)
//   Children away overnight without authorisation   overnight_safeguarding_count() (041)
//   Check-ins recorded while signed out        checkin_conflict_count() (054)
//   At the House Rules figures                 the thresholds (032)
//
// Counts and links, never a name. ec793da took resident names out of
// outbound mail and this email keeps to that. Every name is one tap away,
// behind the login, on a view the app records: the guardian-gap link opens
// the named "Children on site without a guardian" report for that night.
//
// Sent when any count is non-zero and every Sunday regardless, so a week's
// silence is never mistaken for a job that stopped. job_runs records every
// run either way; the nil email is the convenience, not the evidence.
//
// Shaped as lib/safeguardingAlert.js is, so there is one pattern for "a
// staff member receives a thing" rather than four.

const { layout, textFooter } = require('./mail');
const { dayMonth } = require('./safeguardingAlert');

// The four sections, in the order the email lists them. `label` is the
// row; `open` is the button's noun when this is the first section with
// something in it ("Open Absences"); `count` and `link` name the keys the
// caller passes.
const SECTIONS = Object.freeze([
  { count: 'guardian_gaps', link: 'guardianGaps', label: 'Children on site without a guardian',          open: 'Children on site without a guardian' },
  { count: 'children_away', link: 'overnight',    label: 'Children away overnight without authorisation', open: 'Absent overnight' },
  { count: 'conflicts',     link: 'conflicts',    label: 'Check-ins recorded while signed out',           open: 'Check-ins recorded while signed out' },
  { count: 'at_figures',    link: 'absences',     label: 'At the House Rules figures',                    open: 'Absences' },
]);

function compose({ siteName, night, counts = {}, links = {}, unsubscribe }) {
  const name = siteName || 'CheckSteady';
  const when = night ? dayMonth(night) : null;
  const rows = SECTIONS.map((s) => ({ ...s, n: Number(counts[s.count]) || 0, href: links[s.link] || null }));
  const total = rows.reduce((sum, r) => sum + r.n, 0);

  const heading = when ? `Tonight at ${name}, ${when}` : `Tonight at ${name}`;
  const summary = total
    ? `${total} thing${total === 1 ? '' : 's'} to look at from the register at midnight. Each line below opens the page that has the detail.`
    : 'Nothing to report from the register at midnight. This message is sent every Sunday so that a silent week is never mistaken for a check that did not run.';
  const how = 'Nights are counted at midnight, site time, from the In & out register and the daily check-in. This is a record of what the centre has, not a judgement that anything is wrong.';

  // The button goes to the first section with something in it; the other
  // links follow as plain URLs so nothing is more than one tap away in a
  // client that shows the HTML. The plain-text part lists all four the
  // same way, and is the whole message on its own.
  const first = rows.find((r) => r.n > 0 && r.href);
  const others = rows.filter((r) => r !== first && r.href).map((r) => `${r.label}: ${r.href}`);

  return {
    subject: total ? `${name}: tonight — ${total} to look at` : `${name}: tonight — nothing to report`,
    text: [
      heading,
      summary,
      rows.map((r) => `${r.label}: ${r.n}${r.href ? ` — ${r.href}` : ''}`).join('\n'),
      how,
      textFooter(unsubscribe),
    ].filter(Boolean).join('\n\n'),
    html: layout({
      siteName, heading,
      figure: total
        ? { value: String(total), label: `to look at from the register at midnight`, tone: 'attention' }
        : { value: 'None', label: 'nothing to report from the register at midnight', tone: 'clear' },
      paragraphs: [summary],
      rows: rows.map((r) => ({ label: r.label, value: String(r.n) })),
      cta: first ? { href: first.href, label: `Open ${first.open}` } : null,
      notes: [...(others.length ? [others.join(' · ')] : []), how],
      unsubscribe,
    }),
  };
}

module.exports = { compose, SECTIONS };
