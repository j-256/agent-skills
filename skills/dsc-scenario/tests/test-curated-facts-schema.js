'use strict';

// Schema + self-invalidation tests for the unified curated-fact registry. Absorbs
// three predecessors (all deleted in Task 6):
//   - test-corrections.js         -> checkSpecAnchor / deriveVolatility unit tests +
//                                     applyCuratedNotes note-channel behavior (active/
//                                     drifted/excluded) + the REAL auth-admin note.
//   - test-corrections-schema.js  -> validator-reject cases + both anchored citizens
//                                     derive spec-divergence.
//   - test-submittability-schema.js -> producer-body leaf-tracing self-invalidation
//                                     against the REAL cached type schema (the trap:
//                                     the request ROOT type is response-shaped, so
//                                     elementTypes pins switch traversal to the REQUEST
//                                     type at the payment boundary; type-level allOf is
//                                     resolved; masked_number is INVERTED spec-presence,
//                                     validated by a runtime correction instead).
// PLUS a NEW op-body anchor test: the addPaymentInstrument request type declares no
// required props today, so its anchor holds against the live cache.
//
// The renderer stays cache-free; this test is where the "field the registry names
// still exists in the spec" guarantee is enforced. A weakened assertion that masks
// drift is a FAILURE, not a fix.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { checkSpecAnchor, deriveVolatility, applyCuratedNotes } = require('../lib/engine/curated-facts.js');
const { CURATED_FACTS } = require('../lib/products/commerce-b2c/curated-facts.js');
const { assertCuratedFactsWellFormed } = require('../lib/engine/curated-facts.js');
const { loadType, normalizeSchema } = require('../lib/common/spec-traversal.js');
const { makeLeafResolver } = require('../lib/common/body-values.js');
const { PERSONA, INSTANCE_REF_SEGMENTS } = require('../lib/products/commerce-b2c/persona.js');
const resolveLeafValue = makeLeafResolver({ persona: PERSONA, instanceRefSegments: INSTANCE_REF_SEGMENTS });

const CACHE = path.join(os.homedir(), '.cache', 'dsc-scrape');

// --- deriveVolatility: shape-derived, no stored enum -------------------------
assert.equal(deriveVolatility({ infraInvariant: true }), 'infra-invariant');
assert.equal(deriveVolatility({ specAnchor: { field: 'security', read: () => 1, holds: () => true, saw: 'x' } }), 'spec-divergence');
assert.equal(deriveVolatility({ basis: 'runtime-verified' }), 'platform-behavior');
// infraInvariant wins even if (nonsensically) an anchor is also present - flag is explicit.
assert.equal(deriveVolatility({ infraInvariant: true, specAnchor: {} }), 'infra-invariant');

// --- checkSpecAnchor: fail toward re-verify, never toward silent trust -------
// no anchor -> holds (nothing to watch).
assert.deepEqual(checkSpecAnchor(undefined, {}), { state: 'holds' });
// holds() true -> holds, carrying the read value as `now`.
{
  const anchor = { field: 'security', saw: 's', read: (ctx) => ctx.v, holds: (v) => v === 42 };
  assert.deepEqual(checkSpecAnchor(anchor, { v: 42 }), { state: 'holds', now: 42 });
}
// holds() false -> drifted, carrying `now`.
{
  const anchor = { field: 'security', saw: 's', read: (ctx) => ctx.v, holds: (v) => v === 42 };
  assert.deepEqual(checkSpecAnchor(anchor, { v: 7 }), { state: 'drifted', now: 7 });
}
// read() returns null -> drifted (cannot read the field -> fail toward re-verify).
{
  const anchor = { field: 'security', saw: 's', read: () => null, holds: () => true };
  assert.deepEqual(checkSpecAnchor(anchor, {}), { state: 'drifted', now: null });
}
// read() throws -> drifted, not a crash.
{
  const anchor = { field: 'security', saw: 's', read: () => { throw new Error('missing type file'); }, holds: () => true };
  assert.deepEqual(checkSpecAnchor(anchor, {}), { state: 'drifted', now: null });
}
// read() returns undefined -> drifted (== null catches undefined too; pins the enumerated branch).
{
  const anchor = { field: 'security', saw: 's', read: () => undefined, holds: () => true };
  assert.deepEqual(checkSpecAnchor(anchor, {}), { state: 'drifted', now: null });
}
// holds() throws -> drifted, not an uncaught crash (a malformed value funds toward re-verify).
{
  const anchor = { field: 'security', saw: 's', read: (ctx) => ctx.v, holds: () => { throw new Error('x'); } };
  assert.equal(checkSpecAnchor(anchor, { v: 42 }).state, 'drifted');
}

