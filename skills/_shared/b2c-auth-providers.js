'use strict';

// B2C Commerce's auth-provider set -- the product-specific data the generic
// `auth-providers.js` registry consumes. Everything here is B2C fact; the
// generic layer stays product-neutral. Another product would ship its own
// module exactly like this one and never touch B2C's.
//
// The four planes and how each is authenticated are documented in
// docs/commerce-auth-matrix.md (empirically verified against a live sandbox).
// The one-line version:
//   - SCAPI Shopper (ShopperToken)          -> shopper-slas  (SLAS shopper token)
//   - SCAPI Admin  (AmOAuth2 / SLAS_* )      -> am           (AM app token)
//   - OCAPI Shop   (ocapi-shop-* family)     -> ocapi-shop   (3-tier ladder)
//   - OCAPI Data   (ocapi-data-* family)     -> ocapi-data   (AM app token)
//
// CRITICAL routing rule: OCAPI Shop and OCAPI Data declare the SAME security
// schemes (oauth2_application / client_id / customers_auth), so the declared
// scheme cannot disambiguate them. Route on REFERENCE FAMILY. The SCAPI
// providers key off the scheme (via pickAuthBranch, a pure scheme classifier);
// the OCAPI providers key off the reference-family regex. SCAPI providers are
// ordered first so a (hypothetical) ShopperToken in the OCAPI area still routes
// shopper-slas, but real OCAPI ops never carry ShopperToken.

const { pickAuthBranch, AM_FLOWS } = require('./slas-flows.js');

const B2C_AREA = /^commerce_b2c-commerce$/;
const AM_TOKEN_URL = AM_FLOWS['private-cc'].tokenUrl; // single source of truth for the AM host

// Per-branch prerequisites: instance-config facts the skill cannot verify for a
// given instance, surfaced ONLY when that branch fires (so a SCAPI Shopper plan
// never carries OCAPI prose). `{kind, text, cite}` is product-neutral. `cite` is
// a developer.salesforce.com URL where one exists; null where the fact is
// undocumented on DSC (AM, OCAPI settings) -- there the note IS the citation
// contract, the same rule the AM-URL framing already follows.
const PREREQ = {
  am: {
    kind: 'instance-config',
    text: 'The AM token request scope must include SALESFORCE_COMMERCE_API:<tenant> (the instance/tenant, e.g. abcd_001, derivable from the org id f_ecom_<instance>) in addition to the API scopes, space-separated -- a bare role scope 403s at the resource.',
    cite: null,
  },
  'ocapi-shop': {
    kind: 'instance-config',
    text: 'The client whose token you use must be enabled in the instance\'s OCAPI settings (Business Manager > Administration > Site Development > Open Commerce API Settings) for the Shop API resources you call; OCAPI access is a Business Manager allowlist, denied by default.',
    cite: null,
  },
  'ocapi-data': {
    kind: 'instance-config',
    text: 'The client must be enabled for the Data API resources you call in the instance\'s OCAPI settings (Business Manager > Administration > Site Development > Open Commerce API Settings); elevated operations may additionally require a Business Manager user-grant token whose BM user holds the permission.',
    cite: null,
  },
};

// OCAPI Shop Tier-1 (client_id only, NO token) is a CURATED proven-public read
// list, not a security-array inference. The matrix doc's decisive finding: the
// Tier1/Tier2 boundary is NOT derivable from security[] -- post-baskets LISTS
// client_id yet 401s without a shopper token at runtime, and the array shape
// doesn't track read-vs-write. So the default is conservative (shopper tier),
// and only references verified public (catalog/storefront metadata: products,
// categories, site -- all returned 200 with just ?client_id= on the live
// sandbox) drop to Tier 1. This is exactly the per-op/curated override the
// generic layer allows where a pattern would be wrong.
const OCAPI_SHOP_PUBLIC_READS = [
  { referenceFamily: /^ocapi-shop-products$/, method: 'GET' },
  { referenceFamily: /^ocapi-shop-categories$/, method: 'GET' },
  { referenceFamily: /^ocapi-shop-site$/, method: 'GET' },
];

