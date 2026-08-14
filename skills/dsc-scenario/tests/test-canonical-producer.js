'use strict';
// Unit tests for resolveCanonicalProducer -- the curated auto-resolve of a body
// bridge's producer. Pure; shares the curated-fact registry with
// attachCuratedBodies so the two can't diverge on which body-types are curated.
const assert = require('node:assert/strict');
const { resolveCanonicalProducer } = require('../scripts/curated-body.js');

// A producer-body fact that names a canonical producer, plus a decoy that does not.
const FACTS = [
  { id: 'basket-scapi', attach: 'producer-body', producesType: 'Basket', family: 'SCAPI',
    canonicalProducer: 'createBasket',
    bodyContents: [{ field: 'productItems', why: 'w' }], leaves: ['productItems[].productId'],
    provenance: 'https://developer.salesforce.com/x', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-12', coords: {} }], cite: 'https://developer.salesforce.com/x' },
  { id: 'gadget-uncurated', attach: 'producer-body', producesType: 'Gadget', family: 'SCAPI',
    bodyContents: [{ field: 'a', why: 'w' }], leaves: ['a'],
    provenance: 'https://developer.salesforce.com/x', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-12', coords: {} }], cite: null },
];

// The three from-nothing Basket producers the real walk surfaces (createBasket is canonical).
const basketCandidates = [
  { slug: 'createBasket', reference: 'shopper-baskets-v2' },
  { slug: 'transferBasket', reference: 'shopper-baskets-v2' },
  { slug: 'mergeBasket', reference: 'shopper-baskets-v2' },
];

// Fires: the fact names createBasket and exactly one candidate is it.
assert.equal(
  resolveCanonicalProducer({ targetBodyType: 'Basket', bridgeCandidates: basketCandidates, facts: FACTS }),
  'createBasket', 'auto-resolves to the single curated canonical producer');

// A body-type whose fact carries no canonicalProducer -> defer to the model.
assert.equal(
  resolveCanonicalProducer({ targetBodyType: 'Gadget', bridgeCandidates: [{ slug: 'createGadget' }], facts: FACTS }),
  null, 'uncurated body-type (fact has no canonicalProducer) -> null');

// A body-type with no matching producer-body fact at all -> null.
assert.equal(
  resolveCanonicalProducer({ targetBodyType: 'Widget', bridgeCandidates: [{ slug: 'createWidget' }], facts: FACTS }),
  null, 'no producer-body fact for this body-type -> null');

// The curated producer is absent from the surfaced candidates -> safe degrade to null.
assert.equal(
  resolveCanonicalProducer({ targetBodyType: 'Basket', bridgeCandidates: [{ slug: 'transferBasket' }, { slug: 'mergeBasket' }], facts: FACTS }),
  null, 'named producer not among candidates -> null (degrade to the model pick)');

// Two candidates sharing the canonical slug -> ambiguous -> null (defensive).
assert.equal(
  resolveCanonicalProducer({ targetBodyType: 'Basket', facts: FACTS,
    bridgeCandidates: [{ slug: 'createBasket', reference: 'shopper-baskets' }, { slug: 'createBasket', reference: 'shopper-baskets-v2' }] }),
  null, 'more than one candidate with the canonical slug -> null');

// Guards: null/absent targetBodyType, empty candidate list.
assert.equal(resolveCanonicalProducer({ targetBodyType: null, bridgeCandidates: basketCandidates, facts: FACTS }), null);
assert.equal(resolveCanonicalProducer({ targetBodyType: 'Basket', bridgeCandidates: [], facts: FACTS }), null);

// Only producer-body facts are consulted: the SAME data with attach flipped to
// 'note' must never auto-resolve (proves the attach filter, not just producesType).
const NOTE_FACT = [{ ...FACTS[0], attach: 'note', match: () => true }];
assert.equal(
  resolveCanonicalProducer({ targetBodyType: 'Basket', bridgeCandidates: basketCandidates, facts: NOTE_FACT }),
  null, 'a note fact is never consulted for producer auto-resolve');

console.log('ok (resolveCanonicalProducer auto-resolve)');