// --- applyCuratedNotes: note-channel behavior (synthetic attach:'note' facts) -
// Build ctx once; these synthetic notes read from ctx.opDoc, not the cache. Each
// carries attach:'note' -- the note channel filters to that mode (Task 6).
const baseArgs = { opDoc: { endpoint: { security: [{ scheme: 'BearerToken', scopes: ['SLAS_SERVICE_ADMIN'] }] } },
                   cacheRoot: '/unused', area: 'a', reference: 'r' };

// A matching, still-holding anchored note -> one active note with derived volatility.
{
  const facts = [{
    id: 'c1', attach: 'note', match: () => true, claim: 'C', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-02', coords: {} }], scope: 'sandbox only',
    cite: 'https://developer.salesforce.com/x', provenance: 'p',
    specAnchor: {
      field: 'security', saw: 'BearerToken scopes all ~ SLAS_*_ADMIN',
      read: (ctx) => ctx.opDoc.endpoint.security,
      holds: (sec) => { const b = sec.find((s) => s.scheme === 'BearerToken'); return !!b && b.scopes.length > 0 && b.scopes.every((s) => /^SLAS_.*_ADMIN$/.test(s)); },
    },
  }];
  const notes = applyCuratedNotes({ context: { area: 'a' }, facts, ...baseArgs });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'active');
  assert.equal(notes[0].volatility, 'spec-divergence');
  assert.equal(notes[0].claim, 'C');
  assert.equal(notes[0].scope, 'sandbox only');
}

// Same note, but the live security[] now names a non-admin gate -> drifted note with drift{}.
{
  const facts = [{
    id: 'c1', attach: 'note', match: () => true, claim: 'C', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-02', coords: {} }], scope: 's', cite: null, provenance: 'p',
    specAnchor: {
      field: 'security', saw: 'BearerToken scopes all ~ SLAS_*_ADMIN',
      read: (ctx) => ctx.opDoc.endpoint.security,
      holds: (sec) => { const b = sec.find((s) => s.scheme === 'BearerToken'); return !!b && b.scopes.length > 0 && b.scopes.every((s) => /^SLAS_.*_ADMIN$/.test(s)); },
    },
  }];
  const opDoc = { endpoint: { security: [{ scheme: 'BearerToken', scopes: ['CCDX_SBX_USER'] }] } };
  const notes = applyCuratedNotes({ context: { area: 'a' }, facts, ...baseArgs, opDoc });
  assert.equal(notes[0].status, 'drifted');
  assert.deepEqual(notes[0].drift.now, [{ scheme: 'BearerToken', scopes: ['CCDX_SBX_USER'] }]);
  assert.equal(notes[0].drift.field, 'security');
}

// Non-matching note -> excluded entirely.
{
  const facts = [{ id: 'x', attach: 'note', match: () => false, claim: 'C', basis: 'doc-stated', cite: null, provenance: 'p' }];
  const notes = applyCuratedNotes({ context: {}, facts, ...baseArgs });
  assert.equal(notes.length, 0);
}

