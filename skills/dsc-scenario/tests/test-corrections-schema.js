// skills/dsc-scenario/tests/test-corrections-schema.js
'use strict';
const assert = require('node:assert/strict');
const { B2C_CORRECTIONS, assertCorrectionsWellFormed } = require('../lib/b2c-corrections.js');
const { applyCorrections, deriveVolatility } = require('../lib/auth-providers.js');

// The real registry is well-formed (this also runs at module load, but assert here too).
assert.doesNotThrow(() => assertCorrectionsWellFormed(B2C_CORRECTIONS));

// Exactly the two intended citizens are present, by id.
const ids = B2C_CORRECTIONS.map((c) => c.id).sort();
assert.deepEqual(ids, ['auth-admin-sandbox-api-user', 'ocapi-create-body-masked-number'].sort());

// The validator REJECTS each conditional-required violation.
const wellFormed = () => ({
  id: 'x', match: () => true, claim: 'c', basis: 'runtime-verified',
  verifiedOn: [{ date: '2026-07-02', coords: {} }], scope: 's', provenance: 'p', cite: null,
  specAnchor: { field: 'security', saw: 's', read: () => [], holds: () => true },
});
// runtime-verified with no verifiedOn -> reject.
assert.throws(() => assertCorrectionsWellFormed([{ ...wellFormed(), verifiedOn: [] }]), /verifiedOn/i);
// specAnchor present but no scope bounds -> reject.
assert.throws(() => assertCorrectionsWellFormed([{ ...wellFormed(), scope: undefined }]), /scope/i);
// specAnchor with a non-function read -> reject.
{
  const bad = wellFormed(); bad.specAnchor = { field: 'f', saw: 's', read: 'nope', holds: () => true };
  assert.throws(() => assertCorrectionsWellFormed([bad]), /read/i);
}
// missing cite key entirely (not even null) -> reject.
{
  const bad = wellFormed(); delete bad.cite;
  assert.throws(() => assertCorrectionsWellFormed([bad]), /cite/i);
}
// bad basis enum -> reject.
assert.throws(() => assertCorrectionsWellFormed([{ ...wellFormed(), basis: 'guessed' }]), /basis/i);

// Both citizens derive spec-divergence (both are anchored).
for (const c of B2C_CORRECTIONS) assert.equal(deriveVolatility(c), 'spec-divergence');

console.log('ok');
