'use strict';

// B2C Commerce spec-correction registry -- the product-specific DATA the generic
// verifier in auth-providers.js consumes. Each correction asserts a fact that
// OVERRIDES what a spec declares, and (where a spec field exists to watch) carries
// a specAnchor so it SELF-INVALIDATES when that field drifts. See
// docs/commerce-auth-matrix.md "Spec corrections and their self-invalidation".
//
// Volatility is DERIVED from shape (deriveVolatility), never stored:
//   - specAnchor present  -> spec-divergence (watch the field; the drift-prone class)
//   - infraInvariant flag -> infra-invariant (no spec field to watch; e.g. an auth host)
//   - otherwise           -> platform-behavior (a dated runtime fact; re-verify on cadence)
//
// The two citizens below are two DIFFERENT field kinds, proving the framework
// general with real facts rather than a promise:
//   1. auth-admin      -- an INLINE security[] field; anchor watches a wrong VALUE
//   2. masked_number   -- a $ref-resolved SCHEMA field; anchor watches a wrong PROPERTY still present

const { typeHasProperty } = require('./spec-traversal.js');

// Every scope under a BearerToken scheme is a *_ADMIN role. Both the observed
// forms ([SLAS_SERVICE_ADMIN] and [SLAS_SERVICE_ADMIN, SLAS_ORGANIZATION_ADMIN])
// satisfy it; a spec that regenerates to name the real gate (e.g. CCDX_SBX_USER)
// stops matching -> drifted -> re-verify.
const ADMIN_ROLE = /^SLAS_.*_ADMIN$/;

const B2C_CORRECTIONS = [
  {
    id: 'auth-admin-sandbox-api-user',
    // SLAS Admin control-plane API. SCAPI area, auth-admin reference.
    match: (c) => c && c.area === 'commerce_commerce-api' && c.reference === 'auth-admin',
    claim: 'auth-admin (SLAS Admin) is gated by the Account Manager "Sandbox API User" role (CCDX_SBX_USER), '
      + 'filtered to the target instance -- NOT the SLAS_SERVICE_ADMIN / SLAS_ORGANIZATION_ADMIN roles its '
      + 'security[] declares. Mint a plain AM client_credentials token (scope SALESFORCE_COMMERCE_API:<tenant>) '
      + 'whose API client holds that role with the instance in its filter; a token with no SLAS-admin role returns 200.',
    basis: 'runtime-verified',
    verifiedOn: [
      { date: '2026-07-02', coords: { tenant: 'abcd_001', instanceType: 'ods-sandbox', apiVersion: 'v1' } },
    ],
    scope: 'Verified on an on-demand sandbox (ODS) only; production/PIG behavior not independently characterized -- re-verify if your instance type differs.',
    specAnchor: {
      field: 'security',
      saw: 'BearerToken: every scope matches /^SLAS_.*_ADMIN$/ (the declared-but-not-enforced admin roles)',
      // Inline field: read the op's own security[]. compose supplies ctx.opDoc.
      read: (ctx) => (ctx && ctx.opDoc && ctx.opDoc.endpoint && ctx.opDoc.endpoint.security) || null,
      holds: (security) => {
        if (!Array.isArray(security)) return false;
        const bearer = security.find((s) => s && s.scheme === 'BearerToken');
        if (!bearer || !Array.isArray(bearer.scopes) || bearer.scopes.length === 0) return false;
        return bearer.scopes.every((s) => ADMIN_ROLE.test(s));
      },
    },
    provenance: 'docs/commerce-auth-matrix.md "SLAS Admin (auth-admin)" section; runtime-verified end to end '
      + '(retrieveTenant / retrieveClients returned 200 with a Sandbox-API-User token and no SLAS-admin role).',
    cite: 'https://developer.salesforce.com/docs/commerce/commerce-api/guide/authorization-for-admin-apis.html',
  },
  {
    id: 'ocapi-create-body-masked-number',
    // OCAPI Shop baskets, the create-body payment card shape.
    match: (c) => c && c.area === 'commerce_b2c-commerce' && c.reference === 'ocapi-shop-baskets'
      && (c.method || '').toUpperCase() === 'POST',
    claim: 'In the OCAPI POST /baskets create body, payment_card requires masked_number; a raw number is rejected '
      + 'there (400 UnknownPropertyException "unknown property number"). To send a raw card number, use the '
      + 'payment_instruments sub-resource (POST /baskets/{id}/payment_instruments) instead.',
    basis: 'runtime-verified',
    verifiedOn: [
      { date: '2026-07-02', coords: { tenant: 'abcd_001', instanceType: 'ods-sandbox', release: 'v25_6', site: 'RefArch' } },
    ],
    scope: 'Verified on an ODS sandbox (RefArch, v25_6); the raw-vs-masked split is per-endpoint (create body vs sub-resource), not per-product -- re-verify on a platform release.',
    specAnchor: {
      field: 'order_payment_card_request.number',
      saw: 'the create-body card leaf type order_payment_card_request declares a raw `number` property (which runtime rejects)',
      // Schema field: the create-body payment_card $ref resolves to order_payment_card_request, whose raw
      // `number` property is the thing runtime refuses. Anchor holds while the spec keeps offering it.
      // ctx carries cacheRoot/area/reference; typeHasProperty reads the leaf type directly (no $ref chase --
      // order_payment_card_request IS the leaf and declares `number` as a direct property).
      read: (ctx) => typeHasProperty(ctx.cacheRoot, ctx.reference, 'order_payment_card_request', 'number', ctx.area),
      holds: (hasRawNumber) => hasRawNumber === true,
    },
    provenance: 'docs/commerce-auth-matrix.md request-shape table + "Payment shape" note; runtime-verified '
      + '(create-body masked_number places an order; raw number 400s and works only via the payment_instruments sub-resource).',
    cite: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets',
  },
];

