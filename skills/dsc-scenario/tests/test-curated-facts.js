'use strict';
// Unit tests for the unified curated-fact registry + its attach-discriminated
// validator. Absorbs test-corrections.js (note entries) and, in Task 2,
// test-submittability.js (producer-body entries).
const assert = require('node:assert/strict');
const { CURATED_FACTS } = require('../lib/products/commerce-b2c/curated-facts.js');
const { assertCuratedFactsWellFormed } = require('../lib/engine/curated-facts.js');

// The real registry is well-formed (also runs at module load).
assert.doesNotThrow(() => assertCuratedFactsWellFormed(CURATED_FACTS));

// Every entry declares a known attach mode.
for (const c of CURATED_FACTS) {
  assert.ok(['note', 'producer-body', 'op-body'].includes(c.attach),
    `${c.id}: attach is a known mode (got ${c.attach})`);
}

// The two migrated corrections are still present, by id, and are `note` entries.
const noteIds = CURATED_FACTS.filter((c) => c.attach === 'note').map((c) => c.id).sort();
assert.deepEqual(noteIds, ['auth-admin-sandbox-api-user', 'ocapi-create-body-masked-number'].sort());

// Validator rejects an unknown attach mode.
assert.throws(() => assertCuratedFactsWellFormed([{ id: 'x', attach: 'bogus', match: () => true,
  claim: 'c', basis: 'doc-stated', cite: null, provenance: 'p' }]), /attach/i);

// Validator rejects a note entry missing match (the note-mode requirement).
assert.throws(() => assertCuratedFactsWellFormed([{ id: 'x', attach: 'note',
  claim: 'c', basis: 'doc-stated', cite: null, provenance: 'p' }]), /match/i);

console.log('ok (task1: attach-discriminated validator)');

// --- producer-body entries (migrated from submittability-registry) ----------
const producerBodies = CURATED_FACTS.filter((c) => c.attach === 'producer-body');
const byType = Object.fromEntries(producerBodies.map((c) => [c.producesType, c]));
assert.ok(byType.Basket, 'SCAPI Basket producer-body entry present');
assert.ok(byType.basket, 'OCAPI basket producer-body entry present');
assert.equal(byType.Basket.family, 'SCAPI');
assert.equal(byType.basket.family, 'OCAPI');
// Structure carried over verbatim.
assert.ok(byType.Basket.leaves.some((p) => /paymentInstruments\[\]\.paymentCard\.cardType/.test(p)));
assert.ok(byType.basket.leaves.some((p) => /payment_instruments\[\]\.payment_card\.masked_number/.test(p)));
assert.ok(!byType.basket.leaves.some((p) => /paymentInstruments|billingAddress/.test(p)), 'OCAPI leaves snake_case only');
// Every producer-body provenance cites a public DSC URL.
for (const c of producerBodies) assert.ok(/developer\.salesforce\.com/.test(c.provenance), `${c.id}: cites DSC`);

// --- validator: producer-body conditional requirements ----------------------
const wfProducer = () => ({ id: 'p', attach: 'producer-body', producesType: 'T', family: 'SCAPI',
  leaves: ['a.b'], bodyContents: [{ field: 'a', why: 'w' }],
  claim: 'c', basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }],
  scope: 's', provenance: 'https://developer.salesforce.com/x', cite: null });
assert.doesNotThrow(() => assertCuratedFactsWellFormed([wfProducer()]));
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(), producesType: undefined }]), /producesType/i);
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(), family: 'NOPE' }]), /family/i);
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(), leaves: [] }]), /leaves/i);
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(), bodyContents: [] }]), /bodyContents/i);
// elementTypes prefix must name a leaf.
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(),
  elementTypes: { 'x[]': 'T' } }]), /elementTypes/i);

// Body-mode provenance MUST cite a public developer.salesforce.com URL -- it renders
// into the user-facing curl banner (curl-block.js), so a ~/.cache or skill-file
// provenance would leak a non-shareable path. Guard is body-mode ONLY.
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(),
  provenance: '~/.cache/dsc-scrape/commerce_commerce-api/shopper-baskets-v2' }]),
  /developer\.salesforce\.com/i);
assert.throws(() => assertCuratedFactsWellFormed([{ ...wfProducer(),
  provenance: 'https://developer.salesforce.com.attacker.example/x' }]),
  /developer\.salesforce\.com/i);
// The same guard fires for op-body (shared body-mode branch): a non-DSC provenance
// is rejected there too.
assert.throws(() => assertCuratedFactsWellFormed([{ id: 'ob-bad', attach: 'op-body',
  family: 'SCAPI', match: () => true, leaves: ['a'], bodyContents: [{ field: 'a', why: 'w' }],
  claim: 'c', basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }],
  scope: 's', provenance: 'docs/commerce-auth-matrix.md', cite: null }]),
  /developer\.salesforce\.com/i);
