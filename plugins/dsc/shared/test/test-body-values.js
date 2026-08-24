'use strict';

const assert = require('node:assert/strict');
const { normalizeLeaf, classifyLeaf, makeLeafResolver, UnmappedLeafError } = require('../common/body-values.js');
const { PERSONA, INSTANCE_REF_SEGMENTS } = require('../products/commerce-b2c/persona.js');

const resolveLeafValue = makeLeafResolver({ persona: PERSONA, instanceRefSegments: INSTANCE_REF_SEGMENTS });

// normalizeLeaf: casing collapses so both families share one table
assert.equal(normalizeLeaf('first_name'), 'firstname');
assert.equal(normalizeLeaf('firstName'), 'firstname');
assert.equal(normalizeLeaf('masked_number'), 'maskednumber');

// classifyLeaf now takes the product's instance-ref segments as a param
assert.equal(classifyLeaf('productItems[].productId', INSTANCE_REF_SEGMENTS), 'instance-ref');
assert.equal(classifyLeaf('shipments[].shippingMethod.id', INSTANCE_REF_SEGMENTS), 'instance-ref');
assert.equal(classifyLeaf('billingAddress.firstName', INSTANCE_REF_SEGMENTS), 'free-form');

// resolveLeafValue closure: instance-ref -> ${SHELLVAR}; free-form -> persona value
assert.equal(resolveLeafValue('productItems[].productId'), '${PRODUCT_ID}');
assert.equal(resolveLeafValue('shipments[].shippingMethod.id'), '${SHIPPING_METHOD_ID}');
assert.equal(resolveLeafValue('billingAddress.firstName'), 'Jane');
assert.equal(resolveLeafValue('billing_address.first_name'), 'Jane');
assert.equal(resolveLeafValue('productItems[].quantity'), 1);
assert.equal(resolveLeafValue('paymentInstruments[].paymentCard.cardType'), 'Visa');

// unmapped free-form throws (no silent undefined) -- the drop-one guardrail
assert.throws(() => resolveLeafValue('billingAddress.middleInitial'), UnmappedLeafError);
assert.throws(() => resolveLeafValue('paymentInstruments[].paymentCard.holder'), UnmappedLeafError);

console.log('ok');
