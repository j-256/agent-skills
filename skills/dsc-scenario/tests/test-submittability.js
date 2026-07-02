'use strict';

// Unit tests for the curated submittability registry (Phase 1 of the
// submittability-registry design). The registry holds maintainer-supplied,
// CITED minimal submittable-minimums keyed by produced-resource type. It is the
// same category of encoded knowledge as the SLAS auth-routing table -- curated +
// cited = an encoded fact, not model fabrication. These tests pin the merge logic
// (present -> producer step annotated; absent -> plan unchanged; flag-only ->
// advisory without a producer) and the integrity invariants on the shipped data.

const assert = require('node:assert/strict');
const {
  loadRegistry,
  lookupSubmittability,
  applySubmittability,
} = require('../scripts/submittability.js');

// A fully-controlled fake registry so the merge-logic tests don't depend on the
// shipped Basket data (which is asserted separately below).
const FAKE = {
  Widget: {
    note: 'A widget must be assembled before shipWidget will accept it.',
    submittableVia: 'producer-body',
    needed: [],
    bodyContents: [
      { field: 'parts', why: 'a widget with no parts is rejected at ship time (400 No Parts)' },
      { field: 'label', why: 'shipWidget returns 400 Missing Label without a shipping label' },
    ],
    provenance:
      'Empirically verified against a live instance; spec states no required-set. '
      + 'https://developer.salesforce.com/docs/example/references/widgets?meta=shipWidget',
    confidence: 'curated',
  },
};

function fakePlan() {
  // A 2-step plan: createWidget (produces Widget) -> shipWidget (target, body=Widget).
  return {
    targetSlug: 'shipWidget',
    reference: 'widgets',
    steps: [
      {
        slug: 'createWidget',
        reference: 'widgets',
        produces: [{ name: 'Widget', ref: '#/components/schemas/Widget' }],
        requiredInputs: [],
      },
      {
        slug: 'shipWidget',
        reference: 'widget-orders',
        produces: [{ name: 'WidgetOrder', ref: '#/components/schemas/WidgetOrder' }],
        requiredInputs: [],
      },
    ],
  };
}

// --- lookupSubmittability ---------------------------------------------------
{
  assert.equal(lookupSubmittability('Nonexistent', FAKE), null, 'absent type -> null');
  const e = lookupSubmittability('Widget', FAKE);
  assert.ok(e && e.bodyContents.length === 2, 'present type -> entry with bodyContents');
  assert.equal(lookupSubmittability(null, FAKE), null, 'null typeName -> null (no crash)');
  assert.equal(lookupSubmittability('Widget', {}), null, 'empty registry -> null');
}

// --- applySubmittability: present + bodyContents -> producer step annotated --
{
  const plan = fakePlan();
  const advisory = applySubmittability({ plan, bodyTypeName: 'Widget', registry: FAKE });
  assert.ok(advisory, 'present type returns an advisory');
  assert.equal(advisory.typeName, 'Widget');
  assert.equal(advisory.producerSlug, 'createWidget', 'advisory names the producer step');
  assert.deepEqual(advisory.needed, [], 'Widget entry is body-content shape (no separate steps)');
  assert.ok(/developer\.salesforce\.com/.test(advisory.provenance), 'provenance cites a public URL');
  assert.equal(advisory.confidence, 'curated');

  // The producer step (NOT the target) carries the curated body the renderer
  // consumes. This is the whole mechanism: createBasket's body must be populated,
  // not a separate step grafted in.
  const producer = plan.steps.find((s) => s.slug === 'createWidget');
  assert.ok(producer.submittableBody, 'producer step gains submittableBody');
  assert.equal(producer.submittableBody.bodyContents.length, 2);
  assert.equal(producer.submittableBody.typeName, 'Widget');
  assert.ok(producer.submittableBody.provenance, 'submittableBody carries provenance for the renderer');
  // The target step must NOT be annotated -- only the producer.
  const target = plan.steps.find((s) => s.slug === 'shipWidget');
  assert.ok(!target.submittableBody, 'target step is not annotated');
}

// --- applySubmittability: absent type -> plan unchanged (the common case) ----
{
  const plan = fakePlan();
  const advisory = applySubmittability({ plan, bodyTypeName: 'Gadget', registry: FAKE });
  assert.equal(advisory, null, 'absent type -> null advisory');
  assert.ok(!plan.steps.some((s) => s.submittableBody), 'no step annotated when type is absent');
}

// --- applySubmittability: null bodyTypeName -> no-op (no named body type) -----
{
  const plan = fakePlan();
  const advisory = applySubmittability({ plan, bodyTypeName: null, registry: FAKE });
  assert.equal(advisory, null, 'null body type -> null advisory');
  assert.ok(!plan.steps.some((s) => s.submittableBody));
}

// --- applySubmittability: present but NO producer step in plan (flag-only) ----
// A target whose body type is in the registry but whose producer isn't in this
// plan (e.g. pass 1, target-only). The advisory still surfaces (so the model can
// warn), with producerSlug null; nothing is mutated and nothing crashes.
{
  const plan = {
    targetSlug: 'shipWidget',
    reference: 'widget-orders',
    steps: [
      { slug: 'shipWidget', reference: 'widget-orders', produces: [], requiredInputs: [] },
    ],
  };
  const advisory = applySubmittability({ plan, bodyTypeName: 'Widget', registry: FAKE });
  assert.ok(advisory, 'advisory still returned when producer absent');
  assert.equal(advisory.producerSlug, null, 'producerSlug is null when no step produces the type');
  assert.ok(!plan.steps.some((s) => s.submittableBody), 'nothing annotated');
}

