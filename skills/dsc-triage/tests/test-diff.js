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

// --- Wrong content-type
{
  const req = validRequest();
  req.headers['content-type'] = 'text/plain';
  const r = diffRequestAgainstSpec({
    request: req,
    spec,
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
  });
  const ct = r.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.ok(ct.length > 0);
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
