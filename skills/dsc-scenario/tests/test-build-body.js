'use strict';

const assert = require('node:assert/strict');
const { buildSkeleton, deepMerge } = require('../scripts/build-body.js');

// A deterministic fake resolver: instance-ref-ish paths -> ${...}, else a marker.
// Keeps buildSkeleton's structure logic isolated from the real persona table.
const fakeResolve = (p) => {
  const seg = p.replace(/\[\]/g, '').split('.').pop();
  if (seg === 'productId' || seg === 'id') return `\${${seg.toUpperCase()}}`;
  return `V:${seg}`;
};

// --- object nesting: a.b.c -> {a:{b:{c: value}}} ---
{
  const sk = buildSkeleton(['billingAddress.firstName', 'billingAddress.lastName'], fakeResolve);
  assert.deepEqual(sk, { billingAddress: { firstName: 'V:firstName', lastName: 'V:lastName' } });
}

// --- array element: foo[].bar -> {foo:[{bar: value}]} (single element) ---
{
  const sk = buildSkeleton(['productItems[].productId', 'productItems[].quantity'], fakeResolve);
  assert.deepEqual(sk, { productItems: [{ productId: '${PRODUCTID}', quantity: 'V:quantity' }] });
  assert.equal(sk.productItems.length, 1, 'single representative element');
}

// --- deep nesting through an array: paymentInstruments[].paymentCard.cardType ---
{
  const sk = buildSkeleton([
    'paymentInstruments[].paymentMethodId',
    'paymentInstruments[].paymentCard.cardType',
    'paymentInstruments[].paymentCard.holder',
  ], fakeResolve);
  assert.deepEqual(sk, {
    paymentInstruments: [{
      paymentMethodId: 'V:paymentMethodId',
      paymentCard: { cardType: 'V:cardType', holder: 'V:holder' },
    }],
  });
}

// --- order-independence + idempotence ---
{
  const a = buildSkeleton(['x.y', 'x.z'], fakeResolve);
  const b = buildSkeleton(['x.z', 'x.y', 'x.y'], fakeResolve);
  assert.deepEqual(a, b, 'order-independent and idempotent');
}

// --- deepMerge: source object replaces a flat placeholder for the same key ---
{
  const stub = { productItems: '<productItems>', basketId: '<basketId>' };
  const skeleton = { productItems: [{ productId: '${PRODUCT_ID}' }] };
  const merged = deepMerge(stub, skeleton);
  assert.deepEqual(merged.productItems, [{ productId: '${PRODUCT_ID}' }], 'skeleton replaces flat placeholder');
  assert.equal(merged.basketId, '<basketId>', 'a stub-only spec-required field SURVIVES the merge');
}

// --- deepMerge: nested objects merge key-wise, source wins on overlap ---
{
  const t = { a: { keep: 1, over: 'old' } };
  const s = { a: { over: 'new', add: 2 } };
  deepMerge(t, s);
  assert.deepEqual(t, { a: { keep: 1, over: 'new', add: 2 } });
}

console.log('ok');
