'use strict';

// Self-invalidating structure validation for the submittability registry. For each
// entry, every leaf path is traced through the REAL cached type schema; the test
// goes RED if Salesforce renames a field the registry names. This is the
// certainty-layer pattern (f76008f) as a TEST, so the renderer stays cache-free.
//
// The trap it must avoid: the request ROOT type (Basket) is response-shaped --
// traversing it lands on RESPONSE element types (OrderPaymentInstrument, PaymentCard)
// that coincidentally carry the same leaf names, so a naive trace would pass while
// validating the WRONG type. The entry's `elementTypes` pins switch the traversal to
// the REQUEST type at those boundaries. (Verified: Basket.paymentInstruments' naive
// $ref is OrderPaymentInstrument -> PaymentCard, and PaymentCard really does declare
// cardType/holder -- so without the pins this test passes falsely. That is the point.)
//
// Two mechanics beyond the naive walk, each verified necessary against the live cache
// (and each firmly on the "fix the test, not the data" side of the line):
//   1. Pins apply at DESCENT (as the next-type override), NOT at segment entry. Applying
//      a pin before checking the current segment would test paymentInstruments against
//      BasketPaymentInstrumentRequest (which has no such property) and fail spuriously --
//      the "pin application is wrong" symptom the brief predicts.
//   2. Type-level allOf composition is resolved (effectiveProps). SCAPI
//      Basket.productItems items-$ref is BasketProductItem, a bare allOf wrapper around
//      ProductItem, where productId/quantity actually live. A raw `.properties` read of
//      the wrapper finds nothing. Resolving allOf keeps self-invalidation intact: rename
//      productId in ProductItem and the merged props lose it -> red.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { loadType, normalizeSchema } = require('../lib/spec-traversal.js');
const { SUBMITTABILITY } = require('../scripts/submittability-registry.js');
const { B2C_CORRECTIONS } = require('../lib/b2c-corrections.js');
const { resolveLeafValue } = require('../lib/body-values.js');

const CACHE = path.join(os.homedir(), '.cache', 'dsc-scrape');

// Where each entry's request root type lives + the type name to start traversal at.
const COORDS = {
  Basket: { area: 'commerce_commerce-api', reference: 'shopper-baskets-v2', rootType: 'Basket' },
  basket: { area: 'commerce_b2c-commerce', reference: 'ocapi-shop-baskets', rootType: 'basket' },
};

// Correction-sourced leaf: the spec is wrong/absent for it, so spec-presence is INVERTED
// -- validated by a runtime-verified correction instead. OCAPI masked_number is the one
// citizen: order_payment_card_request declares raw `number`, NOT masked_number, yet the
// create body MUST use masked_number. We do not merely string-match the leaf name; we
// require a correction whose match() fires for THIS family context and whose claim names
// the field. If that correction is ever removed, this returns false, the leaf falls
// through to naive spec-presence, and the test goes red -- so the exception cannot
// outlive its justification. SCAPI's OrderPaymentCardRequest DOES declare maskedNumber
// and its context does not match this OCAPI-only correction, so SCAPI is unaffected.
function isCorrectionSourced(leafFinalSegment, area, reference) {
  if (leafFinalSegment !== 'masked_number') return false;
  return B2C_CORRECTIONS.some((c) =>
    typeof c.match === 'function'
    && c.match({ area, reference, method: 'POST' })
    && /masked_number/.test(c.claim || ''));
}

// Resolve the next type name from a property schema's $ref / items.$ref / allOf[0].$ref.
function refType(propSchema) {
  if (!propSchema) return null;
  const ref = propSchema.$ref
    || (propSchema.items && propSchema.items.$ref)
    || (Array.isArray(propSchema.allOf) && propSchema.allOf[0] && propSchema.allOf[0].$ref);
  return ref ? ref.split('/').pop() : null;
}

