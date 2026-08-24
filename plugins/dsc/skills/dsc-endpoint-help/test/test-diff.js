'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { diffRequestAgainstSpec } = require('../scripts/diff.js');

const spec = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'spec-createBasket.json'), 'utf8'),
);

// Helper: a minimally valid parsed request against the spec.
function validRequest() {
  return {
    method: 'POST',
    url: 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=RefArch',
    path: '/checkout/shopper-baskets/v1/organizations/abc/baskets',
    query: { siteId: 'RefArch' },
    headers: {
      authorization: 'Bearer <jwt>',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ customerInfo: { customerId: 'cust1' } }),
    token: '<jwt>',
  };
}

// --- Fully valid request, scopes from decoded JWT, no findings.
{
  const r = diffRequestAgainstSpec({
    request: validRequest(),
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  assert.deepEqual(r.scopeDiff.missing, []);
  assert.deepEqual(r.shapeDiff, []);
  assert.equal(r.confidence, 'high');
}

// --- Missing scope.
{
  const r = diffRequestAgainstSpec({
    request: validRequest(),
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-products'] },
  });
  assert.deepEqual(r.scopeDiff.required, ['sfcc.shopper-baskets']);
  assert.deepEqual(r.scopeDiff.missing, ['sfcc.shopper-baskets']);
  assert.equal(r.scopeDiff.providedSource, 'token');
  assert.equal(r.confidence, 'high');
}

// --- Scopes from client list: confidence is medium even if they match.
{
  const r = diffRequestAgainstSpec({
    request: validRequest(),
    spec,
    providedScopes: { source: 'clientList', scopes: ['sfcc.shopper-baskets'] },
  });
  assert.deepEqual(r.scopeDiff.missing, []);
  assert.equal(r.confidence, 'medium');
}

// --- No scope info: confidence is low, diff reports providedSource=unknown
{
  const r = diffRequestAgainstSpec({
    request: validRequest(),
    spec,
    providedScopes: null,
  });
  assert.equal(r.scopeDiff.providedSource, 'unknown');
  assert.equal(r.confidence, 'low');
}

// --- Missing required body field
{
  const req = validRequest();
  req.body = JSON.stringify({}); // missing customerInfo
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const missing = r.shapeDiff.filter((f) => f.kind === 'body-missing-required');
  assert.ok(missing.length > 0, 'expected body-missing-required finding');
  assert.ok(missing.some((f) => f.field === 'customerInfo'));
}

// --- Missing required query param
{
  const req = validRequest();
  delete req.query.siteId;
  req.url = 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets';
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const missing = r.shapeDiff.filter((f) => f.kind === 'query-missing-required');
  assert.ok(missing.some((f) => f.name === 'siteId'));
}

// --- Wrong-typed body field (customerId should be string, got number)
{
  const req = validRequest();
  req.body = JSON.stringify({ customerInfo: { customerId: 123 } });
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const wrong = r.shapeDiff.filter((f) => f.kind === 'body-wrong-type');
  assert.ok(wrong.some((f) => f.field === 'customerInfo.customerId'));
}

// --- Wrong content-type: spec declares contentTypes:['application/json'], request sends text/plain
{
  const req = validRequest();
  req.headers['content-type'] = 'text/plain';
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 1);
  assert.deepEqual(ct[0].expected, ['application/json'],
    'expected field should carry the spec\'s declared accepted set as an array');
  assert.equal(ct[0].actual, 'text/plain');
}

// --- Right content-type with charset suffix: still matches (suffix stripped)
{
  const req = validRequest();
  req.headers['content-type'] = 'application/json; charset=utf-8';
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 0, 'charset suffix should not cause a wrong-content-type finding');
}