// A note entry with a non-DSC provenance (its provenance legitimately cites a local
// doc and is never rendered) is NOT subject to the body-mode guard.
assert.doesNotThrow(() => assertCuratedFactsWellFormed([{ id: 'n-ok', attach: 'note',
  match: () => true, claim: 'c', basis: 'doc-stated', cite: null,
  provenance: 'docs/commerce-auth-matrix.md' }]));

console.log('ok (task2: producer-body entries + validator)');

// --- op-body: the addPaymentInstrument runtime-required-body fact -------------
const { makeLeafResolver } = require('../lib/common/body-values.js');
const { PERSONA, INSTANCE_REF_SEGMENTS } = require('../lib/products/commerce-b2c/persona.js');
const resolveLeafValue = makeLeafResolver({ persona: PERSONA, instanceRefSegments: INSTANCE_REF_SEGMENTS });
const opBodies = CURATED_FACTS.filter((c) => c.attach === 'op-body');
const addPay = opBodies.find((c) => c.id === 'scapi-add-payment-instrument-body');
assert.ok(addPay, 'op-body entry for addPaymentInstrument present');
assert.equal(addPay.family, 'SCAPI');
assert.ok(/developer\.salesforce\.com/.test(addPay.provenance), 'op-body cites DSC');
assert.deepEqual(addPay.leaves, ['paymentMethodId', 'paymentCard.cardType']);
// Values already mapped -- resolveLeafValue must not throw for any op-body leaf.
for (const leaf of addPay.leaves) assert.doesNotThrow(() => resolveLeafValue(leaf), `${leaf} resolves`);
// It matches the addPaymentInstrument identity and NOT an unrelated one.
assert.equal(addPay.match({ area: 'commerce_commerce-api', reference: 'shopper-baskets-v2',
  method: 'POST', path: '/organizations/{organizationId}/baskets/{basketId}/payment-instruments' }), true);
assert.equal(addPay.match({ area: 'commerce_commerce-api', reference: 'shopper-baskets-v2',
  method: 'POST', path: '/organizations/{organizationId}/baskets' }), false, 'does NOT match createBasket');

// --- op-body anchor: BasketPaymentInstrumentRequest declares no required props --
// Self-invalidation: holds while the request type enumerates no required fields
// (why the walk emits no body); a regen that adds one -> drifted.
assert.equal(addPay.specAnchor.holds([]), true, 'no required props -> our fact holds');
assert.equal(addPay.specAnchor.holds(null), true, 'absent required array -> holds');
assert.equal(addPay.specAnchor.holds(['paymentMethodId']), false, 'a required prop appears -> drifted');

console.log('ok (task5: op-body addPaymentInstrument entry)');

// --- applyCuratedNotes considers ONLY attach:'note' facts -------------------
const { applyCuratedNotes } = require('../lib/engine/curated-facts.js');
{
  // A registry with one note + one producer-body + one op-body, all matching context.
  const facts = [
    { id: 'n', attach: 'note', match: () => true, claim: 'note-claim', basis: 'doc-stated', cite: null, provenance: 'p' },
    { id: 'pb', attach: 'producer-body', producesType: 'T', family: 'SCAPI', match: () => true,
      leaves: ['a'], bodyContents: [{ field: 'a', why: 'w' }], claim: 'c', basis: 'runtime-verified',
      verifiedOn: [{ date: '2026-07-12', coords: {} }], scope: 's', provenance: 'https://developer.salesforce.com/x', cite: null },
    { id: 'ob', attach: 'op-body', family: 'SCAPI', match: () => true, leaves: ['a'],
      bodyContents: [{ field: 'a', why: 'w' }], claim: 'c', basis: 'runtime-verified',
      verifiedOn: [{ date: '2026-07-12', coords: {} }], scope: 's', provenance: 'https://developer.salesforce.com/x', cite: null },
  ];
  const notes = applyCuratedNotes({ context: {}, facts, opDoc: { endpoint: {} }, cacheRoot: '/x', area: 'a', reference: 'r' });
  assert.equal(notes.length, 1, 'only the note-mode fact yields a Note; body-mode facts are ignored by the note channel');
  assert.equal(notes[0].id, 'n');
}

// --- masked_number seeAlso: the OCAPI producer-body cross-references the note --
{
  const ocapi = CURATED_FACTS.find((c) => c.attach === 'producer-body' && c.producesType === 'basket');
  assert.equal(ocapi.seeAlso, 'ocapi-create-body-masked-number', 'OCAPI basket entry cross-references the masked_number note');
  // The referenced id must exist (drift guard).
  assert.ok(CURATED_FACTS.some((c) => c.id === ocapi.seeAlso), 'seeAlso target id exists');
}
console.log('ok (task6: note filter + seeAlso)');
