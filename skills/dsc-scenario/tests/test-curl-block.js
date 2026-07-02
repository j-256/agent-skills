'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { walkTypes } = require('../scripts/walk-types.js');
const { composePlan } = require('../scripts/compose.js');
const { renderCurlBlock } = require('../scripts/curl-block.js');

const CACHE = path.join(__dirname, 'fixtures');
const REF = 'tiny-ref';

// Happy path: getItem scenario (createContainer -> addItem -> getItem)
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const block = renderCurlBlock({ plan });

  // One curl invocation per step. Each step opens a `$(curl ...)` subshell
  // assigned to a response variable – detect by the opening pattern.
  const curlLines = block.split('\n').filter((l) => /=\$\(curl /.test(l));
  assert.equal(curlLines.length, 3);

  // Shell variable assignments for producer responses
  assert.match(block, /CREATECONTAINER_RESPONSE=/);
  assert.match(block, /ADDITEM_RESPONSE=/);

  // Consumer uses producer's output via jq extraction
  assert.match(block, /CONTAINERID=\$\(echo "\$CREATECONTAINER_RESPONSE" \| jq -r \.containerId\)/);
  assert.match(block, /ITEMID=\$\(echo "\$ADDITEM_RESPONSE" \| jq -r \.itemId\)/);

  // Final getItem references the extracted IDs in its URL
  assert.match(block, /\/containers\/\$\{CONTAINERID\}\/items\/\$\{ITEMID\}/);

  // Placeholder legend at the bottom
  assert.match(block, /BASE_URL:/);
}