// --- Multi-content-type accepting set: request sends one of the accepted types -> no finding
{
  const multiSpec = JSON.parse(JSON.stringify(spec));
  multiSpec.endpoint.body.contentTypes = ['application/json', 'application/x-www-form-urlencoded'];
  const req = validRequest();
  req.headers['content-type'] = 'application/x-www-form-urlencoded';
  const r = diffRequestAgainstSpec({
    request: req,
    spec: multiSpec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 0, 'request matching any accepted contentType should not flag wrong-content-type');
}

// --- Multi-content-type accepting set: request sends none of them -> finding names the full set
{
  const multiSpec = JSON.parse(JSON.stringify(spec));
  multiSpec.endpoint.body.contentTypes = ['application/json', 'application/xml'];
  const req = validRequest();
  req.headers['content-type'] = 'text/plain';
  const r = diffRequestAgainstSpec({
    request: req,
    spec: multiSpec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 1);
  assert.deepEqual(ct[0].expected, ['application/json', 'application/xml']);
}

// --- Backward compat: legacy fixtures with body.contentType (string) still produce findings
{
  const legacySpec = JSON.parse(JSON.stringify(spec));
  delete legacySpec.endpoint.body.contentTypes;
  legacySpec.endpoint.body.contentType = 'application/json';
  const req = validRequest();
  req.headers['content-type'] = 'text/plain';
  const r = diffRequestAgainstSpec({
    request: req,
    spec: legacySpec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 1, 'legacy string contentType should still produce a finding');
  assert.deepEqual(ct[0].expected, ['application/json'],
    'legacy string contentType should be normalized to a single-element array in the finding');
}

// --- AMF body shape: body.mediaType (string) is normalized to the accepted set
{
  const amfSpec = JSON.parse(JSON.stringify(spec));
  delete amfSpec.endpoint.body.contentTypes;
  amfSpec.endpoint.body.mediaType = 'application/fhir+json';
  const req = validRequest();
  req.headers['content-type'] = 'text/plain';
  const r = diffRequestAgainstSpec({
    request: req,
    spec: amfSpec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 1, 'AMF body.mediaType should drive the accepted set');
  assert.deepEqual(ct[0].expected, ['application/fhir+json']);
}

// --- Missing required header (Authorization) – deduped even though spec lists it in both parameters[] and headers[]
{
  const req = validRequest();
  delete req.headers.authorization;
  req.token = null;
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: null,
  });
  const h = r.shapeDiff.filter((f) => f.kind === 'header-missing-required');
  assert.ok(h.some((f) => f.name.toLowerCase() === 'authorization'));
  assert.equal(h.length, 1, 'Authorization should appear only once even if spec lists it in both parameters[] and headers[]');
}

// --- Spec with empty security block: required == [], missing == []
{
  const openSpec = JSON.parse(JSON.stringify(spec));
  openSpec.endpoint.security = [];
  const r = diffRequestAgainstSpec({
    request: validRequest(),
    spec: openSpec,
    providedScopes: null,
  });
  assert.deepEqual(r.scopeDiff.required, []);
  assert.deepEqual(r.scopeDiff.missing, []);
}

// --- method-mismatch: spec says POST, request is GET
{
  const req = validRequest();
  req.method = 'GET';
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const mm = r.shapeDiff.filter((f) => f.kind === 'method-mismatch');
  assert.equal(mm.length, 1);
  assert.equal(mm[0].expected, 'POST');
  assert.equal(mm[0].actual, 'GET');
}

// --- body-malformed-json: body is not parseable JSON
{
  const req = validRequest();
  req.body = 'not-valid-json{';
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  assert.ok(r.shapeDiff.some((f) => f.kind === 'body-malformed-json'));
}

// --- body-missing-required <root>: body entirely absent when required
{
  const req = validRequest();
  req.body = null;
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const rootMissing = r.shapeDiff.filter((f) => f.kind === 'body-missing-required' && f.field === '<root>');
  assert.equal(rootMissing.length, 1);
}

// --- schemaRef body: spec carries a named-type body (body.schemaRef, no inline
// body.schema) -- the real-cache shape for most SCAPI POST/PUT bodies. The caller
// resolves the ref to its type schema and passes it as `bodySchema`; diff must
// validate the body against it. Before the fix, shapeDiff gated on ep.body.schema
// only, so a schemaRef body skipped ALL body validation silently.
{
  const refSpec = {
    endpoint: {
      method: 'POST',
      path: '/organizations/{organizationId}/baskets/{basketId}/coupons',
      operationId: 'addCouponToBasket',
      parameters: [],
      body: { required: true, contentTypes: ['application/json'], schemaRef: '#/components/schemas/CouponItem' },
      security: [{ scheme: 'ShopperToken', scopes: ['sfcc.shopper-baskets'] }],
    },
  };
  // The resolved CouponItem type schema (real shape: required ['code']).
  const couponItemSchema = { type: 'object', required: ['code'], properties: { code: { type: 'string' } } };
  const req = {
    method: 'POST',
    path: '/checkout/shopper-baskets/v1/organizations/abc/baskets/b1/coupons',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}), // missing required `code`
    token: null,
  };
  const r = diffRequestAgainstSpec({ request: req, spec: refSpec, providedScopes: null, bodySchema: couponItemSchema });
  const missing = r.shapeDiff.filter((f) => f.kind === 'body-missing-required');
  assert.ok(missing.some((f) => f.field === 'code'),
    `schemaRef body must validate against the resolved bodySchema; got ${JSON.stringify(r.shapeDiff)}`);

  // Wrong-typed field against the resolved schema, too.
  const req2 = { ...req, body: JSON.stringify({ code: 123 }) };
  const r2 = diffRequestAgainstSpec({ request: req2, spec: refSpec, providedScopes: null, bodySchema: couponItemSchema });
  assert.ok(r2.shapeDiff.some((f) => f.kind === 'body-wrong-type' && f.field === 'code'),
    `schemaRef body must type-check against the resolved bodySchema; got ${JSON.stringify(r2.shapeDiff)}`);
}