// --- Shipped Basket entry: integrity invariants -----------------------------
// The registry must not ship an entry that can't be defended with a citation --
// that would be the fabrication this design exists to prevent. Pin the shape.
{
  const reg = loadRegistry();
  assert.ok(reg.Basket, 'the shipped registry has a Basket entry');
  const b = reg.Basket;
  assert.ok(typeof b.provenance === 'string' && b.provenance.length > 0, 'provenance is required, non-empty');
  assert.ok(/developer\.salesforce\.com/.test(b.provenance), 'provenance cites a public DSC URL');
  assert.equal(b.confidence, 'curated');
  assert.deepEqual(b.needed, [], 'Basket is body-content shape: no separate populate steps (Phase 0 finding)');
  assert.ok(Array.isArray(b.bodyContents) && b.bodyContents.length >= 4,
    'Basket bodyContents enumerates the empirically-verified minimum (items, shipping, billing, payment)');
  for (const c of b.bodyContents) {
    assert.ok(c.field && c.why, `each bodyContents entry has field + why; got ${JSON.stringify(c)}`);
  }
  // The field names must be Basket BODY properties, not op slugs -- rendering an
  // op slug (addItemToBasket) would trip the over-decomposition guard and
  // misrepresent the single-call shape. Guard the data against that.
  const fields = b.bodyContents.map((c) => c.field).join(' ');
  assert.ok(!/addItemToBasket|updateShippingAddressForShipment|updateBillingAddressForBasket|addPaymentInstrumentToBasket/.test(fields),
    'bodyContents fields must be body-property names, not operation slugs');
  assert.ok(/productItems/.test(fields) && /payment/i.test(fields) && /billing/i.test(fields) && /ship/i.test(fields),
    'bodyContents covers items, payment, billing, shipping');
}

// --- Shipped OCAPI `basket` entry: snake_case + runtime-verified payment shape --
// OCAPI's submittable-minimum is the SAME concept set as SCAPI's Basket (line
// items, shipping method + address, billing address, payment) -- the gate is at
// order submit on both planes. Field casing is snake_case. The registry is keyed
// by the produced-type name as the walk sees it: lowercase `basket` for OCAPI
// (SCAPI's is `Basket`). Guard both independently.
//
// PAYMENT SHAPE (runtime-verified against the sandbox, iteration-ocapi-auth-branch;
// this CORRECTS an earlier wrong extrapolation that OCAPI takes a raw card number
// in the create body): the OCAPI Shop `payment_card` in the single POST /baskets
// create body takes `masked_number` and REJECTS a raw `number`
// (400 UnknownPropertyException "unknown property 'number'"). A raw number only
// works on the `payment_instruments` SUB-RESOURCE POST. So the create-body default
// is masked_number; the raw-number sub-resource path is a documented alternative.
// Both placed real orders (masked-inline -> 00000402; raw-subresource -> 00000401).
{
  const reg = loadRegistry();
  assert.ok(reg.basket, 'the shipped registry has a lowercase `basket` entry for OCAPI');
  const b = reg.basket;
  assert.ok(/developer\.salesforce\.com/.test(b.provenance), 'OCAPI basket provenance cites a public DSC URL');
  assert.equal(b.confidence, 'curated');
  assert.deepEqual(b.needed, [], 'OCAPI basket is body-content shape too (single-call populate)');
  const fields = b.bodyContents.map((c) => c.field).join(' ');
  // snake_case body properties, not SCAPI camelCase and not op slugs.
  assert.ok(/product_items/.test(fields), 'OCAPI uses snake_case product_items (not productItems)');
  assert.ok(/billing_address/.test(fields), 'OCAPI uses snake_case billing_address');
  assert.ok(/payment/i.test(fields) && /ship/i.test(fields), 'covers payment + shipping');
  assert.ok(!/productItems|billingAddress/.test(fields),
    'OCAPI entry must not carry SCAPI camelCase field names');
  const allText = `${b.note || ''} ${b.bodyContents.map((c) => c.why).join(' ')}`;
  // The create-body payment must be documented as masked_number, NOT a raw number.
  assert.ok(/masked_number/.test(allText),
    'OCAPI basket entry documents masked_number as the create-body payment field (runtime-verified: raw number 400s at create)');
  // The raw-number alternative must be attributed to the payment_instruments
  // sub-resource, so a reader knows raw only works there -- not in the create body.
  assert.ok(/payment_instruments/.test(allText) && /(sub-?resource|separate call|separate POST)/i.test(allText),
    'OCAPI basket entry notes the raw-number path is the payment_instruments sub-resource POST');
  // Regression guard on the corrected defect, done structurally rather than with a
  // blunt negative regex (the prose legitimately contains "raw number ... rejected"
  // and "raw number ... only works via the sub-resource", both of which a naive
  // exclude would false-trip). The precise, defect-proof signal: the SAME why that
  // documents the raw-number path must tie masked_number to the create body -- an
  // entry that wrongly claimed raw-in-create-body could not also carry this.
  const paymentWhy = (b.bodyContents.find((c) => /payment/i.test(c.field)) || {}).why || '';
  assert.ok(/masked_number/.test(paymentWhy),
    'the payment why documents masked_number as the create-body card field (runtime-verified: raw 400s at create)');
  assert.ok(/payment_instruments/.test(paymentWhy) && /raw/i.test(paymentWhy),
    'the payment why routes the raw card number to the payment_instruments sub-resource');
}

console.log('ok');
