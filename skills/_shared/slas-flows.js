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
    tokenUrl: 'https://account.demandware.net/dwsso/oauth2/access_token',
    grantType: 'client_credentials',
    label: 'Account Manager (private client + client_credentials)',
  },
  'public-pkce': {
    tokenUrl: 'https://account.demandware.net/dwsso/oauth2/access_token',
    grantType: 'authorization_code_pkce',
    label: 'Account Manager (public client + PKCE)',
  },
};

// Branch ordering is deliberate: ShopperToken first (most-specific Commerce
// shopper case), then BearerToken+SLAS_* before plain AmOAuth2 (the SLAS-Admin
// variant uses the same AM token mechanism but routes via a scope-aware
// check), then OCAPI multi-scheme. Anything else returns 'unknown'.
function pickAuthBranch(targetSecurity) {
  const security = targetSecurity || [];
  const schemes = security.map((s) => s.scheme).filter(Boolean);
  if (schemes.includes('ShopperToken')) return 'shopper-slas';
  const bearerWithSlasAdmin = security.some(
    (s) => s.scheme === 'BearerToken' && (s.scopes || []).some((sc) => /^SLAS_/.test(sc))
  );
  if (bearerWithSlasAdmin) return 'am';
  if (schemes.includes('AmOAuth2')) return 'am';
  if (schemes.some((s) => ['customers_auth', 'oauth2_application', 'client_id'].includes(s))) {
    return 'shopper-slas';
  }
  return 'unknown';
}

function pickShopperFlow(signal) {
  return SHOPPER_FLOWS[signal] || SHOPPER_FLOWS.guest;
}

function pickAmFlow(signal) {
  return AM_FLOWS[signal] || AM_FLOWS['private-cc'];
}

module.exports = { SHOPPER_FLOWS, AM_FLOWS, pickAuthBranch, pickShopperFlow, pickAmFlow };
