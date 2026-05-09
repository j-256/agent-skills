'use strict';

const assert = require('node:assert/strict');
const { classify, ErrorClass } = require('../scripts/classify.js');

// Exhaustively cover each class. Each case is
// {status, body, expect}.
const cases = [
  // AUTH_MISSING_SCOPE – SCAPI insufficient_scope on 403
  {
    status: 403,
    body: { type: '/errors/insufficient-permissions', title: 'Insufficient Scope' },
    expect: ErrorClass.AUTH_MISSING_SCOPE,
  },
  {
    status: 403,
    body: { error: 'insufficient_scope', error_description: 'missing scope' },
    expect: ErrorClass.AUTH_MISSING_SCOPE,
  },
  // AUTH_INVALID_CLIENT – SLAS OAuth errors
  {
    status: 401,
    body: { error: 'invalid_client', error_description: 'client secret mismatch' },
    expect: ErrorClass.AUTH_INVALID_CLIENT,
  },
  // AUTH_INVALID_TOKEN – token malformed/expired
  {
    status: 401,
    body: { error: 'invalid_token', error_description: 'token expired' },
    expect: ErrorClass.AUTH_INVALID_TOKEN,
  },
  {
    status: 401,
    body: { type: '/errors/invalid-token', title: 'Invalid Token' },
    expect: ErrorClass.AUTH_INVALID_TOKEN,
  },
  // AUTH_UNAUTHORIZED – 401 without a specific oauth code
  {
    status: 401,
    body: { error: 'unauthorized' },
    expect: ErrorClass.AUTH_UNAUTHORIZED,
  },
  {
    status: 401,
    body: { title: 'Unauthorized' },
    expect: ErrorClass.AUTH_UNAUTHORIZED,
  },
  // REQUEST_MISSING_REQUIRED – 400 with a missing-parameter shape
  {
    status: 400,
    body: {
      type: '/errors/invalid-parameter',
      title: 'Missing required parameter',
      detail: 'Missing required parameter: customerId',
    },
    expect: ErrorClass.REQUEST_MISSING_REQUIRED,
  },
  {
    status: 400,
    body: { error: 'missing_parameter', error_description: 'missing customerId' },
    expect: ErrorClass.REQUEST_MISSING_REQUIRED,
  },
  // REQUEST_WRONG_TYPE – 400 type mismatch
  {
    status: 400,
    body: {
      type: '/errors/invalid-parameter',
      title: 'Invalid parameter type',
      detail: "Expected 'integer' but got 'string' for 'limit'",
    },
    expect: ErrorClass.REQUEST_WRONG_TYPE,
  },
  // REQUEST_BAD_SHAPE – 400 content-type / shape errors
  {
    status: 415,
    body: { type: '/errors/unsupported-media-type' },
    expect: ErrorClass.REQUEST_BAD_SHAPE,
  },
  {
    status: 400,
    body: { title: 'Malformed JSON body' },
    expect: ErrorClass.REQUEST_BAD_SHAPE,
  },
  // OCAPI fault envelope – `{"fault":{"type":"...Exception","message":"..."}}`
  // Auth: client_id misconfig
  {
    status: 401,
    body: { fault: { type: 'InvalidClientIdException', message: 'The client id is invalid' } },
    expect: ErrorClass.AUTH_INVALID_CLIENT,
  },
  // Auth: customer JWT failure (no specific tag in body, just a generic 401)
  {
    status: 401,
    body: { fault: { type: 'AuthenticationFailedException', message: 'Authentication failed' } },
    expect: ErrorClass.AUTH_UNAUTHORIZED,
  },
  // Body shape: 400 with a missing-required-property fault
  {
    status: 400,
    body: { fault: { type: 'MissingRequiredPropertyException', message: 'Missing required parameter: product_id' } },
    expect: ErrorClass.REQUEST_MISSING_REQUIRED,
  },
  // UNKNOWN – body doesn't look like SCAPI/OCAPI, or status outside our table
  {
    status: 500,
    body: { message: 'Internal Server Error' },
    expect: ErrorClass.UNKNOWN,
  },
  {
    status: 404,
    body: { error: 'not_found' },
    expect: ErrorClass.UNKNOWN,
  },
  // UNKNOWN – body is a string / HTML (WAF-injected)
  {
    status: 403,
    body: '<html><body>Forbidden</body></html>',
    expect: ErrorClass.UNKNOWN,
  },
  // 401 with null body: defaults to AUTH_UNAUTHORIZED (not UNKNOWN)
  {
    status: 401,
    body: null,
    expect: ErrorClass.AUTH_UNAUTHORIZED,
  },
];

for (const c of cases) {
  const got = classify({ status: c.status, body: c.body });
  assert.equal(got, c.expect, `status=${c.status} body=${JSON.stringify(c.body).slice(0, 60)} -> expected ${c.expect}, got ${got}`);
}

// classify also accepts the body as an already-parsed JSON string.
{
  const got = classify({ status: 401, body: '{"error":"invalid_client"}' });
  assert.equal(got, ErrorClass.AUTH_INVALID_CLIENT);
}

console.log('ok');
