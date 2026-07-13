'use strict';
// Unit tests for attachCuratedBodies -- the skill-local body-populator. Producer-body
// parity here; op-body cases added in Task 5. Absorbs test-submittability.js's merge logic.
const assert = require('node:assert/strict');
const { attachCuratedBodies } = require('../scripts/curated-body.js');

// A fully-controlled fake registry so merge-logic tests don't depend on shipped data.
const FAKE = [{
  id: 'widget-body', attach: 'producer-body', producesType: 'Widget', family: 'SCAPI',
  bodyContents: [{ field: 'parts', why: 'a widget with no parts is rejected (400 No Parts)' }],
  leaves: ['parts[].partId', 'parts[].quantity', 'label.text'],
  elementTypes: { 'parts[]': 'WidgetPartRequest' },
  provenance: 'Empirically verified. https://developer.salesforce.com/docs/example/references/widgets?meta=submitWidget',
  confidence: 'curated', basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }],
  scope: 's', cite: 'https://developer.salesforce.com/x',
}];

function fakePlan() {
  return { targetSlug: 'shipWidget', reference: 'widgets', steps: [
    { slug: 'createWidget', reference: 'widgets', produces: [{ name: 'Widget', ref: '#/x/Widget' }], requiredInputs: [] },
    { slug: 'shipWidget', reference: 'widget-orders', produces: [{ name: 'WidgetOrder' }], requiredInputs: [] },
  ] };
}

// --- producer-body: present -> producer step annotated, advisory returned ----
{
  const plan = fakePlan();
  const adv = attachCuratedBodies({ plan, targetBodyType: 'Widget', facts: FAKE });
  assert.equal(adv.length, 1, 'one advisory for the matched producer-body');
  assert.equal(adv[0].attach, 'producer-body');
  assert.equal(adv[0].stepSlug, 'createWidget', 'advisory names the producer step');
  assert.equal(adv[0].typeName, 'Widget');
  assert.equal(adv[0].confidence, 'curated');
  assert.ok(/developer\.salesforce\.com/.test(adv[0].provenance));
  const producer = plan.steps.find((s) => s.slug === 'createWidget');
  assert.ok(producer.curatedBody, 'producer step gains curatedBody');
  assert.equal(producer.curatedBody.attach, 'producer-body');
  assert.deepEqual(producer.curatedBody.leaves, ['parts[].partId', 'parts[].quantity', 'label.text']);
  assert.deepEqual(producer.curatedBody.elementTypes, { 'parts[]': 'WidgetPartRequest' });
  const target = plan.steps.find((s) => s.slug === 'shipWidget');
  assert.ok(!target.curatedBody, 'target step is NOT annotated for producer-body');
}

// --- producer-body: absent body type -> plan unchanged, no advisory ----------
{
  const plan = fakePlan();
  const adv = attachCuratedBodies({ plan, targetBodyType: 'Gadget', facts: FAKE });
  assert.deepEqual(adv, [], 'absent type -> empty advisory list');
  assert.ok(!plan.steps.some((s) => s.curatedBody), 'no step annotated');
}

// --- producer-body: null targetBodyType -> no-op --------------------------------
{
  const plan = fakePlan();
  assert.deepEqual(attachCuratedBodies({ plan, targetBodyType: null, facts: FAKE }), []);
  assert.ok(!plan.steps.some((s) => s.curatedBody));
}

// --- producer-body: type in registry but no producer step -> no annotation ------
{
  const plan = { targetSlug: 'shipWidget', reference: 'widget-orders',
    steps: [{ slug: 'shipWidget', reference: 'widget-orders', produces: [], requiredInputs: [] }] };
  const adv = attachCuratedBodies({ plan, targetBodyType: 'Widget', facts: FAKE });
  // No producer in this plan -> nothing to populate; no advisory (a body with no
  // step to hang on is not surfaced -- the note channel is where the model gets warned).
  assert.deepEqual(adv, [], 'no producer step -> no body advisory');
  assert.ok(!plan.steps.some((s) => s.curatedBody));
}

