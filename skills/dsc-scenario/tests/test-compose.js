'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { walkTypes } = require('../scripts/walk-types.js');
const { composePlan } = require('../scripts/compose.js');

const CACHE = path.join(__dirname, 'fixtures');
const REF = 'tiny-ref';

// Topo sort with target as sink
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });

  // Target must be the last step.
  assert.equal(plan.steps[plan.steps.length - 1].slug, 'getItem');
  // Producers must come before consumers.
  const order = plan.steps.map((s) => s.slug);
  const ixCreateC = order.indexOf('createContainer');
  const ixAddItem = order.indexOf('addItem');
  const ixGetItem = order.indexOf('getItem');
  assert.ok(ixCreateC < ixAddItem, 'createContainer before addItem');
  assert.ok(ixAddItem < ixGetItem, 'addItem before getItem');
  // Every step has a public URL citation.
  for (const s of plan.steps) {
    assert.ok(/^https:\/\/developer\.salesforce\.com\//.test(s.specUrl), `${s.slug} has public URL`);
  }
}

// Scope union: deduped to least-privilege.
// Bare 'items' (from getItem) drops out because 'items.rw' (from addItem) is
// also in the cross-op union; the .rw scope subsumes reads on the same family.
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  assert.deepEqual(plan.combinedScopes, ['containers.rw', 'items.rw']);
  // tiny-ref's scopes aren't in STANDARD_SHOPPER_SCOPES, so meta-scope is not suggested.
  assert.equal(plan.metaScopeSuggested, false);
  // tiny-ref's security scheme is 'Bearer' -> auth branch is 'unknown'; no auth flow attached.
  assert.equal(plan.authBranch, 'unknown');
  assert.equal(plan.authFlow, null);
}

// ID-passing map
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const getItemEntry = plan.idPassing.find((e) => e.consumer === 'getItem');
  assert.ok(getItemEntry);
  const byField = (arr) => arr.reduce((acc, e) => (acc[e.field] = e.from, acc), {});
  assert.deepEqual(byField(getItemEntry.inputs), {
    containerId: 'createContainer',
    itemId: 'addItem',
  });
}

// Evidence annotation: each step records the structural edge(s) that justified its inclusion
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const addItemStep = plan.steps.find((s) => s.slug === 'addItem');
  assert.ok(addItemStep.evidence.length > 0);
  assert.ok(addItemStep.evidence.some((e) => e.kind === 'structural' && e.viaField === 'itemId'));
}

// Empty graph (target with no producers): single-step plan
{
  const graph = walkTypes({ targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  assert.deepEqual(plan.steps.map((s) => s.slug), ['createContainer']);
  assert.deepEqual(plan.idPassing, []);
  assert.deepEqual(plan.combinedScopes, ['containers.rw']);
  assert.equal(plan.authBranch, 'unknown');
}

// Edges referencing unknown slugs are dropped, not passed to idPassing or steps
{
  const fakeGraph = {
    nodes: [
      { slug: 'createContainer', method: 'POST', path: '/containers',
        producedTypes: [], requiredInputs: [] },
    ],
    edges: [
      { from: 'createContainer', to: 'phantom', viaField: 'x' },
      { from: 'ghost', to: 'createContainer', viaField: 'y' },
    ],
  };
  const plan = composePlan({ graph: fakeGraph, targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  assert.deepEqual(plan.steps.map((s) => s.slug), ['createContainer']);
  assert.deepEqual(plan.idPassing, []);
}

// Target with outgoing edges: throws
{
  const fakeGraph = {
    nodes: [
      { slug: 'createContainer', method: 'POST', path: '/containers',
        producedTypes: [], requiredInputs: [] },
      { slug: 'addItem', method: 'POST', path: '/containers/{containerId}/items',
        producedTypes: [], requiredInputs: [] },
    ],
    edges: [
      { from: 'createContainer', to: 'addItem', viaField: 'containerId' },
    ],
  };
  // Target = createContainer, which has an outgoing edge to addItem. Not a sink.
  assert.throws(
    () => composePlan({ graph: fakeGraph, targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' }),
    /not a valid sink/,
  );
}

// Orphan non-target step: throws
{
  const fakeGraph = {
    nodes: [
      { slug: 'getItem', method: 'GET', path: '/containers/{containerId}/items/{itemId}',
        producedTypes: [], requiredInputs: [] },
      { slug: 'createContainer', method: 'POST', path: '/containers',
        producedTypes: [], requiredInputs: [] },
    ],
    edges: [], // No edges at all
  };
  // Target is getItem; createContainer is an orphan non-target.
  assert.throws(
    () => composePlan({ graph: fakeGraph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' }),
    /has no structural edges/,
  );
}

// Multi-reference compose: a graph with nodes from two references composes each
// step from its OWN reference, carrying that reference's basePath + specUrl.
{
  const graph = {
    nodes: [
      { slug: 'createWidget', reference: 'refB', method: 'POST', path: '/organizations/{organizationId}/widgets',
        producedTypes: [{ name: 'Widget', ref: '#/components/schemas/Widget' }], requiredInputs: [] },
      { slug: 'submitWidget', reference: 'refA', method: 'POST', path: '/organizations/{organizationId}/widget-orders',
        producedTypes: [], requiredInputs: [
          { name: 'widgetId', in: 'body', typeRef: '#/components/schemas/Widget', typeName: 'Widget', fromBridge: true, needsNaming: false } ] },
    ],
    edges: [ { from: 'createWidget', to: 'submitWidget', viaField: 'widgetId' } ],
  };
  const plan = composePlan({ graph, targetSlug: 'submitWidget', reference: 'refA', cacheRoot: CACHE, area: 'bridge-area' });
  const create = plan.steps.find((s) => s.slug === 'createWidget');
  const submit = plan.steps.find((s) => s.slug === 'submitWidget');
  assert.equal(create.reference, 'refB', 'createWidget step tagged with refB');
  assert.equal(create.basePath, '/test/refB/v1', 'createWidget carries refB basePath');
  assert.equal(submit.basePath, '/test/refA/v1', 'submitWidget carries refA basePath');
  assert.match(create.specUrl, /refB/, 'createWidget cites refB');
  assert.match(submit.specUrl, /refA/, 'submitWidget cites refA');
}

console.log('ok');