// Single-step plan (target with no producers)
{
  const graph = walkTypes({ targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const block = renderCurlBlock({ plan });
  const curlLines = block.split('\n').filter((l) => /=\$\(curl /.test(l));
  assert.equal(curlLines.length, 1);
  // No ID-extraction lines when there are no consumers.
  assert.ok(!/jq -r/.test(block.split('\n').filter((l) => l.startsWith('CONTAINERID=')).join('\n')));
}

// The runnable uses each step's basePath as the URL prefix (deterministic; was
// model-reconstructed prose before). A cross-reference plan gets each step's
// own prefix.
{
  const plan = {
    targetSlug: 'submitWidget', reference: 'refA', combinedScopes: ['widgets.rw'], idPassing: [],
    steps: [
      { slug: 'createWidget', reference: 'refB', basePath: '/checkout/widgets/v2', method: 'POST',
        path: '/organizations/{organizationId}/widgets', specUrl: 'https://developer.salesforce.com/x/refB?meta=createWidget',
        produces: [], requiredInputs: [], evidence: [{ kind: 'structural', viaField: 'widgetId', consumer: 'submitWidget' }] },
    ],
  };
  const bash = renderCurlBlock({ plan });
  assert.match(bash, /\$\{BASE_URL\}\/checkout\/widgets\/v2\/organizations\/\$\{ORGANIZATIONID\}\/widgets/,
    'curl URL includes the step basePath prefix');
}

// A null threading field (idPassing input {field: null}) must NOT crash. It
// arises when the bridge producer's family has no dominant path id, so the
// walker set needsNaming and the field has no structurally-derived name. The
// renderer must degrade gracefully: emit no jq-extraction line for the null
// field (no `NULL=` var, no `jq -r .null`), rather than throwing on
// `null.toUpperCase()`. The producer step still appears.
{
  const plan = {
    targetSlug: 'submitDoohickey', reference: 'refA', combinedScopes: ['doohickeys.rw'],
    idPassing: [{ consumer: 'submitDoohickey', inputs: [{ field: null, from: 'createDoohickey' }] }],
    steps: [
      { slug: 'createDoohickey', reference: 'refD', basePath: '/test/refD/v1', method: 'POST',
        path: '/organizations/{organizationId}/doohickeys', specUrl: 'https://developer.salesforce.com/x/refD?meta=createDoohickey',
        produces: [], requiredInputs: [], evidence: [{ kind: 'structural', viaField: null, consumer: 'submitDoohickey' }] },
      { slug: 'submitDoohickey', reference: 'refA', basePath: '/test/refA/v1', method: 'POST',
        path: '/organizations/{organizationId}/doohickey-orders', specUrl: 'https://developer.salesforce.com/x/refA?meta=submitDoohickey',
        produces: [], requiredInputs: [], evidence: [{ kind: 'structural', viaField: null, producer: 'createDoohickey' }] },
    ],
  };
  const bash = renderCurlBlock({ plan }); // must not throw
  assert.doesNotMatch(bash, /jq -r \.null/, 'no bogus `jq -r .null` extraction for a null field');
  assert.doesNotMatch(bash, /^NULL=/m, 'no `NULL=` variable assignment for a null field');
  // The producer step still renders (the user must know to call it).
  assert.match(bash, /createDoohickey/, 'producer step still present in the runnable');
}

// OCAPI request shape: every OCAPI call carries a ?client_id= query param (the
// floor, always required) and the OCAPI /dw/shop path prefix. The renderer reads
// step.requestAuth.query to append client_id -- SCAPI steps (empty query) never
// get one. Two-step OCAPI plan: post-baskets -> post-orders, threading basket_id.
{
  const plan = {
    targetSlug: 'post-orders', reference: 'ocapi-shop-orders', combinedScopes: [],
    idPassing: [{ consumer: 'post-orders', inputs: [{ field: 'basket_id', from: 'post-baskets' }] }],
    auth: { branch: 'ocapi-shop', tier: 'shopper', token: { flow: 'ocapi-customers-auth' } },
    steps: [
      { slug: 'post-baskets', reference: 'ocapi-shop-baskets', basePath: '/s/{siteId}/dw/shop/v25_6', method: 'POST',
        path: '/baskets', specUrl: 'https://developer.salesforce.com/x/ocapi-shop-baskets?meta=post-baskets',
        produces: [{ name: 'basket', ref: '#/components/schemas/basket' }], requiredInputs: [],
        requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basket_id', consumer: 'post-orders' }] },
      { slug: 'post-orders', reference: 'ocapi-shop-orders', basePath: '/s/{siteId}/dw/shop/v25_6', method: 'POST',
        path: '/orders', specUrl: 'https://developer.salesforce.com/x/ocapi-shop-orders?meta=post-orders',
        produces: [], requiredInputs: [{ name: 'basket_id', in: 'body', typeRef: '#/components/schemas/basket', typeName: 'basket', fromBridge: true, needsNaming: false }],
        requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basket_id', producer: 'post-baskets' }] },
    ],
  };
  const bash = renderCurlBlock({ plan });
  // client_id appended as a query param on BOTH OCAPI calls.
  const clientIdCalls = bash.split('\n').filter((l) => /client_id=\$\{CLIENT_ID\}/.test(l));
  assert.equal(clientIdCalls.length, 2, `both OCAPI calls carry ?client_id=; got ${clientIdCalls.length}`);
  // The URL keeps the OCAPI path prefix and the client_id is on the query string.
  assert.match(bash, /\/s\/\$\{SITEID\}\/dw\/shop\/v25_6\/baskets\?client_id=\$\{CLIENT_ID\}/,
    'client_id is a query param on the OCAPI URL');
  // basket_id still threads from post-baskets into post-orders.
  assert.match(bash, /BASKET_ID=\$\(echo "\$POST_BASKETS_RESPONSE" \| jq -r \.basket_id\)/);
  // CLIENT_ID must be named in the legend so the user knows to supply it.
  assert.match(bash, /CLIENT_ID:/, 'legend documents CLIENT_ID');
}

// SCAPI step (empty requestAuth.query) gets NO client_id -- the pre-iteration
// shape is preserved exactly. Reuses the tiny happy-path plan through walk/compose.
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const bash = renderCurlBlock({ plan });
  assert.doesNotMatch(bash, /client_id=/, 'SCAPI runnable carries no client_id query param');
}

console.log('ok');
