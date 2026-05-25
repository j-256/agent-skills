'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSlug } = require('../resolve-slug.js');

const shopperOrders = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'shopper-orders-index.json'),
  'utf8',
));
const noBasePath = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'no-basepath-index.json'),
  'utf8',
));
const ocapiShopCustomers = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ocapi-shop-customers-index.json'),
  'utf8',
));

// --- Live request path with SCAPI base prefix matches the templated spec endpoint
// This is the contract resolveSlug must honour: parseRequest returns u.pathname verbatim
// (e.g. /checkout/shopper-orders/v1/organizations/abc/orders/00000101) and _index.json
// stores the relative spec path (/organizations/{organizationId}/orders/{orderNo})
// plus a basePath ('/checkout/shopper-orders/v1') derived from the spec's server URL.
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/checkout/shopper-orders/v1/organizations/f_ecom_zzrf_001/orders/00000101',
    index: shopperOrders,
  });
  assert.equal(r.reference, 'shopper-orders');
  assert.equal(r.slug, 'getOrder');
  assert.deepEqual(r.pathParams, { organizationId: 'f_ecom_zzrf_001', orderNo: '00000101' });
}

// --- POST createOrder (no orderNo segment)
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/checkout/shopper-orders/v1/organizations/abc/orders',
    index: shopperOrders,
  });
  assert.equal(r.slug, 'createOrder');
  assert.deepEqual(r.pathParams, { organizationId: 'abc' });
}

// --- Prefer longer (more specific) match across the real endpoint set
{
  const r = resolveSlug({
    method: 'PATCH',
    livePath: '/checkout/shopper-orders/v1/organizations/abc/orders/100/payment-instruments/pi_1',
    index: shopperOrders,
  });
  assert.equal(r.slug, 'updatePaymentInstrumentForOrder');
}

// --- Method mismatch: return null
{
  const r = resolveSlug({
    method: 'DELETE',
    livePath: '/checkout/shopper-orders/v1/organizations/abc/orders',
    index: shopperOrders,
  });
  assert.equal(r, null);
}

// --- Path mismatch: return null
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/unrelated/path',
    index: shopperOrders,
  });
  assert.equal(r, null);
}

// --- Trailing slash tolerance
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/checkout/shopper-orders/v1/organizations/abc/orders/',
    index: shopperOrders,
  });
  assert.equal(r.slug, 'createOrder');
}

// --- Case-insensitive method
{
  const r = resolveSlug({
    method: 'post',
    livePath: '/checkout/shopper-orders/v1/organizations/abc/orders',
    index: shopperOrders,
  });
  assert.equal(r.slug, 'createOrder');
}

// --- Live path missing the basePath prefix: return null
// A request whose pathname doesn't carry the SCAPI base prefix can't match
// this reference; the prefix is part of the contract.
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/organizations/abc/orders/100',
    index: shopperOrders,
  });
  assert.equal(r, null);
}

// --- No basePath in the index: match against endpoint.path verbatim (legacy / refs without a server URL)
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/widgets/123',
    index: noBasePath,
  });
  assert.equal(r.slug, 'getWidget');
  assert.deepEqual(r.pathParams, { widgetId: '123' });
}

// --- OCAPI: basePath has a templated {siteId} segment; live path resolves it
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/s/RefArch/dw/shop/v25_6/customers/abc12345',
    index: ocapiShopCustomers,
  });
  assert.equal(r.reference, 'ocapi-shop-customers');
  assert.equal(r.slug, 'get-customers-customer_id');
  assert.deepEqual(r.pathParams, { customer_id: 'abc12345' });
}

// --- OCAPI: live path that doesn't conform to the basePath template returns null
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/wrong/prefix/customers/abc12345',
    index: ocapiShopCustomers,
  });
  assert.equal(r, null);
}

// --- OCAPI version drift: live path matches basePath shape EXCEPT version literal
// The cached spec declares /s/{siteId}/dw/shop/v25_6 but the live request hits
// v23_2. Resolver still routes the request to the right slug (so the diff layer
// can compare against the spec the customer actually pointed at) and surfaces
// `versionMismatch: {live, spec}` so triage.js can name both versions in the
// answer rather than silently treating drift as a clean match.
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/s/RefArch/dw/shop/v23_2/customers/abc12345',
    index: ocapiShopCustomers,
  });
  assert.equal(r.reference, 'ocapi-shop-customers');
  assert.equal(r.slug, 'get-customers-customer_id');
  assert.deepEqual(r.pathParams, { customer_id: 'abc12345' });
  assert.deepEqual(r.versionMismatch, { live: 'v23_2', spec: 'v25_6' });
}

// --- Version drift gate: a wrong-prefix path (different family altogether)
// must not falsely trigger the version-tolerant fallback. The version-tolerant
// variant relaxes only the version segment; the rest of the basePath must still
// match.
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/wrong/prefix/v23_2/customers/abc12345',
    index: ocapiShopCustomers,
  });
  assert.equal(r, null);
}

// --- Version drift + method mismatch: still returns null (no candidates match)
{
  const r = resolveSlug({
    method: 'DELETE',
    livePath: '/s/RefArch/dw/shop/v23_2/customers/abc12345',
    index: ocapiShopCustomers,
  });
  assert.equal(r, null);
}

// --- Strict-match path (live version equals spec version) does not set the field
// Regression guard: clean matches must not carry versionMismatch even when the
// basePath contains a version literal at all.
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/s/RefArch/dw/shop/v25_6/customers/abc12345',
    index: ocapiShopCustomers,
  });
  assert.equal(r.slug, 'get-customers-customer_id');
  assert.equal(r.versionMismatch, undefined);
}

// --- index without endpoints map: returns null (caller should refresh)
{
  const legacyIndex = { slugs: ['x', 'y'] };
  const r = resolveSlug({
    method: 'GET',
    livePath: '/x',
    index: legacyIndex,
  });
  assert.equal(r, null);
}

console.log('ok');