// Anchor-less note that matches -> active platform-behavior note (no drift possible).
{
  const facts = [{ id: 'am', attach: 'note', match: () => true, claim: 'AM', basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-02', coords: {} }], cite: null, provenance: 'p' }];
  const notes = applyCuratedNotes({ context: {}, facts, ...baseArgs });
  assert.equal(notes[0].status, 'active');
  assert.equal(notes[0].volatility, 'platform-behavior');
}

// --- the REAL auth-admin note citizen ----------------------------------------
const authAdmin = CURATED_FACTS.find((c) => c.id === 'auth-admin-sandbox-api-user');
assert.ok(authAdmin, 'auth-admin note citizen present');

// Both observed role-forms satisfy the anchor (documents the per-op variance found).
for (const scopes of [['SLAS_SERVICE_ADMIN'], ['SLAS_SERVICE_ADMIN', 'SLAS_ORGANIZATION_ADMIN']]) {
  const opDoc = { endpoint: { security: [{ scheme: 'BearerToken', scopes }] } };
  const notes = applyCuratedNotes({
    context: { area: 'commerce_commerce-api', reference: 'auth-admin' },
    facts: [authAdmin], opDoc, cacheRoot: '/unused', area: 'commerce_commerce-api', reference: 'auth-admin',
  });
  assert.equal(notes[0].status, 'active', `auth-admin holds for scopes ${scopes.join(',')}`);
}
// The real gate name -> drifted.
{
  const opDoc = { endpoint: { security: [{ scheme: 'BearerToken', scopes: ['CCDX_SBX_USER'] }] } };
  const notes = applyCuratedNotes({
    context: { area: 'commerce_commerce-api', reference: 'auth-admin' },
    facts: [authAdmin], opDoc, cacheRoot: '/unused', area: 'commerce_commerce-api', reference: 'auth-admin',
  });
  assert.equal(notes[0].status, 'drifted', 'auth-admin drifts when the spec names the real gate');
}
// The note does NOT match an unrelated reference.
assert.equal(authAdmin.match({ area: 'commerce_commerce-api', reference: 'shopper-orders' }), false);

// --- validator: rejects each conditional-required violation ------------------
assert.doesNotThrow(() => assertCuratedFactsWellFormed(CURATED_FACTS));
// Exactly the two intended NOTE citizens are present, by id.
const noteIds = CURATED_FACTS.filter((c) => c.attach === 'note').map((c) => c.id).sort();
assert.deepEqual(noteIds, ['auth-admin-sandbox-api-user', 'ocapi-create-body-masked-number'].sort());

const wellFormed = () => ({
  id: 'x', attach: 'note', match: () => true, claim: 'c', basis: 'runtime-verified',
  verifiedOn: [{ date: '2026-07-02', coords: {} }], scope: 's', provenance: 'p', cite: null,
  specAnchor: { field: 'security', saw: 's', read: () => [], holds: () => true },
});
// runtime-verified with no verifiedOn -> reject.
assert.throws(() => assertCuratedFactsWellFormed([{ ...wellFormed(), verifiedOn: [] }]), /verifiedOn/i);
// specAnchor present but no scope bounds -> reject.
assert.throws(() => assertCuratedFactsWellFormed([{ ...wellFormed(), scope: undefined }]), /scope/i);
// specAnchor with a non-function read -> reject.
{
  const bad = wellFormed(); bad.specAnchor = { field: 'f', saw: 's', read: 'nope', holds: () => true };
  assert.throws(() => assertCuratedFactsWellFormed([bad]), /read/i);
}
// missing cite key entirely (not even null) -> reject.
{
  const bad = wellFormed(); delete bad.cite;
  assert.throws(() => assertCuratedFactsWellFormed([bad]), /cite/i);
}
// bad basis enum -> reject.
assert.throws(() => assertCuratedFactsWellFormed([{ ...wellFormed(), basis: 'guessed' }]), /basis/i);

// Every anchored citizen derives spec-divergence (both notes + the op-body anchor).
for (const c of CURATED_FACTS.filter((c) => c.specAnchor)) assert.equal(deriveVolatility(c), 'spec-divergence');

console.log('ok (note anchors + validator rejects)');

// --- producer-body leaf-tracing self-invalidation against the REAL cache -----
// Source the entries from the unified registry's producer-body facts, keyed by
// producesType (was the SUBMITTABILITY map's object KEY). COORDS keys match.
const PRODUCER_BODIES = Object.fromEntries(
  CURATED_FACTS.filter((c) => c.attach === 'producer-body').map((c) => [c.producesType, c]));

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
  return CURATED_FACTS.some((c) =>
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

for (const [key, entry] of Object.entries(PRODUCER_BODIES)) {
  const co = COORDS[key];
  assert.ok(co, `test coords exist for producer-body producesType '${key}'`);

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

// Render-time-throw guard: every shipped producer-body leaf's VALUE must resolve cleanly
// -- resolveLeafValue must NOT throw UnmappedLeafError for any leaf. This makes a future
// registry leaf whose value isn't mapped fail HERE at CI, instead of throwing during a
// live user-facing render.
for (const [key, entry] of Object.entries(PRODUCER_BODIES)) {
  for (const leaf of entry.leaves) {
    assert.doesNotThrow(() => resolveLeafValue(leaf),
      `${key}.${leaf}: resolveLeafValue must not throw (add its value to PERSONA / `
      + `INSTANCE_REF_SEGMENTS in products/commerce-b2c/persona.js so the renderer never throws live)`);
  }
}

console.log(`ok (${checked} producer-body leaf paths validated, ${skipped} entries skipped for uncached refs; `
  + `${correctionSourced} leaf(s) validated via the correction registry)`);

// --- NEW: op-body anchor read against the REAL cache -------------------------
// The addPaymentInstrument request type declares no required props today (which is
// WHY the type-graph walk emits no body); its anchor holds while that stays true.
// Driven against the live cache. Skip (don't fail) if the reference isn't scraped.
{
  const addPay = CURATED_FACTS.find((c) => c.id === 'scapi-add-payment-instrument-body');
  assert.ok(addPay && addPay.specAnchor, 'op-body addPaymentInstrument citizen with anchor present');
  const ctx = { cacheRoot: CACHE, area: 'commerce_commerce-api', reference: 'shopper-baskets-v2' };
  // Probe the request type first: skip if the reference isn't cached (mirror above).
  const probe = loadType(CACHE, ctx.reference, 'BasketPaymentInstrumentRequest', ctx.area);
  if (!probe) {
    console.log('ok (op-body anchor skipped: shopper-baskets-v2 not cached)');
  } else {
    const read = addPay.specAnchor.read(ctx);
    assert.deepEqual(read, [], 'BasketPaymentInstrumentRequest declares no required props -> read() is []');
    assert.equal(addPay.specAnchor.holds(read), true, 'empty required[] -> the addPaymentInstrument fact holds');
    console.log('ok (op-body anchor: BasketPaymentInstrumentRequest required[] is empty; fact holds)');
  }
}
