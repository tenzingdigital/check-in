// lib/safeguardingAlert.js — the nightly overnight safeguarding alert.
//
// An under-18 away overnight with no authorised absence recorded is invisible
// everywhere else in this app: v_resident_compliance evaluates 'exempt'
// before everything, so a child never has required_today true, never appears
// under Not seen, and never reaches attention_list(). This is the one thing
// that says it out loud, and it says it to a person rather than to a screen
// nobody is looking at after midnight.
//
// Counts and a link, never a name. ec793da took resident names out of
// outbound mail deliberately and 037 moved recipients to staff who have a
// login; a child is the worst case to undo either for. The names are one tap
// away, behind that login, on a view note_view() records.
//
// Shaped to mirror lib/weeklyReport.js, so there is one pattern for "a staff
// member receives a thing" rather than two.

function dayMonth(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

// The subject differs between "nothing to report" and "something to look at".
// A nil message was asked for — it is evidence the check ran — but an
// identical email arriving every night at 00:30 is filtered to a folder
// within a fortnight, and then the one that matters is filtered with it. The
// count in the subject is what keeps it readable in a list. job_runs records
// every run either way, so the nil email is a convenience and not the only
// evidence the check happened.
function compose({ siteName, night, count, link }) {
  const name = siteName || 'CheckSteady';
  const when = dayMonth(night);

  if (!count) {
    return {
      subject: `${name}: overnight safeguarding check, ${when} — nothing to report`,
      text: [
        `${name}: overnight safeguarding check, ${when}`,
        'No children were away overnight without an authorised absence.',
        'This message is sent every night so that a silent one is never mistaken for a check that did not run.',
      ].join('\n\n'),
    };
  }

  const people = count === 1 ? '1 child was' : `${count} children were`;
  return {
    subject: `${name}: overnight safeguarding check, ${when} — ${count} to look at`,
    text: [
      `${name}: overnight safeguarding check, ${when}`,
      `${people} away overnight with no authorised absence recorded.`,
      link ? `Open the app: ${link}` : null,
      'The detail — names, rooms and times — is in the app under Admin → Reports, Absent overnight.',
      'Nights are counted at midnight, site time, from the In & out register. A night inside an authorised absence recorded in CheckSteady is authorised; any other is not. This is a record of what the centre has, not a judgement that anything is wrong.',
    ].filter(Boolean).join('\n\n'),
  };
}

// The staff ticked to receive it (migration 041): active supervisors and
// admins with safeguarding_alert set. The role filter is belt and braces —
// profiles_safeguarding_alert_not_guard already refuses the combination at
// write time — but this query is the actual boundary for who gets emailed,
// so it stays true on its own, including against a tenant schema provisioned
// before that constraint existed.
async function recipients(client) {
  const { rows } = await client.query(
    `select u.email from profiles p join auth.users u on u.id = p.id
      where p.active and p.safeguarding_alert and p.role in ('supervisor', 'admin') and u.email is not null`);
  return rows.map((r) => r.email);
}

module.exports = { compose, recipients };
