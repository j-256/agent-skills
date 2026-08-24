'use strict';

const assert = require('node:assert/strict');
const { parseRequest, RequestParseError } = require('../common/parse-request.js');

// --- cURL: single-line GET
{
  const r = parseRequest(
    `curl 'https://example.com/api/foo?id=1' -H 'Authorization: Bearer abc.def.ghi'`,
  );
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://example.com/api/foo?id=1');
  assert.equal(r.path, '/api/foo');
  assert.deepEqual(r.query, { id: '1' });
  assert.equal(r.headers['authorization'], 'Bearer abc.def.ghi');
  assert.equal(r.body, null);
  assert.equal(r.token, 'abc.def.ghi');
}

// --- cURL: multi-line POST with --data-raw and multiple headers
{
  const r = parseRequest(`curl -X POST 'https://example.com/api/baskets' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer xyz' \\
  --data-raw '{"customerId":"abc"}'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/baskets');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.body, '{"customerId":"abc"}');
  assert.equal(r.token, 'xyz');
}

// --- cURL: -d short form, implicit POST
{
  const r = parseRequest(`curl 'https://example.com/api/x' -d 'a=1&b=2'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body, 'a=1&b=2');
}

// --- cURL: header value contains a colon
{
  const r = parseRequest(
    `curl 'https://example.com/api/x' -H 'X-Time: 2026-04-30T12:00:00Z'`,
  );
  assert.equal(r.headers['x-time'], '2026-04-30T12:00:00Z');
}

// --- Raw HTTP request
{
  const raw = [
    'POST /api/baskets HTTP/1.1',
    'Host: example.com',
    'Authorization: Bearer tok',
    'Content-Type: application/json',
    '',
    '{"x":1}',
  ].join('\r\n');
  const r = parseRequest(raw);
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/baskets');
  assert.equal(r.headers['host'], 'example.com');
  assert.equal(r.body, '{"x":1}');
  assert.equal(r.token, 'tok');
}

// --- Raw HTTP with LF-only line endings
{
  const raw = 'GET /api/x HTTP/1.1\nHost: example.com\n\n';
  const r = parseRequest(raw);
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/api/x');
}

// --- method + URL pair (minimal input shape)
{
  const r = parseRequest({ method: 'delete', url: 'https://example.com/api/baskets/123' });
  assert.equal(r.method, 'DELETE');
  assert.equal(r.path, '/api/baskets/123');
  assert.deepEqual(r.query, {});
  assert.equal(r.body, null);
  assert.equal(r.token, null);
}

// --- garbage input: throws RequestParseError
assert.throws(() => parseRequest('this is not a request'), (e) => e instanceof RequestParseError);
assert.throws(() => parseRequest(''), (e) => e instanceof RequestParseError);
assert.throws(() => parseRequest(null), (e) => e instanceof RequestParseError);

// --- token: non-JWT Bearer string still returned as-is (JWT decoding is caller's job)
{
  const r = parseRequest(`curl 'https://example.com/x' -H 'Authorization: Bearer opaque-token'`);
  assert.equal(r.token, 'opaque-token');
}

// --- header keys lowercased for lookup stability
{
  const r = parseRequest(`curl 'https://example.com/x' -H 'Content-Type: application/json' -H 'X-Custom: Y'`);
  assert.ok('content-type' in r.headers);
  assert.ok('x-custom' in r.headers);
}

// --- prototype-named query and header keys remain ordinary own properties
{
  const r = parseRequest(`curl 'https://example.com/x?__proto__=query-value' -H '__proto__: header-value'`);
  assert.equal(Object.getPrototypeOf(r.query), Object.prototype);
  assert.equal(Object.hasOwn(r.query, '__proto__'), true);
  assert.equal(r.query.__proto__, 'query-value');
  assert.equal(Object.getPrototypeOf(r.headers), Object.prototype);
  assert.equal(Object.hasOwn(r.headers, '__proto__'), true);
  assert.equal(r.headers.__proto__, 'header-value');
}

// --- raw HTTP preserves prototype-named headers without changing the record prototype
{
  const raw = 'GET /api/x HTTP/1.1\nHost: example.com\n__proto__: raw-value\n\n';
  const r = parseRequest(raw);
  assert.equal(Object.getPrototypeOf(r.headers), Object.prototype);
  assert.equal(Object.hasOwn(r.headers, '__proto__'), true);
  assert.equal(r.headers.__proto__, 'raw-value');
}

// --- cURL: --data-urlencode is recognized as a body flag (implicit POST)
{
  const r = parseRequest(`curl 'https://example.com/api/x' --data-urlencode 'q=hello world'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body, 'q=hello world');
}

// --- cURL: -X <METHOD> precedence – explicit method wins over implicit POST from -d
{
  const r = parseRequest(`curl -X PUT 'https://example.com/api/x' -d 'a=1'`);
  assert.equal(r.method, 'PUT');
  assert.equal(r.body, 'a=1');
}

// --- cURL: unknown flag with no value doesn't swallow the URL
{
  const r = parseRequest(`curl --compressed 'https://example.com/api/x'`);
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/api/x');
}

// --- cURL: known value-flag (-u) consumes its value without affecting URL detection
{
  const r = parseRequest(`curl -u 'user:pass' 'https://example.com/api/x'`);
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/api/x');
}

console.log('ok');
