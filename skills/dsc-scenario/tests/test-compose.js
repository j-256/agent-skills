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

// OCAPI auth routing through composePlan. The target (post-orders, ocapi-shop-*)
// must resolve to the ocapi-shop branch (NOT shopper-slas -- the over-auth bug),
// carry a shopper tier (a write is shopper-state), and expose the OCAPI-native
// token flow + the OCAPI-settings prerequisite. Every OCAPI step's requestAuth
// must carry client_id (the floor) and a bearer (Tier 2). Uses the committed
// OCAPI fixtures under commerce_b2c-commerce.
{
  const OCAPI_CACHE = path.join(__dirname, 'fixtures');
  const AREA = 'commerce_b2c-commerce';
  // Two-reference plan: post-baskets (producer) -> post-orders (target), threaded
  // on basket_id, exactly what the bridge composes on the real cache.
  const graph = {
    nodes: [
      { slug: 'post-baskets', reference: 'ocapi-shop-baskets', method: 'POST', path: '/baskets',
        producedTypes: [{ name: 'basket', ref: '#/components/schemas/basket' }], requiredInputs: [] },
      { slug: 'post-orders', reference: 'ocapi-shop-orders', method: 'POST', path: '/orders',
        producedTypes: [{ name: 'order', ref: '#/components/schemas/order' }],
        requiredInputs: [{ name: 'basket_id', in: 'body', typeRef: '#/components/schemas/basket', typeName: 'basket', fromBridge: true, needsNaming: false }] },
    ],
    edges: [{ from: 'post-baskets', to: 'post-orders', viaField: 'basket_id' }],
  };
  const plan = composePlan({ graph, targetSlug: 'post-orders', reference: 'ocapi-shop-orders', cacheRoot: OCAPI_CACHE, area: AREA });

  assert.equal(plan.authBranch, 'ocapi-shop', 'ocapi-shop-* target routes to ocapi-shop, not shopper-slas');
  assert.ok(plan.auth, 'plan carries the resolved auth object');
  assert.equal(plan.auth.branch, 'ocapi-shop');
  assert.equal(plan.auth.tier, 'shopper', 'a write (POST /orders) is a shopper-state op -> shopper tier');
  assert.ok(plan.auth.token, 'shopper tier carries the OCAPI-native token flow');
  assert.equal(plan.auth.token.flow, 'ocapi-customers-auth');
  assert.equal(plan.auth.token.tokenIn, 'response-header');
  assert.ok(Array.isArray(plan.auth.prerequisites) && plan.auth.prerequisites.some((p) => /OCAPI settings/i.test(p.text)),
    'ocapi-shop prerequisite surfaced');
  // Per-step requestAuth: both steps carry client_id + a bearer.
  for (const s of plan.steps) {
    assert.ok(s.requestAuth, `${s.slug} carries requestAuth`);
    assert.equal(s.requestAuth.query.client_id, '$CLIENT_ID', `${s.slug} emits client_id (the OCAPI floor)`);
    assert.equal(s.requestAuth.bearer, true, `${s.slug} sends a shopper bearer (Tier 2)`);
  }
}

// OCAPI Data routing: get-code_versions (ocapi-data-*) -> ocapi-data branch, AM
// app-token flow, client_id + bearer on the request. Single-step plan.
{
  const OCAPI_CACHE = path.join(__dirname, 'fixtures');
  const AREA = 'commerce_b2c-commerce';
  const graph = walkTypes({ targetSlug: 'get-code_versions', reference: 'ocapi-data-code-versions', cacheRoot: OCAPI_CACHE, area: AREA });
  const plan = composePlan({ graph, targetSlug: 'get-code_versions', reference: 'ocapi-data-code-versions', cacheRoot: OCAPI_CACHE, area: AREA });
  assert.equal(plan.authBranch, 'ocapi-data', 'ocapi-data-* target routes to ocapi-data');
  assert.equal(plan.auth.token.flow, 'am-app-token', 'Data uses the AM app-token flow');
  assert.equal(plan.auth.token.tokenUrl, 'https://account.demandware.com/dwsso/oauth2/access_token');
  assert.equal(plan.steps[0].requestAuth.query.client_id, '$CLIENT_ID', 'Data call carries client_id');
  assert.equal(plan.steps[0].requestAuth.bearer, true, 'Data call sends the AM bearer');
}

// SCAPI unchanged: tiny-ref (Bearer scheme) still routes to 'unknown', authFlow
// null, and its steps carry NO client_id (a SCAPI call never gets one). The
// requestAuth default preserves the pre-iteration bearer-only shape.
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  assert.equal(plan.authBranch, 'unknown');
  assert.equal(plan.authFlow, null);
  assert.equal(plan.auth, null, 'no provider matches tiny-ref -> auth is null');
  for (const s of plan.steps) {
    assert.deepEqual(s.requestAuth.query, {}, `${s.slug} (SCAPI) carries no client_id`);
    assert.equal(s.requestAuth.bearer, true, `${s.slug} still sends a bearer`);
  }
}

console.log('ok');
