'use strict';

// Product-neutral leaf-VALUE resolver for deterministic request-body rendering.
// The registry (a product's curated-facts producer-body entries) names WHICH nested leaves a body
// carries; this module decides each leaf's VALUE. Keyed by NORMALIZED field name
// so both API families (camelCase SCAPI, snake_case OCAPI) share one table --
// firstName and first_name both resolve to the one synthetic persona, so the
// whole runnable reads as ONE coherent "Jane Doe" (consistent within AND across
// requests by construction). The persona + instance-ref segments are INJECTED
// (makeLeafResolver), so this mechanism carries no product data. Sibling of
// shell-vars.js; a future runtime-triage skill can reuse it without an
// up-dependency into a skill's scripts/.

const { shellVar } = require('./shell-vars.js');

class UnmappedLeafError extends Error {
  constructor(fullPath, key) {
    super(`No persona value for free-form leaf '${fullPath}' (normalized key '${key}'). Add it to PERSONA in products/commerce-b2c/persona.js, or add its final segment to INSTANCE_REF_SEGMENTS there.`);
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
// The set of instance-ref segments is a product's DATA (injected), so classifyLeaf
// takes it as a param rather than closing over a module-level const.
function classifyLeaf(fullPath, instanceRefSegments) {
  return instanceRefSegments.has(normalizeLeaf(finalSegment(fullPath)))
    ? 'instance-ref'
    : 'free-form';
}

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

// Build a resolver closure bound to one product's data. The mechanism is
// product-neutral; the persona + instance-ref segments are injected (the same
// inject-the-data pattern resolveAuthProvider/applyCuratedNotes use).
function makeLeafResolver({ persona, instanceRefSegments }) {
  return function resolveLeafValue(fullPath) {
    if (classifyLeaf(fullPath, instanceRefSegments) === 'instance-ref') {
      return placeholderFor(fullPath);
    }
    const key = normalizeLeaf(finalSegment(fullPath));
    if (!Object.prototype.hasOwnProperty.call(persona, key)) throw new UnmappedLeafError(fullPath, key);
    return persona[key];
  };
}

module.exports = { normalizeLeaf, classifyLeaf, makeLeafResolver, UnmappedLeafError };
