'use strict';

const assert = require('node:assert/strict');
const { renderAuthPreamble } = require('../../../shared/products/commerce-b2c/auth-render.js');

// A SLAS guest plan (the resolver's default shopper flow).
const slasGuestPlan = {
  authBranch: 'shopper-slas',
  authFlow: { slugs: ['authorizeCustomer', 'getAccessToken'], authorizeHint: 'guest', grantType: 'authorization_code_pkce', label: 'SLAS guest (public client + PKCE)' },
  auth: { branch: 'shopper-slas', tier: null, token: null },
  combinedScopes: ['sfcc.shopper-baskets-orders.rw'],
  steps: [],
};

// --- unknown / degrade ---
assert.equal(renderAuthPreamble({ authBranch: 'unknown' }), null, 'unknown branch -> null');
assert.equal(renderAuthPreamble({ authBranch: 'shopper-slas', authFlow: null }), null, 'missing flow -> null (degrade, no half-preamble)');

// --- SLAS guest ---
{
  const out = renderAuthPreamble(slasGuestPlan);
  assert.ok(out && Array.isArray(out.lines) && Array.isArray(out.sources), 'returns {lines,sources}');
  const bash = out.lines.join('\n');
  // PKCE setup (reused from pkce.js -- 96-byte form).
  assert.match(bash, /CODE_VERIFIER=\$\(openssl rand -base64 96/, 'PKCE verifier line present');
  assert.match(bash, /CODE_CHALLENGE=\$\(printf %s "\$CODE_VERIFIER"/, 'PKCE challenge line present');
  // Leg 1: authorize with hint=guest, single ${BASE_URL}, org path, 303 capture (NOT jq).
  assert.match(bash, /\$\{BASE_URL\}\/shopper\/auth\/v1\/organizations\/\$\{ORGANIZATION_ID\}\/oauth2\/authorize/, 'authorize on single BASE_URL + org path');
  assert.match(bash, /hint=guest/, 'guest hint');
  assert.match(bash, /-o \/dev\/null -w '%\{redirect_url\}'/, '303 redirect capture, not a JSON body');
  assert.match(bash, /AUTH_CODE=\$\(printf '%s' "\$AUTH_LOCATION" \| grep -oE 'code=/, 'auth code grepped from Location');
  assert.doesNotMatch(bash, /authorizationCode|JSON\.parse|json\.load/, 'never parse the code as JSON');
  // Leg 2: token exchange -> ACCESS_TOKEN via jq (the PRODUCER seam #1 exists to close).
  assert.match(bash, /\/oauth2\/token/, 'token endpoint');
  assert.match(bash, /grant_type=authorization_code_pkce/, 'PKCE grant on the token leg');
  assert.match(bash, /ACCESS_TOKEN=\$\(echo "\$TOKEN_RESPONSE" \| jq -r \.access_token\)/, 'ACCESS_TOKEN produced by jq on the token body');
  // Fix B: the guest token exchange must carry channel_id (SLAS requires it on
  // token requests as of 2024-07-31; without it the guest token 400s).
  assert.match(bash, /--data-urlencode "channel_id=\$\{SITE_ID\}"/, 'guest token exchange carries channel_id (value from SITE_ID)');
  // No separate SLAS base var.
  assert.doesNotMatch(bash, /SLAS_BASE_URL/, 'single BASE_URL, no separate SLAS base var');
  // sources cite the canonical `auth` slug for both legs.
  assert.ok(out.sources.some((u) => /references\/auth\?meta=authorizeCustomer$/.test(u)), 'cites authorizeCustomer');
  assert.ok(out.sources.some((u) => /references\/auth\?meta=getAccessToken$/.test(u)), 'cites getAccessToken');
  assert.ok(out.sources.every((u) => /^https:\/\/developer\.salesforce\.com\//.test(u)), 'all sources are DSC URLs');
}

// --- SLAS registered-b2c ---
{
  const plan = {
    authBranch: 'shopper-slas',
    authFlow: { slugs: ['authenticateCustomer', 'getAccessToken'], grantType: 'authorization_code_pkce', label: 'SLAS registered, B2C-IDP (default OOTB)' },
    auth: { branch: 'shopper-slas', tier: null, token: null }, combinedScopes: [], steps: [],
  };
  const bash = renderAuthPreamble(plan).lines.join('\n');
  assert.match(bash, /\/oauth2\/login/, 'login leg present');
  // Credentials are braced (${SHOPPER_USER}) so scanFillInVars surfaces them as
  // fill-in vars -- a bare $SHOPPER_USER never surfaces and the runnable aborts
  // under set -u. See test-curl-block.js fill-in-completeness case.
  assert.match(bash, /Authorization: Basic \$\(printf '%s:%s' "\$\{SHOPPER_USER\}" "\$\{SHOPPER_PASS\}" \| base64\)/, 'shopper Basic header (braced creds)');
  assert.match(bash, /channel_id=\$\{SITE_ID\}/, 'channel_id required param present (value from SITE_ID)');
  assert.match(bash, /CODE_VERIFIER=/, 'PKCE still set up for the token exchange');
  // Bans: no grant_type on the login leg; no fabricated params.
  const loginBlock = bash.slice(bash.indexOf('/oauth2/login'), bash.indexOf('/oauth2/token'));
  assert.doesNotMatch(loginBlock, /grant_type/, 'NO grant_type on /login');
  assert.doesNotMatch(bash, /login_id=|login_password|channel_type|response_type/, 'no fabricated login params');
  assert.match(bash, /ACCESS_TOKEN=\$\(echo "\$TOKEN_RESPONSE" \| jq -r \.access_token\)/, 'token via jq');
  const out = renderAuthPreamble(plan);
  assert.ok(out.sources.some((u) => /auth\?meta=authenticateCustomer$/.test(u)), 'cites authenticateCustomer');
}

// --- SLAS registered-federated (interactive; AUTH_CODE is a fill-in seam) ---
{
  const plan = {
    authBranch: 'shopper-slas',
    authFlow: { slugs: ['authorizeCustomer', 'getAccessToken'], authorizeHint: '<idp-name>', grantType: 'authorization_code_pkce', label: 'SLAS registered, federated IDP' },
    auth: { branch: 'shopper-slas', tier: null, token: null }, combinedScopes: [], steps: [],
  };
  const bash = renderAuthPreamble(plan).lines.join('\n');
  assert.match(bash, /\/oauth2\/authorize/, 'authorize leg present');
  assert.match(bash, /hint=\$\{IDP_NAME\}/, 'idp-name hint is a fill-in var');
  // The one sanctioned manual seam: a browser/paste instruction, and AUTH_CODE is NOT script-assigned.
  assert.match(bash, /(?:open .*browser|paste the.{0,12}code|authenticate at)/i, 'browser/paste instruction for the interactive IDP');
  assert.doesNotMatch(bash, /^AUTH_CODE=/m, 'AUTH_CODE is NOT auto-assigned on the federated flow (it is a fill-in seam)');
  // Federated must NEVER mention the B2C login op.
  assert.doesNotMatch(bash, /oauth2\/login|authenticateCustomer/, 'no B2C login op in a federated plan');
}

// --- SLAS tsob (single trusted-system POST) ---
{
  const plan = {
    authBranch: 'shopper-slas',
    authFlow: { slugs: ['getTrustedSystemAccessToken'], grantType: 'client_credentials', label: 'SLAS trusted system on behalf of (private client)' },
    auth: { branch: 'shopper-slas', tier: null, token: null }, combinedScopes: [], steps: [],
  };
  const bash = renderAuthPreamble(plan).lines.join('\n');
  assert.match(bash, /\/oauth2\/trusted-system\/token/, 'trusted-system token endpoint');
  assert.match(bash, /grant_type=client_credentials/, 'client_credentials grant');
  assert.match(bash, /hint=ts_ext_on_behalf_of/, 'tsob hint');
  assert.match(bash, /login_id=\$\{LOGIN_ID\}/, 'login_id form field');
  assert.doesNotMatch(bash, /CODE_VERIFIER=/, 'no PKCE on tsob');
  assert.match(bash, /ACCESS_TOKEN=\$\(echo/, 'token via jq');
}

// --- AM private-cc (SCAPI Admin default) ---
{
  const plan = {
    authBranch: 'am',
    authFlow: { tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token', grantType: 'client_credentials', label: 'Account Manager (private client + client_credentials)' },
    auth: { branch: 'am', tier: null, token: null }, combinedScopes: ['sfcc.orders'], steps: [],
  };
  const out = renderAuthPreamble(plan);
  const bash = out.lines.join('\n');
  assert.match(bash, /account\.demandware\.com\/dwsso\/oauth2\/access_token/, 'canonical AM host (.com)');
  assert.doesNotMatch(bash, /account\.demandware\.net/, 'never the .net host');
  assert.doesNotMatch(bash, /\$\{BASE_URL\}[^\n]*demandware/, 'AM host is absolute, not under BASE_URL');
  assert.match(bash, /Authorization: Basic \$\(printf '%s:%s' "\$\{AM_CLIENT_ID\}" "\$\{AM_CLIENT_SECRET\}" \| base64\)/, 'AM Basic header (braced creds)');
  assert.match(bash, /grant_type=client_credentials/, 'client_credentials grant');
  assert.match(bash, /SALESFORCE_COMMERCE_API:\$\{AM_TENANT\}/, 'tenant-scoped role in the scope');
  assert.match(bash, /sfcc\.orders/, 'API scopes from combinedScopes appended');
  assert.match(bash, /ACCESS_TOKEN=\$\(echo/, 'token via jq');
  assert.doesNotMatch(bash, /CODE_VERIFIER=/, 'no PKCE on private-cc');
  // AM contributes NO source -- the Note is the citation contract, never a fabricated DSC URL.
  assert.deepEqual(out.sources, [], 'AM legs cite no DSC URL');
}

// --- AM public-pkce ---
{
  const plan = {
    authBranch: 'am',
    authFlow: { tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token', grantType: 'authorization_code_pkce', label: 'Account Manager (public client + PKCE)' },
    auth: { branch: 'am', tier: null, token: null }, combinedScopes: ['sfcc.orders'], steps: [],
  };
  const bash = renderAuthPreamble(plan).lines.join('\n');
  assert.match(bash, /CODE_VERIFIER=/, 'PKCE set up for public-pkce');
  assert.match(bash, /account\.demandware\.com\/dwsso\/oauth2\/authorize/, 'AM authorize leg');
  assert.match(bash, /grant_type=authorization_code_pkce/, 'PKCE grant on the token exchange');
  assert.match(bash, /ACCESS_TOKEN=\$\(echo/, 'token via jq');
  // Fix B must NOT leak into AM: Account Manager token exchange has no channel_id.
  assert.doesNotMatch(bash, /channel_id/, 'AM token exchange has no channel_id (different flow)');
  assert.deepEqual(renderAuthPreamble(plan).sources, [], 'AM legs cite no DSC URL');
}

// --- OCAPI Shop shopper tier: customers/auth guest, header capture ---
{
  const plan = {
    authBranch: 'ocapi-shop',
    authFlow: null,
    auth: { branch: 'ocapi-shop', tier: 'shopper', token: { flow: 'ocapi-customers-auth', reference: 'ocapi-shop-customers', slug: 'post-customers-auth', method: 'POST', path: '/customers/auth', body: { type: 'guest' }, tokenIn: 'response-header' } },
    combinedScopes: [],
    steps: [ { slug: 'post-baskets', reference: 'ocapi-shop-baskets', basePath: '/s/{siteId}/dw/shop/v25_6', method: 'POST', path: '/baskets' } ],
  };
  const out = renderAuthPreamble(plan);
  const bash = out.lines.join('\n');
  assert.match(bash, /\/customers\/auth/, 'customers/auth leg');
  assert.match(bash, /-d '\{"type":"guest"\}'/, 'guest body');
  // JWT from the response Authorization header -- NOT jq.
  assert.match(bash, /curl -sS -D -/, 'dump response headers');
  assert.match(bash, /grep -i '\^authorization:'/, 'grep the Authorization header');
  assert.doesNotMatch(bash, /jq -r \.access_token/, 'OCAPI JWT is NOT a jq body parse');
  assert.match(bash, /ACCESS_TOKEN=/, 'ACCESS_TOKEN captured');
  // URL uses the shop base with the version lifted from the sibling step; snake SITE_ID.
  assert.match(bash, /\/s\/\$\{SITE_ID\}\/dw\/shop\/v25_6\/customers\/auth\?client_id=\$\{CLIENT_ID\}/, 'shop base + client_id floor');
  // Credentials bounded seam is reachable (regression guard for the deferred registered flow).
  assert.match(bash, /\{"type":"credentials"\}/, 'credentials adjustment named');
  assert.match(bash, /SHOPPER_USER|SHOPPER_PASS/, 'credentials seam names the shopper Basic header');
  assert.ok(out.sources.some((u) => /ocapi-shop-customers\?meta=post-customers-auth$/.test(u)), 'cites customers/auth');
}

// --- OCAPI Shop client-id tier: no preamble ---
{
  const plan = {
    authBranch: 'ocapi-shop',
    auth: { branch: 'ocapi-shop', tier: 'client-id', token: null },
    combinedScopes: [], steps: [ { basePath: '/s/{siteId}/dw/shop/v25_6' } ],
  };
  const out = renderAuthPreamble(plan);
  assert.ok(out && Array.isArray(out.lines) && out.lines.length === 0, 'client-id tier renders no auth leg (public read)');
}

// --- OCAPI Data: AM app token, no tenant scope ---
{
  const plan = {
    authBranch: 'ocapi-data',
    auth: { branch: 'ocapi-data', tier: 'app-token', token: { flow: 'am-app-token', tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token', grantType: 'client_credentials' } },
    combinedScopes: [], steps: [],
  };
  const out = renderAuthPreamble(plan);
  const bash = out.lines.join('\n');
  assert.match(bash, /account\.demandware\.com\/dwsso\/oauth2\/access_token/, 'AM host for Data');
  assert.match(bash, /grant_type=client_credentials/, 'client_credentials');
  assert.doesNotMatch(bash, /SALESFORCE_COMMERCE_API/, 'OCAPI Data needs NO tenant role scope');
  assert.match(bash, /ACCESS_TOKEN=\$\(echo/, 'token via jq');
  assert.deepEqual(out.sources, [], 'AM-host Data leg cites no DSC URL');
}

console.log('ok');
