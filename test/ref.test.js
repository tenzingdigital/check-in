// The resident reference helper. Run:  node test/ref.test.js
/* ============================================================================

   A reference is stored as an integer and shown zero-padded, so the two
   directions have to agree: whatever a person reads off a record or an
   export has to resolve back to the same row when they type it into a
   spreadsheet. The padding is cosmetic; the parsing is load-bearing, because
   a reference that fails to resolve becomes an import error and one that
   resolves WRONGLY updates the wrong resident.
   ========================================================================= */

const assert = require('assert/strict');
const { formatRef, parseRef } = require('../lib/ref');

assert.equal(formatRef(1), '0001');
assert.equal(formatRef(142), '0142');
assert.equal(formatRef(1034), '1034');
assert.equal(formatRef(10345), '10345', 'past four digits it simply grows');
assert.equal(formatRef(null), '');
assert.equal(formatRef(undefined), '');
console.log('ok  formatting');

// Every way a person might write the same reference resolves to one row.
for (const written of ['142', '0142', '00142', ' 142 ', '0142 ']) {
  assert.equal(parseRef(written), 142, `parseRef(${JSON.stringify(written)})`);
}
assert.equal(parseRef(142), 142, 'a number passes through');
console.log('ok  every spelling resolves to one row');

// Anything that is not a reference must be null, never 0 and never NaN —
// both would be truthy-adjacent bugs that match the wrong thing or insert.
for (const bad of ['', '  ', 'abc', '12a', '1.5', '-3', '0', '000', null, undefined, {}, []]) {
  assert.equal(parseRef(bad), null, `parseRef(${JSON.stringify(bad)}) is null`);
}
console.log('ok  a non-reference is null, not zero');