function isProvenPublicRead(context) {
  return OCAPI_SHOP_PUBLIC_READS.some(
    (r) => r.referenceFamily.test(context.reference || '') && r.method === (context.method || '').toUpperCase(),
  );
}

// The OCAPI-native shopper-token flow: POST /customers/auth on ocapi-shop-customers.
// Guest default ({"type":"guest"}); credentials variant adds a Basic shopper
// header. The JWT comes back in the RESPONSE Authorization header (not a JSON
// body) -- captured like the SLAS 303-Location idiom, NOT jq-parsed. SLAS works
// against OCAPI when the client is allowlisted, but it is a prose migration
// alternative only, never the emitted default (staying in the OCAPI family:
// someone asking about OCAPI already has an OCAPI client).
const OCAPI_CUSTOMERS_AUTH = Object.freeze({
  flow: 'ocapi-customers-auth',
  reference: 'ocapi-shop-customers',
  slug: 'post-customers-auth',
  method: 'POST',
  path: '/customers/auth',
  body: { type: 'guest' },
  tokenIn: 'response-header',
  label: 'OCAPI-native customers/auth (guest JWT)',
});

// The OCAPI Data app-token flow: AM client_credentials, same host/grant as the
// SCAPI-Admin AM flow (reuses AM_FLOWS' URL). Distinct branch id (ocapi-data),
// because the request shape and the prerequisite differ from SCAPI Admin.
const OCAPI_DATA_APP_TOKEN = Object.freeze({
  flow: 'am-app-token',
  tokenUrl: AM_TOKEN_URL,
  grantType: 'client_credentials',
  label: 'Account Manager app token (client_credentials)',
});

const B2C_AUTH_PROVIDERS = [
  // --- SCAPI providers: key off the declared scheme (pure classifier) ---
  {
    id: 'b2c-scapi-shopper',
    branch: 'shopper-slas',
    match: (c) => pickAuthBranch(c.security) === 'shopper-slas',
    // SLAS legs are selected by flowSignal in compose (pickShopperFlow); the
    // provider only fixes the branch + request shape (bearer, no client_id).
    resolve: () => ({ branch: 'shopper-slas', requestAuth: { query: {}, bearer: true }, token: null, prerequisites: [] }),
  },
  {
    id: 'b2c-scapi-admin',
    branch: 'am',
    match: (c) => pickAuthBranch(c.security) === 'am',
    resolve: () => ({ branch: 'am', requestAuth: { query: {}, bearer: true }, token: null, prerequisites: [PREREQ.am] }),
  },

  // --- OCAPI providers: key off the reference FAMILY, never the scheme ---
  {
    id: 'b2c-ocapi-shop',
    branch: 'ocapi-shop',
    match: (c) => B2C_AREA.test(c.area || '') && /^ocapi-shop-/.test(c.reference || ''),
    resolve: (c) => {
      // Tier 1 (client_id only, no token) for the curated proven-public reads;
      // Tier 2 (shopper token + client_id) for everything else -- the
      // conservative default that never under-auths.
      const isPublic = isProvenPublicRead(c);
      if (isPublic) {
        return {
          branch: 'ocapi-shop', tier: 'client-id',
          requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: false },
          token: null,
          prerequisites: [PREREQ['ocapi-shop']],
        };
      }
      return {
        branch: 'ocapi-shop', tier: 'shopper',
        requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: true },
        token: OCAPI_CUSTOMERS_AUTH,
        prerequisites: [PREREQ['ocapi-shop']],
      };
    },
  },
  {
    id: 'b2c-ocapi-data',
    branch: 'ocapi-data',
    match: (c) => B2C_AREA.test(c.area || '') && /^ocapi-data-/.test(c.reference || ''),
    resolve: () => ({
      branch: 'ocapi-data', tier: 'app-token',
      requestAuth: { query: { client_id: '$CLIENT_ID' }, bearer: true },
      token: OCAPI_DATA_APP_TOKEN,
      prerequisites: [PREREQ['ocapi-data']],
    }),
  },
];

module.exports = {
  B2C_AUTH_PROVIDERS,
  PREREQ,
  OCAPI_SHOP_PUBLIC_READS,
  OCAPI_CUSTOMERS_AUTH,
  OCAPI_DATA_APP_TOKEN,
};
