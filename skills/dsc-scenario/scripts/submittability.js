'use strict';

// Curated submittability registry consumer.
//
// The structural type-graph walk produces the FK-threading minimum: for
// `createOrder` it yields a `createBasket` with an empty `{}` body. That is
// spec-valid but business-broken -- an empty basket is rejected at submit. The
// submittable-minimum (which basket fields must be populated for `createOrder`
// to succeed) is in NEITHER the machine-readable spec (`Basket.required` is null)
// NOR the docs prose (it states no hard required-set), so the walk structurally
// cannot see it. It is curated runtime knowledge.
//
// This module folds a maintainer-supplied, CITED registry into the composed plan
// deterministically. The entry is keyed by produced-resource type (`Basket`) and
// carries the minimal body the producer step (`createBasket`) must populate, with
// each field's failure mode as its `why`. Integrity firewall: an entry is an
// ENCODED FACT (curated + version-controlled + cited), the same category as the
// SLAS auth-routing table in `_shared/slas-flows.js` -- NOT model fabrication. The
// annotation carries `confidence: 'curated'` and `provenance` so every rendered
// line is framed as a checkout business-rule with its citation, never as spec.
//
// Placement is skill-local (here, not `_shared/`): `lib/` inside the skill is the
// `_shared` symlink, and only dsc-scenario consumes this. A future Phase-2
// runtime-triage skill can require this same file by path if it ever needs it.

const { SUBMITTABILITY } = require('./submittability-registry.js');

// Kept as a function (not just the const) so tests can call it and a future
// refactor can add lazy behavior; returns the required data module.
function loadRegistry() {
  return SUBMITTABILITY;
}

// Look up a produced-resource type in the registry. Returns the entry or null.
// `registry` defaults to the shipped data; tests pass a fake.
function lookupSubmittability(typeName, registry = loadRegistry()) {
  if (!typeName || typeof typeName !== 'string') return null;
  if (!registry || typeof registry !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(registry, typeName) ? registry[typeName] : null;
}

// Fold a registry entry into a composed plan. `bodyTypeName` is the target's
// request-body named type (e.g. `createOrder`'s body is `Basket`). When that
// type has an entry:
//   - find the plan step that PRODUCES the type (the `createBasket` producer) and
//     annotate it with `submittableBody` (the curated body contents + provenance),
//     so the renderer populates that one step's body rather than grafting separate
//     populate steps (which would be the over-decomposition the design forbids);
//   - return an advisory object the caller surfaces to the user, framed as a
//     curated business-rule with its citation.
// Absent type, null type, or no producer in this plan -> returns null / a
// producer-less advisory and mutates nothing. The common case (no entry) is a
// pure no-op, preserving today's behavior exactly.
function applySubmittability({ plan, bodyTypeName, registry = loadRegistry() }) {
  const entry = lookupSubmittability(bodyTypeName, registry);
  if (!entry) return null;

  // Find the step that produces this type -- that's the step whose body must be
  // populated. Match on producedTypes[].name (the structural producer signal the
  // rest of the walk uses).
  const producer = (plan && Array.isArray(plan.steps) ? plan.steps : []).find(
    (s) => Array.isArray(s.produces) && s.produces.some((p) => p && p.name === bodyTypeName),
  );

  const advisory = {
    typeName: bodyTypeName,
    note: entry.note || null,
    submittableVia: entry.submittableVia || null,
    needed: Array.isArray(entry.needed) ? entry.needed : [],
    bodyContents: Array.isArray(entry.bodyContents) ? entry.bodyContents : [],
    provenance: entry.provenance,
    confidence: entry.confidence || 'curated',
    producerSlug: producer ? producer.slug : null,
  };

  // Annotate the producer step so the deterministic renderer can populate its
  // body. Only the producer is touched; the target step is never annotated.
  if (producer) {
    producer.submittableBody = {
      typeName: bodyTypeName,
      bodyContents: advisory.bodyContents,
      note: entry.note || null,
      provenance: entry.provenance,
      confidence: advisory.confidence,
      // Body-recursion: the nested leaf paths (structure) + the test-only request
      // element-type pins. Absent on older entries -> undefined, and the renderer
      // falls back to the flat bodyContents path (belt-and-suspenders).
      leaves: Array.isArray(entry.leaves) ? entry.leaves : undefined,
      elementTypes: entry.elementTypes || undefined,
    };
  }

  return advisory;
}

module.exports = { loadRegistry, lookupSubmittability, applySubmittability };
