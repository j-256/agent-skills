'use strict';

const assert = require('node:assert/strict');
const {
  narrowOperationScopes,
  combinePlanScopes,
  STANDARD_SHOPPER_SCOPES,
} = require('../../../shared/products/commerce-b2c/dedupe-scopes.js');

// narrowOperationScopes: bare wins when both bare and .rw appear in same op.
{
  assert.deepEqual(
    narrowOperationScopes(['sfcc.products', 'sfcc.products.rw']),
    ['sfcc.products'],
    'bare beats .rw in same op'
  );
}

// narrowOperationScopes: only .rw listed -> kept (no choice).
{
  assert.deepEqual(
    narrowOperationScopes(['sfcc.products.rw']),
    ['sfcc.products.rw'],
    '.rw kept when bare is absent'
  );
}

// narrowOperationScopes: only bare listed -> kept.
{
  assert.deepEqual(
    narrowOperationScopes(['sfcc.products']),
    ['sfcc.products'],
    'bare kept when .rw is absent'
  );
}

// narrowOperationScopes: meta-scope dropped when a specific scope it expands to is in the same op.
{
  assert.deepEqual(
    narrowOperationScopes(['sfcc.shopper-baskets-orders.rw', 'sfcc.shopper-standard']),
    ['sfcc.shopper-baskets-orders.rw'],
    'meta-scope dropped when a specific expansion member is co-listed'
  );
}

// narrowOperationScopes: meta-scope kept when no specific scope from its expansion is co-listed.
{
  assert.deepEqual(
    narrowOperationScopes(['sfcc.shopper-standard']),
    ['sfcc.shopper-standard'],
    'meta-scope kept when alone'
  );
  assert.deepEqual(
    narrowOperationScopes(['sfcc.shopper-standard', 'sfcc.session_bridge']),
    ['sfcc.shopper-standard', 'sfcc.session_bridge'],
    'meta-scope kept when only non-expansion scopes are co-listed'
  );
}

// narrowOperationScopes: empty input -> empty output.
{
  assert.deepEqual(narrowOperationScopes([]), []);
}

// combinePlanScopes: empty plan -> empty deduped, asMetaScope false.
{
  const r = combinePlanScopes([]);
  assert.deepEqual(r.deduped, []);
  assert.equal(r.asMetaScope, false);
}

// combinePlanScopes: cross-op dedup drops bare when .rw is independently in the union.
{
  const r = combinePlanScopes([
    ['sfcc.shopper-baskets-orders'],          // a read op
    ['sfcc.shopper-baskets-orders.rw'],       // a write op on same family
  ]);
  assert.deepEqual(r.deduped, ['sfcc.shopper-baskets-orders.rw']);
}

// combinePlanScopes: bare kept when .rw is NOT in the union.
{
  const r = combinePlanScopes([
    ['sfcc.shopper-products'],
    ['sfcc.shopper-categories'],
  ]);
  assert.deepEqual(r.deduped, ['sfcc.shopper-categories', 'sfcc.shopper-products']);
}

// combinePlanScopes: asMetaScope=true when union is a strict subset of STANDARD_SHOPPER_SCOPES.
{
  const r = combinePlanScopes([
    ['sfcc.shopper-baskets-orders.rw'],
    ['sfcc.shopper-products'],
  ]);
  assert.equal(r.asMetaScope, true,
    'union of {sfcc.shopper-baskets-orders.rw, sfcc.shopper-products} is in std list');
}

// combinePlanScopes: asMetaScope=false when any scope is outside STANDARD_SHOPPER_SCOPES.
{
  const r = combinePlanScopes([
    ['sfcc.shopper-baskets-orders.rw'],
    ['sfcc.session_bridge'],   // not in std list
  ]);
  assert.equal(r.asMetaScope, false);
}

// combinePlanScopes: output is sorted (stable presentation).
{
  const r = combinePlanScopes([
    ['sfcc.shopper-products'],
    ['sfcc.shopper-categories'],
    ['sfcc.shopper-baskets-orders.rw'],
  ]);
  assert.deepEqual(r.deduped, [...r.deduped].sort());
}

// STANDARD_SHOPPER_SCOPES: 20 entries; matches snapshot.
{
  assert.equal(STANDARD_SHOPPER_SCOPES.length, 20);
  assert.ok(STANDARD_SHOPPER_SCOPES.includes('sfcc.shopper-baskets-orders.rw'));
  assert.ok(STANDARD_SHOPPER_SCOPES.includes('sfcc.shopper-experience'));
  assert.ok(STANDARD_SHOPPER_SCOPES.includes('sfcc.shopper-availability'));
  assert.ok(STANDARD_SHOPPER_SCOPES.includes('sfcc.shopper-delivery-estimates'));
  // Constant order is deliberate (matches the guide's published order); spot-check.
  assert.equal(STANDARD_SHOPPER_SCOPES[0], 'sfcc.shopper-baskets-orders.rw');
}

// Composition: narrowOperationScopes per-op then combinePlanScopes across the plan.
// Mirrors the production-caller pipeline: spec-derived per-op scope lists ->
// per-op narrowing -> cross-op union+dedup. Locks in the contract that the two
// functions interact correctly when used together; a refactor that breaks the
// interaction is caught here even if the isolated unit tests still pass.
{
  const planRawScopes = [
    // Read op: spec lists bare AND .rw AND meta-scope; narrow drops .rw
    // (bare wins) and drops meta (specific co-listed) -> survives bare only.
    ['sfcc.shopper-baskets-orders', 'sfcc.shopper-baskets-orders.rw', 'sfcc.shopper-standard'],
    // Write op: spec lists only .rw; narrow keeps .rw.
    ['sfcc.shopper-baskets-orders.rw'],
    // Unrelated read op on a different family: narrow keeps bare.
    ['sfcc.shopper-products'],
  ];
  const perOp = planRawScopes.map(narrowOperationScopes);
  // Sanity-check the per-op intermediates so a regression in either function
  // surfaces here, not just in the cross-op output.
  assert.deepEqual(perOp[0], ['sfcc.shopper-baskets-orders']);
  assert.deepEqual(perOp[1], ['sfcc.shopper-baskets-orders.rw']);
  assert.deepEqual(perOp[2], ['sfcc.shopper-products']);
  // Cross-op: union has both bare and .rw on shopper-baskets-orders ->
  // combinePlanScopes drops bare. Final set is the .rw plus the unrelated bare.
  const r = combinePlanScopes(perOp);
  assert.deepEqual(r.deduped, ['sfcc.shopper-baskets-orders.rw', 'sfcc.shopper-products']);
  // Both survivors are in STANDARD_SHOPPER_SCOPES, so the meta-scope alternative is suggested.
  assert.equal(r.asMetaScope, true);
}

console.log('ok');