// Conditional-completeness validator. Not field-presence theater: the requiredness
// encodes what each class of fact demands, so an author cannot ship an under-specified
// correction. Runs at module load (below) AND as a standalone test.
function assertCorrectionsWellFormed(corrections) {
  if (!Array.isArray(corrections)) throw new Error('B2C_CORRECTIONS must be an array');
  for (const c of corrections) {
    const where = `correction '${c && c.id ? c.id : '(no id)'}'`;
    if (!c || typeof c.id !== 'string' || !c.id) throw new Error(`${where}: missing id`);
    if (typeof c.match !== 'function') throw new Error(`${where}: match must be a function`);
    if (typeof c.claim !== 'string' || !c.claim) throw new Error(`${where}: missing claim`);
    if (typeof c.provenance !== 'string' || !c.provenance) throw new Error(`${where}: missing provenance`);
    if (!['runtime-verified', 'doc-stated', 'platform-owner'].includes(c.basis)) {
      throw new Error(`${where}: basis must be runtime-verified|doc-stated|platform-owner`);
    }
    if (c.basis === 'runtime-verified' && !(Array.isArray(c.verifiedOn) && c.verifiedOn.length > 0)) {
      throw new Error(`${where}: runtime-verified needs a non-empty verifiedOn`);
    }
    if (!('cite' in c)) throw new Error(`${where}: cite is required (a URL, or explicit null)`);
    if (c.specAnchor) {
      const a = c.specAnchor;
      if (typeof a.field !== 'string' || !a.field) throw new Error(`${where}: specAnchor.field required`);
      if (typeof a.saw !== 'string' || !a.saw) throw new Error(`${where}: specAnchor.saw (readable snapshot) required`);
      if (typeof a.read !== 'function') throw new Error(`${where}: specAnchor.read must be a function`);
      if (typeof a.holds !== 'function') throw new Error(`${where}: specAnchor.holds must be a function`);
      if (typeof c.scope !== 'string' || !c.scope) throw new Error(`${where}: spec-divergence needs an explicit scope bounds string`);
    }
  }
}

assertCorrectionsWellFormed(B2C_CORRECTIONS);

module.exports = { B2C_CORRECTIONS, assertCorrectionsWellFormed };