console.log('ok (task3: attachCuratedBodies producer-body parity)');

// --- op-body: attaches to the step whose identity matches -------------------
{
  const OP_FAKE = [{
    id: 'op-x', attach: 'op-body', family: 'SCAPI',
    match: (c) => c.reference === 'shopper-baskets-v2' && /payment-instruments$/.test(c.path || ''),
    bodyContents: [{ field: 'paymentMethodId', why: 'w' }],
    leaves: ['paymentMethodId', 'paymentCard.cardType'],
    provenance: 'https://developer.salesforce.com/x', confidence: 'curated',
    basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }], scope: 's', cite: null,
  }];
  const plan = { targetSlug: 'addPaymentInstrumentToBasket', reference: 'shopper-baskets-v2', steps: [
    { slug: 'createBasket', reference: 'shopper-baskets-v2', area: 'commerce_commerce-api',
      method: 'POST', path: '/organizations/{organizationId}/baskets', produces: [{ name: 'Basket' }], requiredInputs: [] },
    { slug: 'addPaymentInstrumentToBasket', reference: 'shopper-baskets-v2', area: 'commerce_commerce-api',
      method: 'POST', path: '/organizations/{organizationId}/baskets/{basketId}/payment-instruments',
      produces: [], requiredInputs: [] },
  ] };
  const adv = attachCuratedBodies({ plan, targetBodyType: null, facts: OP_FAKE });
  assert.equal(adv.length, 1, 'one op-body advisory');
  assert.equal(adv[0].attach, 'op-body');
  assert.equal(adv[0].stepSlug, 'addPaymentInstrumentToBasket', 'op-body attaches to the matched step (the target)');
  const t = plan.steps.find((s) => s.slug === 'addPaymentInstrumentToBasket');
  assert.ok(t.curatedBody && t.curatedBody.attach === 'op-body');
  const other = plan.steps.find((s) => s.slug === 'createBasket');
  assert.ok(!other.curatedBody, 'a non-matching step is untouched');
}

// --- collision: a step matching BOTH a producer-body and an op-body fact ------
// attachTo throws on a double-attach; that guard was untested until op-body made it
// reachable (one step can now match a producer-body AND an op-body fact). Assert the
// throw NAMES BOTH colliding fact ids so a real collision is diagnosable, not silent.
{
  const COLLIDE = [
    { id: 'prod-combo', attach: 'producer-body', producesType: 'Combo', family: 'SCAPI',
      bodyContents: [{ field: 'a', why: 'w' }], leaves: ['a'],
      provenance: 'https://developer.salesforce.com/x', confidence: 'curated',
      basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }], scope: 's', cite: null },
    { id: 'op-combo', attach: 'op-body', family: 'SCAPI',
      match: (c) => /payment-instruments$/.test(c.path || ''),
      bodyContents: [{ field: 'b', why: 'w' }], leaves: ['paymentMethodId'],
      provenance: 'https://developer.salesforce.com/x', confidence: 'curated',
      basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }], scope: 's', cite: null },
  ];
  // ONE step that both PRODUCES 'Combo' AND matches the op-body path-regex. The
  // producer-body fact (first in facts[]) attaches, then the op-body fact collides.
  const plan = { targetSlug: 'addPaymentInstrumentToBasket', reference: 'shopper-baskets-v2', steps: [
    { slug: 'addPaymentInstrumentToBasket', reference: 'shopper-baskets-v2', area: 'commerce_commerce-api',
      method: 'POST', path: '/organizations/{organizationId}/baskets/{basketId}/payment-instruments',
      produces: [{ name: 'Combo' }], requiredInputs: [] },
  ] };
  assert.throws(
    () => attachCuratedBodies({ plan, targetBodyType: 'Combo', facts: COLLIDE }),
    (err) => /prod-combo/.test(err.message) && /op-combo/.test(err.message),
    'double-attach throws naming BOTH colliding fact ids',
  );
}

console.log('ok (task5: op-body attach + collision guard)');
