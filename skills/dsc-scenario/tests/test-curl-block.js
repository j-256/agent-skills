'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
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

// Body-recursion: a registry producer step renders a NESTED body via heredoc, with
// one persona everywhere, instance-refs as placeholders, and any spec-required body
// field the skeleton does not name PRESERVED (merge, not replace).
{
  const plan = {
    targetSlug: 'createOrder', reference: 'shopper-orders', combinedScopes: ['sfcc.shopper-baskets'],
    idPassing: [{ consumer: 'createOrder', inputs: [{ field: 'basketId', from: 'createBasket' }] }],
    authBranch: 'unknown', auth: null,
    steps: [
      { slug: 'createBasket', reference: 'shopper-baskets-v2', basePath: '/checkout/shopper-baskets/v1',
        method: 'POST', path: '/organizations/{organizationId}/baskets',
        specUrl: 'https://developer.salesforce.com/x?meta=createBasket',
        produces: [{ name: 'Basket', ref: '#/components/schemas/Basket' }],
        // A spec-required body field the walk threaded in that the skeleton does NOT name.
        requiredInputs: [{ name: 'currency', in: 'body' }],
        requestAuth: { query: {}, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basketId', consumer: 'createOrder' }],
        submittableBody: {
          typeName: 'Basket',
          bodyContents: [{ field: 'productItems', why: 'z' }],
          leaves: [
            'productItems[].productId', 'productItems[].quantity',
            'billingAddress.firstName', 'billingAddress.lastName',
            'shipments[].shippingAddress.firstName',
            'paymentInstruments[].paymentMethodId',
            'paymentInstruments[].paymentCard.cardType',
          ],
          note: 'n', provenance: 'https://developer.salesforce.com/x', confidence: 'curated',
        } },
      { slug: 'createOrder', reference: 'shopper-orders', basePath: '/checkout/shopper-orders/v1',
        method: 'POST', path: '/organizations/{organizationId}/orders',
        specUrl: 'https://developer.salesforce.com/x?meta=createOrder',
        produces: [], requiredInputs: [{ name: 'basketId', in: 'body' }],
        requestAuth: { query: {}, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basketId', producer: 'createBasket' }] },
    ],
  };
  const bash = renderCurlBlock({ plan });

  // Emitted via an UNQUOTED heredoc so ${PLACEHOLDER} expands. Pin the exact
  // `-d @- <<JSON` form and forbid the quoted `<<'JSON'` variant explicitly: a
  // loose /<<'?JSON'?/ accepts BOTH, but the quoted form would POST the literal
  // ${PRODUCT_ID} string -- defeating the whole point of the heredoc. So the
  // load-bearing assertion is the doesNotMatch on the quoted form.
  assert.match(bash, /-d @- <<JSON\n/, 'nested body emitted via an unquoted `-d @- <<JSON` heredoc');
  assert.doesNotMatch(bash, /<<'JSON'/, 'heredoc must be UNQUOTED so ${PLACEHOLDER} expands -- a quoted <<\x27JSON\x27 would POST the literal string');
  assert.doesNotMatch(bash, /-d '\{[^']*\$\{PRODUCT_ID\}/, 'placeholder body is NOT single-quoted (would not expand)');

  // Extract the heredoc body and assert it is valid, nested JSON after we substitute
  // the shell vars a runner would. Pull the text between `<<JSON` and the `JSON` terminator.
  const m = bash.match(/<<JSON\n([\s\S]*?)\nJSON/);
  assert.ok(m, 'a JSON heredoc body is present');
  const substituted = m[1]
    .replace(/\$\{PRODUCT_ID\}/g, 'test-product')
    .replace(/\$\{[A-Z0-9_]+\}/g, 'x'); // any other placeholder -> dummy
  const body = JSON.parse(substituted);
  assert.equal(body.productItems[0].quantity, 1, 'single-element array with persona quantity');
  assert.equal(body.billingAddress.firstName, 'Jane');
  assert.equal(body.shipments[0].shippingAddress.firstName, 'Jane', 'ONE persona: shipping firstName == billing firstName');
  assert.equal(body.paymentInstruments[0].paymentCard.cardType, 'Visa', 'nested paymentCard present (the 400-bug guard)');
  assert.equal(body.paymentInstruments[0].paymentMethodId, 'CREDIT_CARD');

  // MERGE preservation: the spec-required `currency` the skeleton did not name SURVIVES.
  assert.ok('currency' in body, 'spec-required body field survives the skeleton merge (merge, not replace)');

  // No flat placeholder for a STRUCTURED field.
  assert.doesNotMatch(bash, /"productItems"\s*:\s*"<productItems>"/, 'no flat placeholder for the nested field');

  // FUNCTIONAL proof that bash actually EXPANDS the heredoc body. A string-level
  // assertion on `<<JSON` can drift; this runs the rendered script under a curl
  // shim that captures the @- body a real curl would POST, then asserts the
  // captured bytes contain the EXPANDED product id and NOT the literal
  // ${PRODUCT_ID}. Flip `<<JSON` to `<<'JSON'` and this goes red (the shell posts
  // the literal placeholder). curl + jq are shimmed as functions so the check is
  // hermetic (no external tools). The rendered fill-in block assigns each var to
  // "" and a :? guard aborts on empty, so we rewrite those declarations to test
  // values -- PRODUCT_ID to a distinctive sentinel we assert on.
  const SENTINEL = 'SENTINEL_PRODUCT_9f3z';
  const filled = bash.replace(/^([A-Z0-9_]+)=""/gm,
    (_line, name) => (name === 'PRODUCT_ID' ? `${name}="${SENTINEL}"` : `${name}="x"`));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-shim-'));
  try {
    const scriptFile = path.join(tmpDir, 'run.sh');
    const captureFile = path.join(tmpDir, 'body.json');
    // Shims defined ahead of the rendered script. curl appends its stdin (the @-
    // heredoc body) to the capture file and prints `{}` so the $(...) capture +
    // downstream `jq -r` stay happy; jq drains stdin and prints null.
    const shim = `CURL_CAPTURE=${JSON.stringify(captureFile)}
curl() { cat >> "\$CURL_CAPTURE"; printf '{}'; }
jq() { cat >/dev/null 2>&1 || true; printf 'null'; }
`;
    fs.writeFileSync(scriptFile, `${shim}${filled}`);
    // stdin ignored (/dev/null) so the second step's inline -d curl doesn't block
    // its shim's `cat`; only the first step feeds a heredoc.
    execFileSync('bash', [scriptFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    const captured = fs.readFileSync(captureFile, 'utf8');
    assert.ok(captured.includes(SENTINEL),
      'bash EXPANDED ${PRODUCT_ID} in the POSTed body -- proves the heredoc is unquoted');
    assert.ok(!captured.includes('${PRODUCT_ID}'),
      'POSTed body must NOT contain the literal ${PRODUCT_ID} (would mean a quoted heredoc shipped the placeholder)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Fix A: a body field that idPassing threads (createOrder.basketId from createBasket)
// renders as ${BASKET_ID}, not the dead <basketId> literal, and is emitted
// expansion-safe (a single-quoted -d would ship the literal ${BASKET_ID}).
{
  const plan = {
    targetSlug: 'createOrder', reference: 'shopper-orders', combinedScopes: ['sfcc.shopper-baskets'],
    idPassing: [{ consumer: 'createOrder', inputs: [{ field: 'basketId', from: 'createBasket' }] }],
    authBranch: 'unknown', auth: null,
    steps: [
      { slug: 'createBasket', reference: 'shopper-baskets-v2', basePath: '/checkout/shopper-baskets/v1',
        method: 'POST', path: '/organizations/{organizationId}/baskets',
        specUrl: 'https://developer.salesforce.com/x?meta=createBasket',
        produces: [{ name: 'Basket', ref: '#/components/schemas/Basket' }],
        requiredInputs: [], requestAuth: { query: {}, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basketId', consumer: 'createOrder' }] },
      { slug: 'createOrder', reference: 'shopper-orders', basePath: '/checkout/shopper-orders/v1',
        method: 'POST', path: '/organizations/{organizationId}/orders',
        specUrl: 'https://developer.salesforce.com/x?meta=createOrder',
        produces: [], requiredInputs: [{ name: 'basketId', in: 'body' }],
        requestAuth: { query: {}, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basketId', producer: 'createBasket' }] },
    ],
  };
  const bash = renderCurlBlock({ plan });

  // The createOrder body threads the captured id as ${BASKET_ID}, not <basketId>.
  assert.match(bash, /\$\{BASKET_ID\}/, 'threaded body id rendered as ${BASKET_ID}');
  assert.doesNotMatch(bash, /<basketId>/, 'dead <basketId> literal is gone');

  // Expansion-safe: the createOrder body must NOT be single-quoted (single quotes
  // would ship the literal ${BASKET_ID}). Functional proof via the curl shim: run
  // the rendered script, capture what curl would POST for the FINAL step, assert
  // the captured bytes contain an expanded value and NOT the literal ${BASKET_ID}.
  // The producer capture jq-shim returns a sentinel basket id.
  const SENTINEL = 'BID_SENTINEL_7k2';
  const filled = bash.replace(/^([A-Z0-9_]+)=""/gm, (_l, n) => `${n}="x"`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixA-shim-'));
  try {
    const scriptFile = path.join(tmpDir, 'run.sh');
    const captureFile = path.join(tmpDir, 'bodies.txt');
    // curl: append stdin (heredoc @- bodies) AND args to the capture, print a JSON
    // object carrying basketId=SENTINEL so the producer's `jq -r .basketId` capture
    // yields the sentinel that the consumer body must then expand.
    const shim = `CURL_CAPTURE=${JSON.stringify(captureFile)}
curl() { for a in "$@"; do printf '%s\\n' "$a" >> "$CURL_CAPTURE"; done; cat >> "$CURL_CAPTURE" 2>/dev/null || true; printf '{"basketId":"${SENTINEL}"}'; }
jq() { printf '${SENTINEL}'; }
`;
    fs.writeFileSync(scriptFile, `${shim}${filled}`);
    execFileSync('bash', [scriptFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    const captured = fs.readFileSync(captureFile, 'utf8');
    assert.ok(captured.includes(SENTINEL), 'bash EXPANDED ${BASKET_ID} into the POSTed body');
    assert.ok(!captured.includes('${BASKET_ID}'), 'POSTed body has no literal ${BASKET_ID} (would mean single-quoted -d)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Fix C: a required in:query param (SCAPI siteId) renders in the URL query string,
// merged with the auth floor. OCAPI (siteId in path, no query requiredInput) is
// byte-identical.
{
  // SCAPI createBasket: siteId is a required query input, no auth-floor query.
  const scapi = {
    targetSlug: 'createBasket', reference: 'shopper-baskets-v2', combinedScopes: ['x'], idPassing: [],
    authBranch: 'unknown', auth: null,
    steps: [
      { slug: 'createBasket', reference: 'shopper-baskets-v2', basePath: '/checkout/shopper-baskets/v2',
        method: 'POST', path: '/organizations/{organizationId}/baskets',
        specUrl: 'https://developer.salesforce.com/x?meta=createBasket',
        produces: [], requestAuth: { query: {}, bearer: true },
        requiredInputs: [
          { name: 'organizationId', in: 'path' },
          { name: 'siteId', in: 'query' },
        ],
        evidence: [{ kind: 'target' }] },
    ],
  };
  const sbash = renderCurlBlock({ plan: scapi });
  assert.match(sbash, /\/baskets\?siteId=\$\{SITE_ID\}/, 'SCAPI required siteId renders in the URL query');
  assert.doesNotMatch(sbash, /client_id=/, 'SCAPI has no client_id floor');

  // OCAPI post-baskets: siteId is in the basePath, requiredInputs query is empty,
  // client_id is the only (floor) query param. Fix C must not change this.
  const ocapi = {
    targetSlug: 'post-baskets', reference: 'ocapi-shop-baskets', combinedScopes: ['x'], idPassing: [],
    authBranch: 'unknown', auth: null,
    steps: [
      { slug: 'post-baskets', reference: 'ocapi-shop-baskets', basePath: '/s/{siteId}/dw/shop/v25_6',
        method: 'POST', path: '/baskets',
        specUrl: 'https://developer.salesforce.com/x?meta=post-baskets',
        produces: [], requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: true },
        requiredInputs: [{ name: 'organizationId', in: 'path' }],
        evidence: [{ kind: 'target' }] },
    ],
  };
  const obash = renderCurlBlock({ plan: ocapi });
  assert.match(obash, /\/s\/\$\{SITE_ID\}\/dw\/shop\/v25_6\/baskets\?client_id=\$\{CLIENT_ID\}/, 'OCAPI URL unchanged: client_id floor only, siteId in path');
  assert.doesNotMatch(obash, /baskets\?siteId=/, 'OCAPI does NOT gain a query siteId (it is a path segment)');
  // No double siteId in the URL. The actual failure mode is a URL that carries
  // siteId in BOTH the path segment and a query param, so scope the check to the
  // curl URL line (the one under the `curl -sS` open, holding ${BASE_URL}...). A
  // whole-file scan would false-positive on the fill-in preflight, which
  // legitimately repeats ${SITE_ID} in `${SITE_ID:?fill in SITE_ID above}`.
  const urlLine = obash.split('\n').find((l) => l.includes('${BASE_URL}') && l.includes('/dw/shop/'));
  assert.ok(urlLine, 'OCAPI URL line present');
  assert.equal((urlLine.match(/site_?id/gi) || []).length, 1, 'URL renders siteId exactly once (path segment only, no query duplicate)');
}

// Fix C invariant: no auth-floor query key is ALSO a required query param name.
// This asserts the DATA CONTRACT (the floor keys the auth providers emit vs the
// query-required names the walk surfaces do not overlap), not the renderer output --
// it guards against a future provider/spec change introducing a collision the
// floor-wins dedup would then silently resolve. To exercise a realistic step, this
// mirrors the OCAPI post-baskets shape (client_id floor, no query-required input);
// if a real plan ever surfaced an overlapping name, this reddens and a human picks
// the winner. (The dedup in curl-block.js defines behavior; this test flags the
// need for a decision.)
{
  const plan = {
    targetSlug: 'post-baskets', reference: 'ocapi-shop-baskets', combinedScopes: ['x'], idPassing: [],
    authBranch: 'unknown', auth: null,
    steps: [{ slug: 'post-baskets', reference: 'ocapi-shop-baskets', basePath: '/s/{siteId}/dw/shop/v25_6',
      method: 'POST', path: '/baskets', specUrl: 'https://developer.salesforce.com/x?meta=post-baskets',
      produces: [], requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: true },
      requiredInputs: [{ name: 'organizationId', in: 'path' }], evidence: [{ kind: 'target' }] }],
  };
  for (const step of plan.steps) {
    const floorKeys = new Set(Object.keys((step.requestAuth && step.requestAuth.query) || {}));
    const reqQueryNames = step.requiredInputs.filter((i) => i.in === 'query' && i.name).map((i) => i.name);
    const collision = reqQueryNames.filter((n) => floorKeys.has(n));
    assert.equal(collision.length, 0, `no floor/required-query collision on ${step.slug} (got ${collision})`);
  }
}

// A+B+C interaction: a SLAS-guest createOrder+createBasket plan composes a runnable
// whose fill-in block carries CHANNEL_ID (Fix B) + SITE_ID (Fix C) but NOT BASKET_ID
// (Fix A, producer-assigned) or ACCESS_TOKEN (auth-assigned). Cache-free: renderer +
// auth preamble are pure functions of the plan.
{
  const plan = {
    targetSlug: 'createOrder', reference: 'shopper-orders', combinedScopes: ['sfcc.shopper-baskets-orders.rw'],
    idPassing: [{ consumer: 'createOrder', inputs: [{ field: 'basketId', from: 'createBasket' }] }],
    authBranch: 'shopper-slas',
    authFlow: { slugs: ['authorizeCustomer', 'getAccessToken'], authorizeHint: 'guest', grantType: 'authorization_code_pkce' },
    auth: { branch: 'shopper-slas', tier: null, token: null },
    steps: [
      { slug: 'createBasket', reference: 'shopper-baskets-v2', basePath: '/checkout/shopper-baskets/v2',
        method: 'POST', path: '/organizations/{organizationId}/baskets',
        specUrl: 'https://developer.salesforce.com/x?meta=createBasket', produces: [{ name: 'Basket' }],
        requiredInputs: [{ name: 'siteId', in: 'query' }], requestAuth: { query: {}, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basketId', consumer: 'createOrder' }] },
      { slug: 'createOrder', reference: 'shopper-orders', basePath: '/checkout/shopper-orders/v1',
        method: 'POST', path: '/organizations/{organizationId}/orders',
        specUrl: 'https://developer.salesforce.com/x?meta=createOrder', produces: [],
        requiredInputs: [{ name: 'siteId', in: 'query' }, { name: 'basketId', in: 'body' }],
        requestAuth: { query: {}, bearer: true },
        evidence: [{ kind: 'structural', viaField: 'basketId', producer: 'createBasket' }] },
    ],
  };
  const bash = renderCurlBlock({ plan });
  const fillVars = (bash.match(/^([A-Z0-9_]+)=""/gm) || []).map((l) => l.replace(/=.*/, ''));
  assert.ok(fillVars.includes('CHANNEL_ID'), 'CHANNEL_ID is a fill-in var (Fix B)');
  assert.ok(fillVars.includes('SITE_ID'), 'SITE_ID is a fill-in var (Fix C)');
  assert.ok(!fillVars.includes('BASKET_ID'), 'BASKET_ID NOT a fill-in var (producer-assigned, Fix A)');
  assert.ok(!fillVars.includes('ACCESS_TOKEN'), 'ACCESS_TOKEN NOT a fill-in var (auth-assigned)');
  assert.match(bash, /\$\{BASKET_ID\}/, 'createOrder body threads ${BASKET_ID}');
  assert.match(bash, /\/orders\?siteId=\$\{SITE_ID\}/, 'createOrder URL carries ?siteId=');
  assert.match(bash, /channel_id=\$\{CHANNEL_ID\}/, 'token exchange carries channel_id');
}

console.log('ok');
