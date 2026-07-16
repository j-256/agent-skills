'use strict';

const assert = require('node:assert/strict');
const {
  SHOPPER_FLOWS,
  AM_FLOWS,
  pickAuthBranch,
  pickShopperFlow,
  pickAmFlow,
  AM_ROLE_SCOPE_PREFIX,
  amRoleScope,
  tenantFromOrg,
} = require('../lib/products/commerce-b2c/slas-flows.js');

// AM tenant-scope rule (verified live: a bare SALESFORCE_COMMERCE_API role 403s
// at the resource; SALESFORCE_COMMERCE_API:<tenant> returns 200). The tenant is
// the realm, derivable from the org id f_ecom_<realm>. Encoded as a fact here so
// the AM auth step renders the correct scope, not a bare role.
{
  assert.equal(AM_ROLE_SCOPE_PREFIX, 'SALESFORCE_COMMERCE_API');
  // amRoleScope(tenant) builds the tenant-scoped role literal.
  assert.equal(amRoleScope('abcd_001'), 'SALESFORCE_COMMERCE_API:abcd_001');
  // A placeholder tenant is preserved verbatim (the skill often doesn't know the realm).
  assert.equal(amRoleScope('<tenant>'), 'SALESFORCE_COMMERCE_API:<tenant>');
  // tenantFromOrg derives the realm from an org id f_ecom_<realm>.
  assert.equal(tenantFromOrg('f_ecom_abcd_001'), 'abcd_001');
  assert.equal(tenantFromOrg('f_ecom_aaaa_002'), 'aaaa_002');
  // Not an f_ecom org id -> null (caller falls back to a <tenant> placeholder).
  assert.equal(tenantFromOrg('abcd_001'), null);
  assert.equal(tenantFromOrg(''), null);
  assert.equal(tenantFromOrg(null), null);
}

// SHOPPER_FLOWS: 4 entries with expected slug pairs.
{
  assert.deepEqual(SHOPPER_FLOWS.guest.slugs, ['authorizeCustomer', 'getAccessToken']);
  assert.equal(SHOPPER_FLOWS.guest.authorizeHint, 'guest');
  assert.equal(SHOPPER_FLOWS.guest.grantType, 'authorization_code_pkce');

  assert.deepEqual(SHOPPER_FLOWS['registered-b2c'].slugs, ['authenticateCustomer', 'getAccessToken']);
  assert.equal(SHOPPER_FLOWS['registered-b2c'].grantType, 'authorization_code_pkce');

  assert.deepEqual(SHOPPER_FLOWS['registered-federated'].slugs, ['authorizeCustomer', 'getAccessToken']);
  assert.equal(SHOPPER_FLOWS['registered-federated'].authorizeHint, '<idp-name>');

  assert.deepEqual(SHOPPER_FLOWS.tsob.slugs, ['getTrustedSystemAccessToken']);
  assert.equal(SHOPPER_FLOWS.tsob.grantType, 'client_credentials');
}

// AM_FLOWS: 2 entries; both share the canonical AM token URL. The host is
// account.demandware.COM -- verified live: account.demandware.net does not
// resolve, account.demandware.com issues the token (iteration-am-token-host-fix).
{
  assert.equal(AM_FLOWS['private-cc'].tokenUrl,
    'https://account.demandware.com/dwsso/oauth2/access_token');
  assert.equal(AM_FLOWS['private-cc'].grantType, 'client_credentials');

  assert.equal(AM_FLOWS['public-pkce'].tokenUrl,
    'https://account.demandware.com/dwsso/oauth2/access_token');
  assert.equal(AM_FLOWS['public-pkce'].grantType, 'authorization_code_pkce');
}

// pickAuthBranch: ShopperToken -> shopper-slas.
{
  assert.equal(
    pickAuthBranch([{ scheme: 'ShopperToken', scopes: ['sfcc.shopper-products'] }]),
    'shopper-slas'
  );
}

// pickAuthBranch: AmOAuth2 -> am.
{
  assert.equal(
    pickAuthBranch([{ scheme: 'AmOAuth2', scopes: ['sfcc.orders.rw'] }]),
    'am'
  );
}

