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

// The whole point. Nothing that could identify a resident — in EITHER part.
// The styled part is the same words in a table, never more of them, so the
// rule that matters is checked against both rather than the plain one only.
// The link is exempt from the ISO-date rule: ?from=…&to=… is the night this
// email is already about, in the subject, and names nobody.
for (const [label, msg] of [['concern', concern], ['nil', nil], ['many', many]]) {
  for (const [part, body] of [['text', msg.subject + '\n' + msg.text], ['html', msg.subject + '\n' + msg.html]]) {
    const prose = body.replace(/https:\/\/\S+/g, '');
    for (const forbidden of [/date of birth/i, /\b\d{4}-\d{2}-\d{2}\b/, /room \d/i]) {
      assert.ok(!forbidden.test(prose), `${label} (${part}): body must not carry ${forbidden}`);
    }
  }
}
console.log('ok  the alert carries a count and never a name');

// The styled part: escaped, self-contained, and no way to phone home. A
// remote image in a mail to a centre's staff is a read receipt for whoever
// hosts it, and this product's claim is that it does not watch people.
const nasty = compose({ siteName: 'Sla<ney> "Manor"', night: '2026-09-11', count: 1, link: 'https://example.test/admin.html' });
assert.ok(!/<ney>/.test(nasty.html), 'a site name is escaped, never markup');
assert.match(nasty.html, /Sla&lt;ney&gt;/, 'and it is still readable once escaped');
for (const [what, forbidden] of [['an image', /<img/i], ['a background image', /url\(/i], ['a script', /<script/i], ['a remote stylesheet', /<link\b/i]]) {
  assert.ok(!forbidden.test(nasty.html), `the styled part must not carry ${what}`);
}
console.log('ok  the styled part is escaped and phones nobody');

// The link goes to the night the email is about, not to a screen defaulting
// to the last seven days, and the button says which night that is.
const dated = compose({
  siteName: 'Slaney Manor', night: '2026-09-11', count: 2,
  link: 'https://example.test/admin.html?tab=reports&report=overnight&from=2026-09-11&to=2026-09-11',
});
assert.match(dated.html, /href="https:\/\/example\.test\/admin\.html\?tab=reports&amp;report=overnight&amp;from=2026-09-11&amp;to=2026-09-11"/,
  'the styled part links to the report and the night');
assert.match(dated.html, /Open the report for 11 September 2026/, 'the button names the night');
assert.match(dated.text, /from=2026-09-11/, 'the plain part carries the same link');

// An href is the one place a value becomes live, so a scheme this app would
// never build is dropped rather than rendered.
const spoofed = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 1, link: 'javascript:alert(1)' });
assert.ok(!/javascript:/i.test(spoofed.html), 'only an https link is ever rendered as a button');
console.log('ok  the link opens the night the email is about');

// Without a link (mail configured but PUBLIC_URL not) the message still makes
// sense rather than printing "undefined".
const noLink = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 2 });
assert.ok(!/undefined|null/.test(noLink.text), 'no stray undefined when there is no link');
assert.match(noLink.text, /Admin → Reports/, 'it still says where to look');
assert.ok(!/<a /.test(noLink.html), 'and the styled part shows no button rather than a dead one');
assert.match(noLink.html, /Admin → Reports/, 'which makes naming the screen the only way there');
console.log('ok  degrades without a link');

// A site with no name configured must not send a message about "undefined".
const noName = compose({ siteName: '', night: '2026-09-11', count: 0 });
assert.match(noName.subject, /^CheckSteady:/, 'falls back to the product name');
console.log('ok  falls back when the site has no name');

// The way out (049): the footer link in both parts, given one, and nowhere
// when none is given — the nil email goes out nightly too, so it needs it.
const withOut = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 1, link: 'https://example.test', unsubscribe: 'https://example.test/unsubscribe?t=default&k=k&e=safeguarding_alert' });
assert.ok(withOut.text.endsWith('To stop these emails: https://example.test/unsubscribe?t=default&k=k&e=safeguarding_alert'), 'the text ends with the way out');
assert.match(withOut.html, /Unsubscribe<\/a>/, 'and so does the html');
assert.doesNotMatch(nil.text, /nsubscribe/, 'no link when none is given');
console.log('ok  the way out is in both parts, given one, and absent without');
