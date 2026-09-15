// The pure parts of lib/emailPrefs.js: the link and the headers. Run:
//   node test/emailPrefs.test.js
// The database parts are covered by test/api.test.js.
const assert = require('assert/strict');

const prefs = require('../lib/emailPrefs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`   ok  ${name}`); }

test('urlFor builds from PUBLIC_URL and carries slug, key and kind', () => {
  process.env.PUBLIC_URL = 'https://app.checksteady.com/';
  const url = prefs.urlFor({ slug: 'default', key: 'abc_-123', kind: 'weekly_report' });
  assert.equal(url, 'https://app.checksteady.com/unsubscribe?t=default&k=abc_-123&e=weekly_report');
});

test('urlFor is null with PUBLIC_URL unset — never a relative or invented link', () => {
  delete process.env.PUBLIC_URL;
  assert.equal(prefs.urlFor({ slug: 'default', key: 'k', kind: 'house_rules' }), null);
});

test('urlFor refuses a kind it does not know', () => {
  process.env.PUBLIC_URL = 'https://app.checksteady.com';
  assert.throws(() => prefs.urlFor({ slug: 'default', key: 'k', kind: 'marketing' }), /kind/);
});

test('headersFor gives both RFC 8058 headers for a link, and nothing for none', () => {
  assert.deepEqual(prefs.headersFor('https://x/unsubscribe?t=a&k=b&e=house_rules'), {
    'List-Unsubscribe': '<https://x/unsubscribe?t=a&k=b&e=house_rules>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  assert.deepEqual(prefs.headersFor(null), {});
});

test('KINDS names every kind the migration accepts, and only those', () => {
  assert.deepEqual(Object.keys(prefs.KINDS).sort(), ['house_rules', 'safeguarding_alert', 'weekly_report']);
  assert.equal(prefs.KINDS.weekly_report.tick, 'weekly_report');
  assert.equal(prefs.KINDS.house_rules.tick, null);
  assert.ok(prefs.isKind('house_rules') && !prefs.isKind('all') && !prefs.isKind(''));
});

delete process.env.PUBLIC_URL;

console.log(`\nPASS: ${passed} emailPrefs assertions.`);
