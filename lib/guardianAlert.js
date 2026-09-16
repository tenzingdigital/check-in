// lib/guardianAlert.js — the 22:00 alert: children on site with no guardian.
//
// A household whose children are on site while every guardian is signed OUT
// at the gate, with no supervision arrangement recorded, is the one state in
// this app that a count cannot serve: at 22:00 a manager has to go to a door,
// and needs to know which door. So this is the one email that names
// residents in its body — the household, the children on site (first name
// and age), the guardians off site and since when, the room — and it goes
// only to the staff ticked for the safeguarding alert: supervisors and
// admins with a login, the people whose duty it is to act. docs/GDPR.md
// says so. ec793da took names out of outbound mail and this is the
// deliberate, single exception; the nightly email (lib/nightlyEmail.js)
// stays counts and links.
//
// It says what the register recorded and nothing more. A guardian off site
// with children on site is a fact the manager judges — there may be a
// paper Appendix 5 form on file that nobody has entered yet — so the copy
// states the register and points at Families, where a supervisor records
// the arrangement that makes the fact go away.
//
// Shaped as lib/safeguardingAlert.js is, so a staff member receives one
// kind of thing from this app, not several.

const { layout, textFooter } = require('./mail');

const FOOTER = 'This email names residents because it needs acting on tonight — treat it as you would the register itself.';

// The clock the email quotes is the moment it was composed, site time, so a
// reader who opens it at 23:10 knows the register may have moved since.
function clock(timeZone, at = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  }
}

// `gaps` are the rows of guardian_gaps_now(): household_label, room_labels,
// children ("Gil (7), Gwen (4)"), guardians_out ("Gia Gapfixture (out since
// 19:40)"), first_out_at. `timeZone` is the site's, for the "as it stands
// at" clock; unset falls back to the process clock.
function compose({ siteName, gaps = [], link, unsubscribe, timeZone, now }) {
  const name = siteName || 'CheckSteady';
  const n = gaps.length;
  const heading = `Children on site without a guardian — ${n} household${n === 1 ? '' : 's'}`;
  const asOf = `This is the register as it stands at ${clock(timeZone, now)}; a paper Appendix 5 form on file is not in the app until a supervisor records it.`;

  // One block per household: where, who is here, who is not, and that
  // nothing is recorded to cover it. The three lines are the same in both
  // parts so a text-only client loses only the styling.
  const blocks = gaps.map((g) => ({
    title: [g.household_label, g.room_labels].filter(Boolean).join(' · '),
    lines: [
      `Children on site: ${g.children || '—'}`,
      `Guardians off site: ${g.guardians_out || '—'}`,
      'No supervision arrangement recorded.',
    ],
  }));

  return {
    subject: `${name}: children on site without a guardian — ${n} household${n === 1 ? '' : 's'}`,
    text: [
      `${name}: ${heading}`,
      ...blocks.map((b) => [b.title, ...b.lines].join('\n')),
      link ? `Open Families: ${link}` : null,
      asOf,
      FOOTER,
      textFooter(unsubscribe),
    ].filter(Boolean).join('\n\n'),
    html: layout({
      siteName, heading,
      // layout() has no block element, and one is not worth adding for a
      // single email: each household is its heading line then its three
      // facts, as paragraphs, in order.
      paragraphs: blocks.flatMap((b) => [b.title, ...b.lines]),
      cta: link ? { href: link, label: 'Open Families' } : null,
      notes: [asOf],
      unsubscribe,
      footer: FOOTER,
    }),
  };
}

module.exports = { compose, FOOTER };
