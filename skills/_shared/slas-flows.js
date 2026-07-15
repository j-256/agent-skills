'use strict';

const SHOPPER_FLOWS = {
  guest: {
    slugs: ['authorizeCustomer', 'getAccessToken'],
    authorizeHint: 'guest',
    grantType: 'authorization_code_pkce',
    label: 'SLAS guest (public client + PKCE)',
  },
  'registered-b2c': {
    slugs: ['authenticateCustomer', 'getAccessToken'],
    grantType: 'authorization_code_pkce',
    label: 'SLAS registered, B2C-IDP (default OOTB)',
  },
  'registered-federated': {
    slugs: ['authorizeCustomer', 'getAccessToken'],
    authorizeHint: '<idp-name>',
    grantType: 'authorization_code_pkce',
    label: 'SLAS registered, federated IDP',
  },
  tsob: {
    slugs: ['getTrustedSystemAccessToken'],
    grantType: 'client_credentials',
    label: 'SLAS trusted system on behalf of (private client)',
  },
};

const AM_FLOWS = {
  'private-cc': {
    tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token',
    grantType: 'client_credentials',
    label: 'Account Manager (private client + client_credentials)',
  },
  'public-pkce': {
    tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token',
    grantType: 'authorization_code_pkce',
    label: 'Account Manager (public client + PKCE)',
  },
};

// AM role-scope tenant rule. A SCAPI AmOAuth2 target requires the AM token to be
// scoped to the tenant: `SALESFORCE_COMMERCE_API:<tenantId>`, space-separated
// from the SCAPI API scopes. Verified live: a bare `SALESFORCE_COMMERCE_API`
// role is accepted as a scheme but denied at the resource (403); appending the
// tenant flips it to 200. SCAPI clients are instance-scoped and the suffix is
// mandatory. This is the same class of runtime-vs-spec defect as the AM
// `.net`->`.com` host fix: the emitted runnable *reads* right but 403s without it.
const AM_ROLE_SCOPE_PREFIX = 'SALESFORCE_COMMERCE_API';

// Build the tenant-scoped role literal. `tenant` is the instance/tenant (e.g. abcd_001)
// or a `<tenant>` placeholder when the skill doesn't know it; either is preserved
// verbatim after the colon.
function amRoleScope(tenant) {
  return `${AM_ROLE_SCOPE_PREFIX}:${tenant || '<tenant>'}`;
}

// Derive the tenant (instance) from an org id of the form `f_ecom_<instance>` (e.g.
// f_ecom_abcd_001 -> abcd_001). Returns null when the input isn't an f_ecom org
// id, so the caller can fall back to a `<tenant>` placeholder rather than emit a
// wrong literal.
function tenantFromOrg(orgId) {
  if (typeof orgId !== 'string') return null;
  const m = /^f_ecom_(.+)$/.exec(orgId);
  return m ? m[1] : null;
}

// SCAPI scheme classifier: maps a target's declared SCAPI auth scheme to its
// branch. ShopperToken first (SCAPI Shopper), then BearerToken+SLAS_* before
// plain AmOAuth2 (both the SLAS-Admin and vanilla-Admin variants use the AM
// token mechanism). Anything else -- including the OCAPI multi-scheme set
// (customers_auth / oauth2_application / client_id) -- returns 'unknown' HERE
// on purpose: OCAPI is NOT routable by scheme, because OCAPI Shop and OCAPI Data
// declare the same schemes. OCAPI routing is the reference-FAMILY providers'
// job (see b2c-auth-providers.js); this function is the SCAPI half only.
//
// (Before the OCAPI auth-branch iteration this function had a final clause that
// collapsed any OCAPI scheme to 'shopper-slas' -- that was the over-auth bug: a
// read-only OCAPI product lookup got a full SLAS PKCE flow, and OCAPI Data was
// mis-routed to a shopper token entirely. Family routing replaced it.)
function pickAuthBranch(targetSecurity) {
  const security = targetSecurity || [];
  const schemes = security.map((s) => s.scheme).filter(Boolean);
  if (schemes.includes('ShopperToken')) return 'shopper-slas';
  const bearerWithSlasAdmin = security.some(
    (s) => s.scheme === 'BearerToken' && (s.scopes || []).some((sc) => /^SLAS_/.test(sc))
  );
  if (bearerWithSlasAdmin) return 'am';
  if (schemes.includes('AmOAuth2')) return 'am';
  return 'unknown';
}

function pickShopperFlow(signal) {
  return SHOPPER_FLOWS[signal] || SHOPPER_FLOWS.guest;
}

function pickAmFlow(signal) {
  return AM_FLOWS[signal] || AM_FLOWS['private-cc'];
}

module.exports = {
  SHOPPER_FLOWS,
  AM_FLOWS,
  AM_ROLE_SCOPE_PREFIX,
  amRoleScope,
  tenantFromOrg,
  pickAuthBranch,
  pickShopperFlow,
  pickAmFlow,
};
