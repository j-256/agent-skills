'use strict';
// Skill-local curated-body populator. Reads the unified curated-fact registry and
// attaches `.curatedBody` to the plan step whose request body a curated runtime
// fact says must be populated -- either the PRODUCER of the target's body-type
// (producer-body) or the matched op itself (op-body, Task 5). Renderer-facing;
// stays skill-local because it knows plan.steps shape (not product-neutral).
const { CURATED_FACTS } = require('../lib/products/commerce-b2c/curated-facts.js');

// Build the render/advisory payload a step carries. Kept small + explicit.
function bodyPayload(fact, attach) {
  return {
    attach,
    typeName: fact.producesType || null,
    bodyContents: Array.isArray(fact.bodyContents) ? fact.bodyContents : [],
    note: fact.note || null,
    provenance: fact.provenance,
    confidence: fact.confidence || 'curated',
    cite: fact.cite != null ? fact.cite : null,
    leaves: Array.isArray(fact.leaves) ? fact.leaves : undefined,
    elementTypes: fact.elementTypes || undefined,
  };
}

// Attach at most one curatedBody per step; assert on a real double-attach (the
// shipped citizens never collide -- producer-body Basket vs op-body addPayment).
function attachTo(step, fact, attach) {
  if (step.curatedBody) {
    throw new Error(`attachCuratedBodies: step '${step.slug}' already has a curatedBody `
      + `('${step.curatedBody.__id}'); '${fact.id}' would overwrite it`);
  }
  const payload = bodyPayload(fact, attach);
  payload.__id = fact.id; // for the collision message + advisory id; not rendered
  step.curatedBody = payload;
  return { id: fact.id, attach, typeName: payload.typeName, stepSlug: step.slug,
    bodyContents: payload.bodyContents, provenance: payload.provenance,
    confidence: payload.confidence, cite: payload.cite };
}

function attachCuratedBodies({ plan, targetBodyType, facts = CURATED_FACTS }) {
  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
  const advisories = [];
  for (const fact of facts) {
    if (fact.attach === 'producer-body') {
      if (!targetBodyType || fact.producesType !== targetBodyType) continue;
      const producer = steps.find((s) => Array.isArray(s.produces)
        && s.produces.some((p) => p && p.name === targetBodyType));
      if (!producer) continue; // no producer in this plan -> nothing to populate
      advisories.push(attachTo(producer, fact, 'producer-body'));
    }
    if (fact.attach === 'op-body') {
      if (typeof fact.match !== 'function') continue;
      for (const step of steps) {
        const area = step.area || (plan && plan.area);
        const ctx = { area, reference: step.reference, method: step.method, path: step.path };
        if (fact.match(ctx)) advisories.push(attachTo(step, fact, 'op-body'));
      }
    }
  }
  return advisories;
}

module.exports = { attachCuratedBodies };