// --- schemaRef body, UNRESOLVABLE (no bodySchema passed): graceful skip, no crash,
// no findings. The differ must degrade exactly as before when the caller couldn't
// resolve the type (missing type file). It must NOT crash on the schemaRef-only body.
{
  const refSpec = {
    endpoint: {
      method: 'POST',
      path: '/organizations/{organizationId}/baskets/{basketId}/coupons',
      operationId: 'addCouponToBasket',
      parameters: [],
      body: { required: true, contentTypes: ['application/json'], schemaRef: '#/components/schemas/CouponItem' },
      security: [],
    },
  };
  const req = {
    method: 'POST',
    path: '/checkout/shopper-baskets/v1/organizations/abc/baskets/b1/coupons',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    token: null,
  };
  const r = diffRequestAgainstSpec({ request: req, spec: refSpec, providedScopes: null });
  assert.deepEqual(r.shapeDiff.filter((f) => f.kind.startsWith('body-')), [],
    `unresolvable schemaRef body must skip body validation gracefully; got ${JSON.stringify(r.shapeDiff)}`);
}

// --- Permissive schemaRef body (resolved type has NO required fields): an empty
// body is a SYNTACTICALLY valid call, so no body-missing-required findings. This
// is the real Basket shape (createBasket's body type declares no required fields);
// "syntactically valid basket creation" is distinct from "basket ready to order",
// and diff.js answers only the former. Guards against fabricating requirements the
// spec doesn't impose.
{
  const refSpec = {
    endpoint: {
      method: 'POST',
      path: '/organizations/{organizationId}/baskets',
      operationId: 'createBasket',
      parameters: [],
      body: { required: true, contentTypes: ['application/json'], schemaRef: '#/components/schemas/Basket' },
      security: [],
    },
  };
  const basketSchema = { type: 'object', properties: { customerInfo: { type: 'object' }, currency: { type: 'string' } } };
  const req = {
    method: 'POST',
    path: '/checkout/shopper-baskets/v1/organizations/abc/baskets',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    token: null,
  };
  const r = diffRequestAgainstSpec({ request: req, spec: refSpec, providedScopes: null, bodySchema: basketSchema });
  assert.deepEqual(r.shapeDiff.filter((f) => f.kind === 'body-missing-required'), [],
    `a permissive (no-required) schemaRef body must not flag missing fields on an empty body; got ${JSON.stringify(r.shapeDiff)}`);
}

// --- AMF-shape schema (parse-amf.js output): body schema uses properties[] with name/required/range
{
  const amfSpec = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'spec-amf-createFoo.json'), 'utf8'),
  );
  const req = {
    method: 'POST',
    url: 'https://example.test/einstein/v1/foo',
    path: '/einstein/v1/foo',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'widget' }), // missing required qty
    token: null,
  };
  const r = diffRequestAgainstSpec({ request: req, spec: amfSpec, providedScopes: null });
  const missing = r.shapeDiff.filter((f) => f.kind === 'body-missing-required');
  assert.ok(missing.some((f) => f.field === 'qty'),
    `AMF shape should detect missing required qty; got ${JSON.stringify(r.shapeDiff)}`);
  // Also a wrong-type check: send qty as string
  const req2 = { ...req, body: JSON.stringify({ name: 'widget', qty: 'five' }) };
  const r2 = diffRequestAgainstSpec({ request: req2, spec: amfSpec, providedScopes: null });
  const wrong = r2.shapeDiff.filter((f) => f.kind === 'body-wrong-type');
  assert.ok(wrong.some((f) => f.field === 'qty'),
    `AMF shape should detect wrong-typed qty; got ${JSON.stringify(r2.shapeDiff)}`);
}

console.log('ok');
