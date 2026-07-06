// skills/dsc-scenario/tests/test-corrections.js
'use strict';
const assert = require('node:assert/strict');
const { checkSpecAnchor, deriveVolatility } = require('../lib/auth-providers.js');

// deriveVolatility: shape-derived, no stored enum.
assert.equal(deriveVolatility({ infraInvariant: true }), 'infra-invariant');
assert.equal(deriveVolatility({ specAnchor: { field: 'security', read: () => 1, holds: () => true, saw: 'x' } }), 'spec-divergence');
assert.equal(deriveVolatility({ basis: 'runtime-verified' }), 'platform-behavior');
// infraInvariant wins even if (nonsensically) an anchor is also present - flag is explicit.
assert.equal(deriveVolatility({ infraInvariant: true, specAnchor: {} }), 'infra-invariant');

// checkSpecAnchor: no anchor -> holds (nothing to watch).
assert.deepEqual(checkSpecAnchor(undefined, {}), { state: 'holds' });

// holds() true -> holds, carrying the read value as `now`.
{
  const anchor = { field: 'security', saw: 's', read: (ctx) => ctx.v, holds: (v) => v === 42 };
  assert.deepEqual(checkSpecAnchor(anchor, { v: 42 }), { state: 'holds', now: 42 });
}
// holds() false -> drifted, carrying `now`.
{
  const anchor = { field: 'security', saw: 's', read: (ctx) => ctx.v, holds: (v) => v === 42 };
  assert.deepEqual(checkSpecAnchor(anchor, { v: 7 }), { state: 'drifted', now: 7 });
}
// read() returns null -> drifted (cannot read the field -> fail toward re-verify).
{
  const anchor = { field: 'security', saw: 's', read: () => null, holds: () => true };
  assert.deepEqual(checkSpecAnchor(anchor, {}), { state: 'drifted', now: null });
}
// read() throws -> drifted, not a crash.
{
  const anchor = { field: 'security', saw: 's', read: () => { throw new Error('missing type file'); }, holds: () => true };
  assert.deepEqual(checkSpecAnchor(anchor, {}), { state: 'drifted', now: null });
}
// read() returns undefined -> drifted (== null catches undefined too; pins the enumerated branch).
{
  const anchor = { field: 'security', saw: 's', read: () => undefined, holds: () => true };
  assert.deepEqual(checkSpecAnchor(anchor, {}), { state: 'drifted', now: null });
}
// holds() throws -> drifted, not an uncaught crash (a malformed value funds toward re-verify).
{
  const anchor = { field: 'security', saw: 's', read: (ctx) => ctx.v, holds: () => { throw new Error('x'); } };
  assert.equal(checkSpecAnchor(anchor, { v: 42 }).state, 'drifted');
}

const { applyCorrections } = require('../lib/auth-providers.js');

// Build ctx once; these synthetic corrections read from ctx.opDoc, not the cache.
const baseArgs = { opDoc: { endpoint: { security: [{ scheme: 'BearerToken', scopes: ['SLAS_SERVICE_ADMIN'] }] } },
                   cacheRoot: '/unused', area: 'a', reference: 'r' };

// A matching, still-holding anchored correction -> one active note with derived volatility.
{
  const corrections = [{
    id: 'c1', match: () => true, claim: 'C', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-02', coords: {} }], scope: 'sandbox only',
    cite: 'https://developer.salesforce.com/x', provenance: 'p',
    specAnchor: {
      field: 'security', saw: 'BearerToken scopes all ~ SLAS_*_ADMIN',
      read: (ctx) => ctx.opDoc.endpoint.security,
      holds: (sec) => { const b = sec.find((s) => s.scheme === 'BearerToken'); return !!b && b.scopes.length > 0 && b.scopes.every((s) => /^SLAS_.*_ADMIN$/.test(s)); },
    },
  }];
  const notes = applyCorrections({ context: { area: 'a' }, corrections, ...baseArgs });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'active');
  assert.equal(notes[0].volatility, 'spec-divergence');
  assert.equal(notes[0].claim, 'C');
  assert.equal(notes[0].scope, 'sandbox only');
}

// Same correction, but the live security[] now names a non-admin gate -> drifted note with drift{}.
{
  const corrections = [{
    id: 'c1', match: () => true, claim: 'C', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-02', coords: {} }], scope: 's', cite: null, provenance: 'p',
    specAnchor: {
      field: 'security', saw: 'BearerToken scopes all ~ SLAS_*_ADMIN',
      read: (ctx) => ctx.opDoc.endpoint.security,
      holds: (sec) => { const b = sec.find((s) => s.scheme === 'BearerToken'); return !!b && b.scopes.length > 0 && b.scopes.every((s) => /^SLAS_.*_ADMIN$/.test(s)); },
    },
  }];
  const opDoc = { endpoint: { security: [{ scheme: 'BearerToken', scopes: ['CCDX_SBX_USER'] }] } };
  const notes = applyCorrections({ context: { area: 'a' }, corrections, ...baseArgs, opDoc });
  assert.equal(notes[0].status, 'drifted');
  assert.deepEqual(notes[0].drift.now, [{ scheme: 'BearerToken', scopes: ['CCDX_SBX_USER'] }]);
  assert.equal(notes[0].drift.field, 'security');
}

// Non-matching correction -> excluded entirely.
{
  const corrections = [{ id: 'x', match: () => false, claim: 'C', basis: 'doc-stated', cite: null, provenance: 'p' }];
  const notes = applyCorrections({ context: {}, corrections, ...baseArgs });
  assert.equal(notes.length, 0);
}

// Anchor-less correction that matches -> active platform-behavior note (no drift possible).
{
  const corrections = [{ id: 'am', match: () => true, claim: 'AM', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-02', coords: {} }], cite: null, provenance: 'p' }];
  const notes = applyCorrections({ context: {}, corrections, ...baseArgs });
  assert.equal(notes[0].status, 'active');
  assert.equal(notes[0].volatility, 'platform-behavior');
}

const { B2C_CORRECTIONS: REAL } = require('../lib/b2c-corrections.js');
const authAdmin = REAL.find((c) => c.id === 'auth-admin-sandbox-api-user');

// Both observed role-forms satisfy the anchor (documents the per-op variance found).
for (const scopes of [['SLAS_SERVICE_ADMIN'], ['SLAS_SERVICE_ADMIN', 'SLAS_ORGANIZATION_ADMIN']]) {
  const opDoc = { endpoint: { security: [{ scheme: 'BearerToken', scopes }] } };
  const notes = applyCorrections({
    context: { area: 'commerce_commerce-api', reference: 'auth-admin' },
    corrections: [authAdmin], opDoc, cacheRoot: '/unused', area: 'commerce_commerce-api', reference: 'auth-admin',
  });
  assert.equal(notes[0].status, 'active', `auth-admin holds for scopes ${scopes.join(',')}`);
}
// The real gate name -> drifted.
{
  const opDoc = { endpoint: { security: [{ scheme: 'BearerToken', scopes: ['CCDX_SBX_USER'] }] } };
  const notes = applyCorrections({
    context: { area: 'commerce_commerce-api', reference: 'auth-admin' },
    corrections: [authAdmin], opDoc, cacheRoot: '/unused', area: 'commerce_commerce-api', reference: 'auth-admin',
  });
  assert.equal(notes[0].status, 'drifted', 'auth-admin drifts when the spec names the real gate');
}
// The correction does NOT match an unrelated reference.
assert.equal(authAdmin.match({ area: 'commerce_commerce-api', reference: 'shopper-orders' }), false);

console.log('ok');