// pickAuthBranch: BearerToken with SLAS_* scopes -> am (SLAS Admin runs through AM).
{
  assert.equal(
    pickAuthBranch([{ scheme: 'BearerToken', scopes: ['SLAS_SERVICE_ADMIN'] }]),
    'am'
  );
  assert.equal(
    pickAuthBranch([{ scheme: 'BearerToken', scopes: ['SLAS_SERVICE_ADMIN', 'SLAS_ORGANIZATION_ADMIN'] }]),
    'am'
  );
}

// pickAuthBranch: BearerToken with non-SLAS scopes -> unknown (don't assume AM).
{
  assert.equal(
    pickAuthBranch([{ scheme: 'BearerToken', scopes: ['some-other-scope'] }]),
    'unknown'
  );
}

// pickAuthBranch: OCAPI multi-scheme -> 'unknown' HERE. OCAPI is not routable by
// scheme (Shop and Data declare the same schemes), so the SCAPI classifier
// deliberately declines it; the reference-FAMILY providers in
// auth-providers.js route OCAPI (asserted in test-auth-providers.js). This
// is the fix for the over-auth bug where the old final clause collapsed every
// OCAPI scheme to shopper-slas (full SLAS PKCE on a read; Data mis-routed).
{
  assert.equal(
    pickAuthBranch([
      { scheme: 'customers_auth', scopes: [] },
      { scheme: 'oauth2_application', scopes: [] },
      { scheme: 'client_id', scopes: [] },
    ]),
    'unknown'
  );
  assert.equal(
    pickAuthBranch([{ scheme: 'oauth2_application', scopes: [] }]),
    'unknown'
  );
}

// pickAuthBranch: ShopperToken priority wins over OCAPI co-listed schemes.
// (Defensive: SCAPI Shopper specs only declare ShopperToken, but the ordering
// is deliberate per design.)
{
  assert.equal(
    pickAuthBranch([
      { scheme: 'ShopperToken', scopes: ['sfcc.shopper-products'] },
      { scheme: 'oauth2_application', scopes: [] },
    ]),
    'shopper-slas'
  );
}

// pickAuthBranch: BearerToken+SLAS_* priority wins over plain AmOAuth2.
{
  assert.equal(
    pickAuthBranch([
      { scheme: 'AmOAuth2', scopes: ['sfcc.orders'] },
      { scheme: 'BearerToken', scopes: ['SLAS_SERVICE_ADMIN'] },
    ]),
    'am'
  );
}

// pickAuthBranch: empty / null security -> unknown.
{
  assert.equal(pickAuthBranch([]), 'unknown');
  assert.equal(pickAuthBranch(null), 'unknown');
  assert.equal(pickAuthBranch(undefined), 'unknown');
}

// pickAuthBranch: unrecognized scheme -> unknown.
{
  assert.equal(
    pickAuthBranch([{ scheme: 'MarketingCloudAuth', scopes: [] }]),
    'unknown'
  );
}

// pickShopperFlow: known signal returns matching flow.
{
  assert.equal(pickShopperFlow('guest').label, SHOPPER_FLOWS.guest.label);
  assert.equal(pickShopperFlow('registered-b2c').label, SHOPPER_FLOWS['registered-b2c'].label);
  assert.equal(pickShopperFlow('registered-federated').label, SHOPPER_FLOWS['registered-federated'].label);
  assert.equal(pickShopperFlow('tsob').label, SHOPPER_FLOWS.tsob.label);
}

// pickShopperFlow: undefined / unknown signal -> guest default.
{
  assert.equal(pickShopperFlow(undefined).label, SHOPPER_FLOWS.guest.label);
  assert.equal(pickShopperFlow(null).label, SHOPPER_FLOWS.guest.label);
  assert.equal(pickShopperFlow('not-a-real-signal').label, SHOPPER_FLOWS.guest.label);
}

// pickAmFlow: known signal returns matching flow.
{
  assert.equal(pickAmFlow('private-cc').label, AM_FLOWS['private-cc'].label);
  assert.equal(pickAmFlow('public-pkce').label, AM_FLOWS['public-pkce'].label);
}

// pickAmFlow: undefined / unknown signal -> private-cc default.
{
  assert.equal(pickAmFlow(undefined).label, AM_FLOWS['private-cc'].label);
  assert.equal(pickAmFlow('not-a-real-signal').label, AM_FLOWS['private-cc'].label);
}

console.log('ok');
