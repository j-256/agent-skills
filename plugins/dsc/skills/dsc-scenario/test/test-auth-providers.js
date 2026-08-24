'use strict';

// Product-neutral auth-provider registry + B2C's provider set.
//
// The registry is the single auth router: given a target's identity
// (area / reference / security[] / method / path) it returns the resolved
// provider (branch + lightest-sufficient tier + request-auth shape +
// per-branch prerequisites). B2C registers four providers; another product
// would register its own without touching B2C code or the generic layer.
//
// These assertions are the contract behind the OCAPI auth-routing fix: route
// on REFERENCE FAMILY (ocapi-shop-* vs ocapi-data-*), never the declared
// scheme (Shop and Data both declare oauth2_application/client_id, so the
// scheme can't disambiguate them).

const assert = require('node:assert/strict');
const { resolveAuthProvider } = require('../../../shared/engine/auth-providers.js');
const { AUTH_PROVIDERS } = require('../../../shared/products/commerce-b2c/auth-providers.js');

const resolve = (context) => resolveAuthProvider({ context, providers: AUTH_PROVIDERS });

// SCAPI Shopper: ShopperToken -> shopper-slas, no OCAPI request-auth (bearer only).
{
  const r = resolve({
    area: 'commerce_commerce-api', reference: 'shopper-orders', method: 'POST', path: '/orders',
    security: [{ scheme: 'ShopperToken', scopes: ['sfcc.shopper-orders.rw'] }],
  });
  assert.equal(r.branch, 'shopper-slas', 'ShopperToken routes to shopper-slas');
  assert.equal(r.tier, null, 'SCAPI branches have no OCAPI tier');
  // SCAPI calls carry no client_id query param and always send the bearer.
  assert.deepEqual(r.requestAuth.query, {}, 'no client_id on SCAPI');
  assert.equal(r.requestAuth.bearer, true, 'SCAPI sends a bearer token');
}

// SCAPI Admin: AmOAuth2 -> am.
{
  const r = resolve({
    area: 'commerce_commerce-api', reference: 'orders', method: 'GET', path: '/orders/{orderNo}',
    security: [{ scheme: 'AmOAuth2', scopes: ['sfcc.orders'] }],
  });
  assert.equal(r.branch, 'am', 'AmOAuth2 routes to am');
  assert.equal(r.requestAuth.bearer, true);
  assert.deepEqual(r.requestAuth.query, {});
}

// SCAPI Admin via BearerToken + SLAS_* scopes -> am.
{
  const r = resolve({
    area: 'commerce_commerce-api', reference: 'auth-admin', method: 'POST', path: '/x',
    security: [{ scheme: 'BearerToken', scopes: ['SLAS_ORGANIZATION_ADMIN'] }],
  });
  assert.equal(r.branch, 'am', 'BearerToken+SLAS_* routes to am');
}

// OCAPI Shop: routes on family, NOT scheme. post-orders declares the same
// customers_auth/oauth2_application/client_id set as a Data op, so only the
// ocapi-shop-* family disambiguates it. A write op (POST /orders) is a
// shopper-state op -> Tier 2 (shopper token), lightest-sufficient.
{
  const r = resolve({
    area: 'commerce_b2c-commerce', reference: 'ocapi-shop-orders', method: 'POST', path: '/orders',
    security: [
      { scheme: 'customers_auth', scopes: [] },
      { scheme: 'oauth2_application', scopes: [] },
      { scheme: 'client_id', scopes: [] },
    ],
  });
  assert.equal(r.branch, 'ocapi-shop', 'ocapi-shop-* family routes to ocapi-shop, not shopper-slas');
  assert.equal(r.tier, 'shopper', 'a shopper-state write picks the shopper tier');
  // The floor: client_id is always present on OCAPI calls.
  assert.equal(r.requestAuth.query.client_id, '$CLIENT_ID', 'client_id always emitted on OCAPI');
  assert.equal(r.requestAuth.bearer, true, 'Tier 2 sends a shopper bearer token');
  // The default shopper flow is OCAPI-native customers/auth, NOT SLAS.
  assert.ok(r.token, 'shopper tier carries a token-getting flow');
  assert.equal(r.token.flow, 'ocapi-customers-auth', 'default shopper flow is OCAPI-native customers/auth');
  assert.equal(r.token.tokenIn, 'response-header', 'the JWT is captured from the response Authorization header');
  assert.equal(r.token.slug, 'post-customers-auth');
  assert.equal(r.token.reference, 'ocapi-shop-customers');
  // Per-branch prerequisite: the OCAPI-settings allowlist (instance-config).
  assert.ok(Array.isArray(r.prerequisites) && r.prerequisites.length >= 1);
  assert.ok(r.prerequisites.some((p) => p.kind === 'instance-config' && /OCAPI settings/i.test(p.text)),
    'ocapi-shop surfaces the OCAPI-settings allowlist prerequisite');
}

