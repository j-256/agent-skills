'use strict';

const assert = require('node:assert/strict');
const {
  normalizeLeaf,
  classifyLeaf,
  resolveLeafValue,
  UnmappedLeafError,
} = require('../body-values.js');

// --- normalizeLeaf: casing collapses so both families share one table ---
assert.equal(normalizeLeaf('first_name'), 'firstname');
assert.equal(normalizeLeaf('firstName'), 'firstname');
assert.equal(normalizeLeaf('FirstName'), 'firstname');
assert.equal(normalizeLeaf('masked_number'), 'maskednumber');
assert.equal(normalizeLeaf('maskedNumber'), 'maskednumber');

// --- classifyLeaf: instance-refs are values that must name a real object ---
assert.equal(classifyLeaf('productItems[].productId'), 'instance-ref');
assert.equal(classifyLeaf('shipments[].shippingMethod.id'), 'instance-ref');
assert.equal(classifyLeaf('product_items[].product_id'), 'instance-ref');
assert.equal(classifyLeaf('shipments[].shipping_method.id'), 'instance-ref');
// --- free-form: any well-formed value is accepted ---
assert.equal(classifyLeaf('billingAddress.firstName'), 'free-form');
assert.equal(classifyLeaf('productItems[].quantity'), 'free-form');
assert.equal(classifyLeaf('paymentInstruments[].paymentCard.cardType'), 'free-form');
assert.equal(classifyLeaf('paymentInstruments[].paymentCard.holder'), 'free-form');
assert.equal(classifyLeaf('paymentInstruments[].paymentMethodId'), 'free-form');

// --- resolveLeafValue: instance-ref -> ${SHELLVAR} placeholder string ---
assert.equal(resolveLeafValue('productItems[].productId'), '${PRODUCT_ID}');
assert.equal(resolveLeafValue('shipments[].shippingMethod.id'), '${SHIPPING_METHOD_ID}');
assert.equal(resolveLeafValue('product_items[].product_id'), '${PRODUCT_ID}');
assert.equal(resolveLeafValue('shipments[].shipping_method.id'), '${SHIPPING_METHOD_ID}');

// --- resolveLeafValue: free-form -> the one persona, keyed by normalized name ---
assert.equal(resolveLeafValue('billingAddress.firstName'), 'Jane');
assert.equal(resolveLeafValue('shipments[].shippingAddress.firstName'), 'Jane'); // SAME persona
assert.equal(resolveLeafValue('billingAddress.lastName'), 'Doe');
assert.equal(resolveLeafValue('billing_address.first_name'), 'Jane');           // snake, same value
assert.equal(resolveLeafValue('productItems[].quantity'), 1);
assert.equal(resolveLeafValue('paymentInstruments[].paymentCard.cardType'), 'Visa');
assert.equal(resolveLeafValue('paymentInstruments[].paymentMethodId'), 'CREDIT_CARD');

// --- resolveLeafValue: unmapped free-form throws (no silent undefined) ---
assert.throws(() => resolveLeafValue('billingAddress.middleInitial'), UnmappedLeafError);
// Guardrail: holder + expiration* were pared from the shipped registry (Task 8
// drop-one: only cardType is required). They are NO LONGER in PERSONA, so if a
// future change re-adds paymentCard.holder to a registry `leaves` array without
// re-authoring its value, resolveLeafValue must THROW rather than silently
// re-ship 'Jane Doe' above the minimum. This lock reddens CI on that regression.
assert.throws(() => resolveLeafValue('paymentInstruments[].paymentCard.holder'), UnmappedLeafError);

console.log('ok');
