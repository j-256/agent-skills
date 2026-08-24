'use strict';

const STANDARD_SHOPPER_SCOPES = [
  'sfcc.shopper-baskets-orders.rw',
  'sfcc.shopper-categories',
  'sfcc.shopper-customers.login',
  'sfcc.shopper-customers.register',
  'sfcc.shopper-gift-certificates',
  'sfcc.shopper-myaccount.addresses.rw',
  'sfcc.shopper-myaccount.baskets',
  'sfcc.shopper-myaccount.orders',
  'sfcc.shopper-myaccount.paymentinstruments.rw',
  'sfcc.shopper-myaccount.productlists.rw',
  'sfcc.shopper-myaccount.rw',
  'sfcc.shopper-configurations',
  'sfcc.shopper-product-search',
  'sfcc.shopper-productlists',
  'sfcc.shopper-products',
  'sfcc.shopper-promotions',
  'sfcc.shopper-stores',
  'sfcc.shopper-experience',
  'sfcc.shopper-availability',
  'sfcc.shopper-delivery-estimates',
];
// Source: https://developer.salesforce.com/docs/commerce/commerce-api/guide/standard-shopper-scope.html
// Snapshot: 2026-05-29. Drift detected by test/test-scope-meta-fresh.js.

const STD_SET = new Set(STANDARD_SHOPPER_SCOPES);

// Narrow ONE operation's accepted-scope OR-list to least-privilege.
// SCAPI specs list multiple scopes per operation as alternatives (any one
// suffices). For reads, both bare S and S.rw are listed because S.rw is a
// superset that also passes; the spec is telling us either works. Bare
// is the less-privileged of the two, so we keep bare when both appear.
// Likewise, sfcc.shopper-standard is dropped when a specific scope it
// expands to is in the same list (specific is narrower than the meta).
function narrowOperationScopes(operationScopes) {
  const inputSet = new Set(operationScopes);
  return operationScopes.filter((s) => {
    if (s.endsWith('.rw') && inputSet.has(s.slice(0, -3))) return false;
    if (s === 'sfcc.shopper-standard') {
      const otherInExpansion = [...inputSet].some((x) => x !== s && STD_SET.has(x));
      if (otherInExpansion) return false;
    }
    return true;
  });
}

// Combine per-operation narrowed picks into the plan's scope set.
// Different direction from narrowOperationScopes: when one op picked
// bare S (a read) and another picked S.rw (a write on the same family),
// the union has both. S.rw subsumes reads, so configuring both on the
// client is redundant -- drop the bare. asMetaScope flags whether the
// resulting set is fully covered by sfcc.shopper-standard's expansion.
function combinePlanScopes(perOpScopes) {
  const union = new Set();
  for (const list of perOpScopes) for (const s of list) union.add(s);
  const deduped = [...union]
    .filter((s) => s.endsWith('.rw') || !union.has(`${s}.rw`))
    .sort();
  const asMetaScope = deduped.length > 0 && deduped.every((s) => STD_SET.has(s));
  return { deduped, asMetaScope };
}

module.exports = { narrowOperationScopes, combinePlanScopes, STANDARD_SHOPPER_SCOPES };