// OCAPI Shop, PROVEN-PUBLIC read: GET /products/{id} is verified client_id-only
// (Tier 1). The curated public-read list is the per-op override the matrix doc
// calls out -- the tier boundary is NOT derivable from security[] (post-baskets
// LISTS client_id yet 401s without a shopper token). Conservative default: only
// the proven-public reads drop to Tier 1; everything else stays Tier 2.
{
  const r = resolve({
    area: 'commerce_b2c-commerce', reference: 'ocapi-shop-products', method: 'GET', path: '/products/{id}',
    security: [{ scheme: 'client_id', scopes: [] }, { scheme: 'customers_auth', scopes: [] }],
  });
  assert.equal(r.branch, 'ocapi-shop');
  assert.equal(r.tier, 'client-id', 'proven-public read picks the client_id-only tier');
  assert.equal(r.requestAuth.query.client_id, '$CLIENT_ID', 'client_id still required (the floor)');
  assert.equal(r.requestAuth.bearer, false, 'Tier 1 needs NO token, just client_id');
  assert.equal(r.token, null, 'Tier 1 has no token-getting flow');
}

// OCAPI Shop, an unlisted GET stays Tier 2 (never under-auth). A read op that
// isn't on the curated proven-public list defaults to the shopper tier rather
// than guessing it's public from the security array (which is aspirational).
{
  const r = resolve({
    area: 'commerce_b2c-commerce', reference: 'ocapi-shop-orders', method: 'GET', path: '/orders/{order_no}',
    security: [
      { scheme: 'customers_auth', scopes: [] },
      { scheme: 'oauth2_application', scopes: [] },
      { scheme: 'client_id', scopes: [] },
    ],
  });
  assert.equal(r.branch, 'ocapi-shop');
  assert.equal(r.tier, 'shopper', 'an unlisted GET stays Tier 2 (conservative; never under-auth)');
}

// OCAPI Data: routes on family to ocapi-data, AM app token + Data request shape.
{
  const r = resolve({
    area: 'commerce_b2c-commerce', reference: 'ocapi-data-code-versions', method: 'GET', path: '/code_versions',
    security: [{ scheme: 'oauth2_application', scopes: [] }],
  });
  assert.equal(r.branch, 'ocapi-data', 'ocapi-data-* family routes to ocapi-data, not am');
  assert.equal(r.requestAuth.query.client_id, '$CLIENT_ID', 'Data calls also carry client_id');
  assert.equal(r.requestAuth.bearer, true, 'Data uses an AM app-token bearer');
  assert.ok(r.token, 'ocapi-data carries the AM app-token flow');
  assert.equal(r.token.flow, 'am-app-token');
  assert.equal(r.token.tokenUrl, 'https://account.demandware.com/dwsso/oauth2/access_token');
  assert.equal(r.token.grantType, 'client_credentials');
  assert.ok(r.prerequisites.some((p) => p.kind === 'instance-config'),
    'ocapi-data surfaces its instance-config prerequisite');
}

// An OCAPI Data op that (defensively) declares customers_auth must STILL route
// to ocapi-data by family -- the scheme never overrides the family.
{
  const r = resolve({
    area: 'commerce_b2c-commerce', reference: 'ocapi-data-orders', method: 'PATCH', path: '/sites/{site_id}/orders/{order_no}',
    security: [{ scheme: 'oauth2_application', scopes: [] }, { scheme: 'client_id', scopes: [] }],
  });
  assert.equal(r.branch, 'ocapi-data', 'family wins over any co-declared scheme');
}

// Unknown: a non-Commerce scheme with no family match -> null (compose maps to 'unknown').
{
  const r = resolve({
    area: 'marketing_marketing-cloud-growth', reference: 'some-ref', method: 'GET', path: '/x',
    security: [{ scheme: 'MarketingCloudAuth', scopes: [] }],
  });
  assert.equal(r, null, 'no provider matches -> null');
}

// Priority: a hypothetical op carrying ShopperToken in the OCAPI area still
// resolves shopper-slas (SCAPI providers are ordered before family providers),
// but real OCAPI ops never carry ShopperToken so this is only a guard.
{
  const r = resolve({
    area: 'commerce_b2c-commerce', reference: 'ocapi-shop-orders', method: 'POST', path: '/orders',
    security: [{ scheme: 'ShopperToken', scopes: ['x'] }],
  });
  assert.equal(r.branch, 'shopper-slas', 'ShopperToken (SCAPI provider) is checked before the family providers');
}

console.log('ok');
