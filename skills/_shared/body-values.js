'use strict';

// Product-neutral leaf-VALUE resolver for deterministic request-body rendering.
// The registry (submittability-registry.js) names WHICH nested leaves a body
// carries; this module decides each leaf's VALUE. Keyed by NORMALIZED field name
// so both API families (camelCase SCAPI, snake_case OCAPI) share one table --
// firstName and first_name both resolve to the one synthetic persona, so the
// whole runnable reads as ONE coherent "Jane Doe" (consistent within AND across
// requests by construction). Sibling of shell-vars.js; a future runtime-triage
// skill can reuse it without an up-dependency into a skill's scripts/.

const { shellVar } = require('./shell-vars.js');

class UnmappedLeafError extends Error {
  constructor(fullPath, key) {
    super(`No persona value for free-form leaf '${fullPath}' (normalized key '${key}'). Add it to PERSONA in _shared/body-values.js, or (if it names a real instance object) add its final segment to INSTANCE_REF_SEGMENTS.`);
    this.name = 'UnmappedLeafError';
    this.fullPath = fullPath;
    this.key = key;
  }
}

// Strip casing + delimiters so snake_case and camelCase collapse to one key.
function normalizeLeaf(name) {
  return String(name).replace(/[_-]/g, '').toLowerCase();
}

// The final path segment (the actual field being valued). 'a[].b.c' -> 'c'.
function finalSegment(fullPath) {
  const noArray = String(fullPath).replace(/\[\]/g, '');
  const parts = noArray.split('.');
  return parts[parts.length - 1];
}

// Instance-reference leaves: values that must name a REAL object on the target
// instance (a catalog product, a configured shipping method). Rendered as a
// ${SHELLVAR} placeholder so the user supplies a real id; also surfaces in the
// top fill-in block via curl-block's existing referenced-minus-assigned scan.
// Keyed by NORMALIZED final segment. Deliberately small + explicit -- a new
// instance-ref leaf is a conscious addition, not a pattern-match guess.
const INSTANCE_REF_SEGMENTS = new Set([
  normalizeLeaf('productId'),  // productId / product_id
  normalizeLeaf('id'),         // shippingMethod.id / shipping_method.id (a configured method id)
]);

function classifyLeaf(fullPath) {
  return INSTANCE_REF_SEGMENTS.has(normalizeLeaf(finalSegment(fullPath)))
    ? 'instance-ref'
    : 'free-form';
}

// One coherent synthetic identity, keyed by NORMALIZED field name. Covers exactly
// the free-form leaves the two shipped registry entries name -- no more (an
// over-broad table would mask a missing-value bug). maskedNumber matches the OCAPI
// OrderPaymentCardRequest regex ^[0-9 -]{0,7}\D{6,15}\d{0,4}$ and is obviously fake.
const PERSONA = {
  firstname: 'Jane',
  lastname: 'Doe',
  address1: '1 Market St',
  city: 'San Francisco',
  statecode: 'CA',
  postalcode: '94105',
  countrycode: 'US',
  quantity: 1,
  paymentmethodid: 'CREDIT_CARD',
  cardtype: 'Visa',
  maskednumber: '************4242',
};

// For an instance-ref leaf, name the placeholder from the field's own segment,
// snake-cased through shellVar. shippingMethod.id -> the id OF a shipping method,
// so name it by its parent when the segment alone is generic ('id').
function placeholderFor(fullPath) {
  const noArray = String(fullPath).replace(/\[\]/g, '');
  const parts = noArray.split('.');
  const last = parts[parts.length - 1];
  // A generic 'id' segment: qualify with its parent so shippingMethod.id ->
  // SHIPPING_METHOD_ID, not a bare ID. Otherwise use the segment itself.
  const nameSource = normalizeLeaf(last) === 'id' && parts.length >= 2
    ? `${parts[parts.length - 2]} ${last}`
    : last;
  return `\${${shellVar(nameSource)}}`;
}

function resolveLeafValue(fullPath) {
  if (classifyLeaf(fullPath) === 'instance-ref') {
    return placeholderFor(fullPath);
  }
  const key = normalizeLeaf(finalSegment(fullPath));
  if (!Object.prototype.hasOwnProperty.call(PERSONA, key)) throw new UnmappedLeafError(fullPath, key);
  return PERSONA[key];
}

module.exports = { normalizeLeaf, classifyLeaf, resolveLeafValue, UnmappedLeafError, PERSONA };
