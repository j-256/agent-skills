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

  // Shell variable assignments for producer responses (snake stems via shellVar)
  assert.match(block, /CREATE_CONTAINER_RESPONSE=/);
  assert.match(block, /ADD_ITEM_RESPONSE=/);

  // Consumer uses producer's output via jq extraction
  assert.match(block, /CONTAINER_ID=\$\(echo "\$CREATE_CONTAINER_RESPONSE" \| jq -r \.containerId\)/);
  assert.match(block, /ITEM_ID=\$\(echo "\$ADD_ITEM_RESPONSE" \| jq -r \.itemId\)/);

  // Final getItem references the extracted IDs in its URL
  assert.match(block, /\/containers\/\$\{CONTAINER_ID\}\/items\/\$\{ITEM_ID\}/);

  // Fill-in block at the TOP (not a bottom legend). BASE_URL is declared + guarded.
  assert.match(block, /# ---- Fill in your connection values ----/);
  assert.match(block, /^BASE_URL=""/m, 'BASE_URL declared as an empty fill-in var');
  assert.match(block, /: "\$\{BASE_URL:\?/, 'BASE_URL guarded by a :? preflight');
  assert.doesNotMatch(block, /^# Placeholders:/m, 'bottom legend retired');
}

// Single-step plan (target with no producers)
{
  const graph = walkTypes({ targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const block = renderCurlBlock({ plan });
  const curlLines = block.split('\n').filter((l) => /=\$\(curl /.test(l));
  assert.equal(curlLines.length, 1);
  // No ID-extraction lines when there are no consumers.
  assert.ok(!/jq -r/.test(block.split('\n').filter((l) => l.startsWith('CONTAINER_ID=')).join('\n')));
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
  assert.match(bash, /\$\{BASE_URL\}\/checkout\/widgets\/v2\/organizations\/\$\{ORGANIZATION_ID\}\/widgets/,
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
    authBranch: 'ocapi-shop',
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
  // Auth preamble now rendered deterministically: the customers/auth capture.
  assert.match(bash, /\/customers\/auth/, 'OCAPI auth preamble rendered');
  assert.match(bash, /ACCESS_TOKEN=/, 'ACCESS_TOKEN producer present (was model-prose before)');
  // client_id appended as a query param on every OCAPI call: the two API calls
  // PLUS the customers/auth token leg the preamble now emits.
  const clientIdCalls = bash.split('\n').filter((l) => /client_id=\$\{CLIENT_ID\}/.test(l));
  assert.equal(clientIdCalls.length, 3, `both OCAPI calls + the customers/auth leg carry ?client_id=; got ${clientIdCalls.length}`);
  // The URL keeps the OCAPI path prefix and the client_id is on the query string.
  assert.match(bash, /\/s\/\$\{SITE_ID\}\/dw\/shop\/v25_6\/baskets\?client_id=\$\{CLIENT_ID\}/,
    'client_id is a query param on the OCAPI URL');
  // basket_id still threads from post-baskets into post-orders.
  assert.match(bash, /BASKET_ID=\$\(echo "\$POST_BASKETS_RESPONSE" \| jq -r \.basket_id\)/);
  // CLIENT_ID must be surfaced so the user knows to supply it -- now as a top
  // fill-in var (the bottom legend is retired), guarded by the :? preflight.
  assert.match(bash, /^CLIENT_ID=""/m, 'CLIENT_ID declared as a fill-in var');
  assert.match(bash, /\$\{CLIENT_ID:\?/, 'CLIENT_ID guarded by a :? preflight');
}

// SCAPI step (empty requestAuth.query) gets NO client_id -- the pre-iteration
// shape is preserved exactly. Reuses the tiny happy-path plan through walk/compose.
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const bash = renderCurlBlock({ plan });
  assert.doesNotMatch(bash, /client_id=/, 'SCAPI runnable carries no client_id query param');
  // tiny-ref getItem routes to the 'unknown' branch (Bearer scheme), so NO auth
  // preamble renders -- none of the SLAS/AM/OCAPI token legs appear.
  assert.doesNotMatch(bash, /customers\/auth|oauth2\/authorize|oauth2\/token/, 'unknown branch renders no auth preamble');
}

// Fill-in COMPLETENESS (Basic-auth credential leak). The auth renderer emits the
// AM Basic-auth credentials inside a `printf '%s:%s'` idiom. scanFillInVars matches
// braced ${VAR} only, so if those refs are bare ($AM_CLIENT_ID) they never surface
// as fill-in vars -- and the runnable then aborts under `set -euo pipefail` with an
// unbound variable (or POSTs an empty Basic header -> 401). Render a full `am`
// private-cc plan and assert the credentials are declared AND guarded, so a paste
// -and-run user is actually told to supply them.
{
  const plan = {
    targetSlug: 'getOrders', reference: 'orders-admin', combinedScopes: ['sfcc.orders'],
    idPassing: [],
    authBranch: 'am',
    authFlow: { tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token', grantType: 'client_credentials', label: 'AM private-cc' },
    auth: { branch: 'am', tier: null, token: null },
    steps: [
      { slug: 'getOrders', reference: 'orders-admin', basePath: '/checkout/orders/v1', method: 'GET',
        path: '/organizations/{organizationId}/orders', specUrl: 'https://developer.salesforce.com/x/orders-admin?meta=getOrders',
        produces: [], requiredInputs: [], evidence: [] },
    ],
  };
  const bash = renderCurlBlock({ plan });
  assert.match(bash, /^AM_CLIENT_ID=""/m, 'AM_CLIENT_ID surfaced as a fill-in var (Basic-auth cred must not stay bare)');
  assert.match(bash, /^AM_CLIENT_SECRET=""/m, 'AM_CLIENT_SECRET surfaced as a fill-in var');
  assert.match(bash, /\$\{AM_CLIENT_ID:\?/, 'AM_CLIENT_ID appears in the :? preflight');
  assert.match(bash, /\$\{AM_CLIENT_SECRET:\?/, 'AM_CLIENT_SECRET appears in the :? preflight');
}

// Federated SLAS must NOT promote usid to an unsatisfiable fill-in. On the federated
// path there is no 303 to capture a usid from (the flow emits a browser/paste seam),
// so if the token leg still sends usid=${USID} the fill-in scan promotes the
// unassigned ${USID} to a hard :?-guarded var the federated shopper cannot supply --
// aborting the script at its own preflight. AUTH_CODE (the sanctioned federated seam)
// must still be a fill-in.
{
  const plan = {
    targetSlug: 'getCustomer', reference: 'shopper-customers', combinedScopes: ['sfcc.shopper-customers.rw'],
    idPassing: [],
    authBranch: 'shopper-slas',
    authFlow: { slugs: ['authorizeCustomer', 'getAccessToken'], authorizeHint: '<idp-name>', grantType: 'authorization_code_pkce', label: 'SLAS registered, federated IDP' },
    auth: { branch: 'shopper-slas', tier: null, token: null },
    steps: [
      { slug: 'getCustomer', reference: 'shopper-customers', basePath: '/customer/shopper-customers/v1', method: 'GET',
        path: '/organizations/{organizationId}/customers', specUrl: 'https://developer.salesforce.com/x/shopper-customers?meta=getCustomer',
        produces: [], requiredInputs: [], evidence: [] },
    ],
  };
  const bash = renderCurlBlock({ plan });
  assert.doesNotMatch(bash, /^USID=""/m, 'federated USID must NOT become an (unsatisfiable) fill-in var');
  assert.match(bash, /^AUTH_CODE=""/m, 'federated AUTH_CODE IS the sanctioned fill-in seam');
}

console.log('ok');
