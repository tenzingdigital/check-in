// The overnight safeguarding alert's wording. Run:  node test/safeguardingAlert.test.js
/* ============================================================================

   This message is about a child, and it goes to an inbox. The one thing it
   must never do is carry a name — ec793da took resident names out of outbound
   mail on purpose, and a child is the worst case to undo that for. So the
   composer is tested directly rather than through a route, and the assertion
   that matters is about what is ABSENT.
   ========================================================================= */

const assert = require('assert/strict');
const { compose } = require('../lib/safeguardingAlert');

const concern = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 1, link: 'https://example.test' });
const many    = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 3, link: 'https://example.test' });
const nil     = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 0, link: 'https://example.test' });

assert.match(concern.subject, /1 to look at/, 'the subject carries the count');
assert.match(nil.subject, /nothing to report/, 'a clear night says so in the subject');
assert.notEqual(concern.subject, nil.subject,
  'the two subjects must differ, or a nightly nil trains people to filter the one that matters');

assert.match(concern.text, /1 child was away overnight/);
assert.match(many.text, /3 children were away overnight/, 'plural agrees');
assert.match(nil.text, /No children were away overnight/);

// The whole point. Nothing that could identify a resident.
for (const [label, msg] of [['concern', concern], ['nil', nil], ['many', many]]) {
  const body = msg.subject + '\n' + msg.text;
  for (const forbidden of [/date of birth/i, /\b\d{4}-\d{2}-\d{2}\b/, /room \d/i]) {
    assert.ok(!forbidden.test(body), `${label}: body must not carry ${forbidden}`);
  }
}
console.log('ok  the alert carries a count and never a name');

// Without a link (mail configured but PUBLIC_URL not) the message still makes
// sense rather than printing "undefined".
const noLink = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 2 });
assert.ok(!/undefined|null/.test(noLink.text), 'no stray undefined when there is no link');
assert.match(noLink.text, /Admin → Reports/, 'it still says where to look');
console.log('ok  degrades without a link');

// A site with no name configured must not send a message about "undefined".
const noName = compose({ siteName: '', night: '2026-09-11', count: 0 });
assert.match(noName.subject, /^CheckSteady:/, 'falls back to the product name');
console.log('ok  falls back when the site has no name');