// Effective properties of a TYPE, resolving type-level allOf composition (a wrapper type
// like BasketProductItem that is just `allOf: [ProductItem]`). Own properties win over
// inherited ones. Cycle-guarded. Returns {} for an uncached/typo'd type name.
function effectiveProps(cacheRoot, reference, typeName, area, seen) {
  seen = seen || new Set();
  if (!typeName || seen.has(typeName)) return {};
  seen.add(typeName);
  const doc = loadType(cacheRoot, reference, typeName, area);
  if (!doc) return {};
  const schema = normalizeSchema(doc.type && doc.type.schema) || {};
  let props = { ...(schema.properties || {}) };
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      if (member && member.$ref) {
        const refName = member.$ref.split('/').pop();
        props = { ...effectiveProps(cacheRoot, reference, refName, area, seen), ...props };
      } else if (member && member.properties) {
        const m = normalizeSchema(member) || {};
        props = { ...(m.properties || {}), ...props };
      }
    }
  }
  return props;
}

function segsOf(leafPath) {
  return leafPath.split('.').map((raw) => (raw.endsWith('[]') ? raw.slice(0, -2) : raw));
}
// The path prefix up to (and including) segment i, in registry `[]`/`.` notation --
// used to look up elementTypes pins. Rebuilt from the original [] markers.
function prefixAt(rawSegs, i) {
  return rawSegs.slice(0, i + 1).join('.');
}

let checked = 0;
let skipped = 0;
let correctionSourced = 0;

for (const [key, entry] of Object.entries(SUBMITTABILITY)) {
  const co = COORDS[key];
  assert.ok(co, `test coords exist for registry key '${key}'`);

  // Family guard: the entry's declared family must match the cache area its root
  // type actually loads from.
  const familyArea = { SCAPI: 'commerce_commerce-api', OCAPI: 'commerce_b2c-commerce' }[entry.family];
  assert.equal(co.area, familyArea, `${key}: family ${entry.family} <-> area ${familyArea}`);

  const rootDoc = loadType(CACHE, co.reference, co.rootType, co.area);
  if (!rootDoc) { skipped++; continue; } // reference not scraped -> skip, don't fail

  // Each elementTypes pin must itself be a cached type (a typo'd pin fails loudly).
  for (const pinType of Object.values(entry.elementTypes || {})) {
    assert.ok(loadType(CACHE, co.reference, pinType, co.area),
      `${key}: elementTypes pin '${pinType}' is a cached type`);
  }

  for (const leaf of entry.leaves) {
    const raw = leaf.split('.'); // keep [] markers for prefix lookup
    const plainSegs = segsOf(leaf);
    const finalSeg = plainSegs[plainSegs.length - 1];

    // Correction-sourced leaf: spec presence is inverted -- validate via correction.
    if (isCorrectionSourced(finalSeg, co.area, co.reference)) {
      correctionSourced++;
      checked++;
      continue;
    }

    // Walk from the root type. At each non-terminal segment, descend into the pinned
    // element type if one is declared for this prefix, else follow the property's $ref.
    let curType = co.rootType;
    for (let i = 0; i < plainSegs.length; i++) {
      const props = effectiveProps(CACHE, co.reference, curType, co.area);
      const seg = plainSegs[i];
      assert.ok(Object.prototype.hasOwnProperty.call(props, seg),
        `${key}.${leaf}: segment '${seg}' not a property of type '${curType}' `
        + `(spec drift? re-verify the registry leaf against ${co.reference})`);
      if (i < plainSegs.length - 1) {
        const pin = (entry.elementTypes || {})[prefixAt(raw, i)];
        const next = pin || refType(props[seg]); // pin switches to the REQUEST type here
        assert.ok(next, `${key}.${leaf}: segment '${seg}' on '${curType}' has no type to descend into`);
        curType = next;
      }
    }
    checked++;
  }
}

// Carried from Task 6 (render-time-throw guard): every shipped registry leaf's VALUE
// must resolve cleanly -- resolveLeafValue must NOT throw UnmappedLeafError for any leaf
// in either entry. This makes a future registry leaf whose value isn't mapped fail HERE
// at CI, instead of throwing during a live user-facing render.
for (const [key, entry] of Object.entries(SUBMITTABILITY)) {
  for (const leaf of entry.leaves) {
    assert.doesNotThrow(() => resolveLeafValue(leaf),
      `${key}.${leaf}: resolveLeafValue must not throw (add its value to PERSONA / `
      + `INSTANCE_REF_SEGMENTS in _shared/body-values.js so the renderer never throws live)`);
  }
}

console.log(`ok (${checked} leaf paths validated, ${skipped} entries skipped for uncached refs; `
  + `${correctionSourced} leaf(s) validated via the correction registry)`);
