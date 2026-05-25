'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TRIAGE = path.join(__dirname, '..', 'scripts', 'triage.js');
const FAKE_SCRAPE = path.join(__dirname, '..', '..', '_shared', 'tests', 'fixtures', 'fake-scrape.js');
const FAKE_CACHE = path.join(__dirname, 'fixtures', 'fake-cache');

function runTriage(input) {
  const res = spawnSync('node', [TRIAGE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'ok-fresh' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// --- Scenario: insufficient_scope on createBasket
{
  const input = {
    request: `curl -X POST 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=RefArch' \\
  -H 'Authorization: Bearer tok' \\
  -H 'Content-Type: application/json' \\
  --data-raw '{"customerInfo":{"customerId":"c1"}}'`,
    errorResponse: { status: 403, body: { error: 'insufficient_scope', error_description: 'missing scope' } },
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-products'] },
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0, 'triage should exit 0 on known error class');
  const out = JSON.parse(stdout);
  assert.equal(out.errorClass, 'AUTH_MISSING_SCOPE');
  assert.deepEqual(out.scopeDiff.missing, ['sfcc.shopper-baskets']);
  assert.equal(out.confidence, 'high');
  assert.ok(out.sources.length > 0);
  assert.ok(out.sources.every((u) => /^https:\/\/developer\.salesforce\.com\//.test(u)),
    'sources must be developer.salesforce.com URLs');
}

// --- Scenario: UNKNOWN class (500) – triage emits UNKNOWN and says so
{
  const input = {
    request: { method: 'POST', url: 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=R' },
    errorResponse: { status: 500, body: { message: 'internal' } },
    providedScopes: null,
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.errorClass, 'UNKNOWN');
  assert.ok(out.handsOff, 'should flag handsOff=true on UNKNOWN');
}

// --- Scenario: non-SCAPI envelope (HTML body) – UNKNOWN with handsOff
{
  const input = {
    request: { method: 'POST', url: 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=R' },
    errorResponse: { status: 403, body: '<html>blocked</html>' },
    providedScopes: null,
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.errorClass, 'UNKNOWN');
  assert.ok(out.handsOff);
}

// --- Scenario: missing required body field (400 + missing customerInfo)
{
  const input = {
    request: `curl -X POST 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=R' \\
  -H 'Authorization: Bearer tok' \\
  -H 'Content-Type: application/json' \\
  --data-raw '{}'`,
    errorResponse: { status: 400, body: { error: 'missing_parameter', error_description: 'customerInfo' } },
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.errorClass, 'REQUEST_MISSING_REQUIRED');
  assert.ok(out.shapeDiff.some((f) => f.kind === 'body-missing-required' && f.field === 'customerInfo'));
}

// --- Scenario: slug resolution fails (referenceUrl + cache present, but path doesn't match)
{
  const input = {
    request: { method: 'GET', url: 'https://example.test/unknown/path' },
    errorResponse: { status: 401, body: { error: 'unauthorized' } },
    providedScopes: null,
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout, stderr } = runTriage(input);
  assert.equal(code, 2, 'exit 2 when slug cannot be resolved');
  assert.match(stderr, /could not resolve|no matching endpoint/i);
}


// --- Scenario: JWT auto-decode (no providedScopes, but bearer token in request)
{
  // Build a JWT with SLAS-style scp claim.
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tok = [
    b64url({ alg: 'RS256' }),
    b64url({ scp: 'sfcc.shopper-baskets', sub: 'x' }),
    'sig',
  ].join('.');

  const input = {
    request: `curl -X POST 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=RefArch' \\
  -H 'Authorization: Bearer ${tok}' \\
  -H 'Content-Type: application/json' \\
  --data-raw '{"customerInfo":{"customerId":"c1"}}'`,
    errorResponse: { status: 403, body: { error: 'insufficient_scope' } },
    // providedScopes OMITTED – triage should decode the JWT
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0, 'triage should exit 0');
  const out = JSON.parse(stdout);
  assert.equal(out.scopeDiff.providedSource, 'token', 'scopes should come from decoded JWT');
  assert.ok(out.scopeDiff.provided.includes('sfcc.shopper-baskets'));
}

// --- Scenario: scrape failure (FAKE_MODE=not-found) – exit 3
{
  const input = {
    request: { method: 'POST', url: 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=R' },
    errorResponse: { status: 403, body: { error: 'insufficient_scope' } },
    providedScopes: null,
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const res = spawnSync('node', [TRIAGE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'not-found' },
  });
  assert.equal(res.status, 3, 'exit 3 when scrape fails');
  assert.match(res.stderr, /scrape failed|404/i);
}

// --- Scenario: invalid JSON on stdin – exit 2
{
  const res = spawnSync('node', [TRIAGE], {
    input: 'this is not JSON at all',
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'ok-fresh' },
  });
  assert.equal(res.status, 2, 'exit 2 on malformed stdin');
  assert.match(res.stderr, /expected json on stdin/i);
}

// --- Scenario: unparseable request string – exit 2 (RequestParseError -> caller-input)
{
  const input = {
    request: 'garbage that is neither curl nor raw http',
    errorResponse: { status: 403, body: { error: 'insufficient_scope' } },
    providedScopes: null,
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stderr } = runTriage(input);
  assert.equal(code, 2, 'exit 2 on unparseable request');
  assert.match(stderr, /does not look like a cURL|triage:/i);
}

// --- Scenario: 415 from text/plain Content-Type against a JSON-only endpoint
// The cached spec declares contentTypes:['application/json']; the request sends
// 'Content-Type: text/plain'. Triage emits a wrong-content-type finding whose
// expected[] names the spec's accepted set so the customer-facing answer can
// quote 'application/json' verbatim.
{
  const input = {
    request: `curl -X POST 'https://example.test/checkout/shopper-baskets/v1/organizations/abc/baskets?siteId=RefArch' \\
  -H 'Authorization: Bearer tok' \\
  -H 'Content-Type: text/plain' \\
  --data-raw '{"customerInfo":{"customerId":"c1"}}'`,
    errorResponse: {
      status: 415,
      body: {
        type: '/error-types/unsupported-media-type',
        title: 'Unsupported Media Type',
        detail: "The Content-Type header value 'text/plain' is not supported by this resource.",
      },
    },
    providedScopes: { source: 'token', scopes: ['sfcc.shopper-baskets'] },
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0, '415 should resolve and diff cleanly');
  const out = JSON.parse(stdout);
  const ct = out.shapeDiff.filter((f) => f.kind === 'wrong-content-type');
  assert.equal(ct.length, 1, `expected one wrong-content-type finding; got ${JSON.stringify(out.shapeDiff)}`);
  assert.deepEqual(ct[0].expected, ['application/json'],
    'finding must name the spec\'s accepted set so the answer can quote application/json');
  assert.equal(ct[0].actual, 'text/plain');
  assert.ok(out.sources.length > 0);
  assert.ok(out.sources.every((u) => /^https:\/\/developer\.salesforce\.com\//.test(u)));
}

// --- Scenario: OCAPI version drift (live v23_2 against cached v25_6 spec)
// The cached spec declares `/s/{siteId}/dw/shop/v25_6` but the request hits v23_2.
// Resolver routes to the matching slug (so the spec the customer pointed at is
// still on the diff) and triage emits a structured `version-mismatch` finding
// naming both versions, instead of exiting 2 with "no matching endpoint".
{
  const input = {
    request: `curl -X GET 'https://zzrf-001.dx.commercecloud.salesforce.com/s/RefArch/dw/shop/v23_2/customers/abc12345' \\
  -H 'x-dw-client-id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' \\
  -H 'Authorization: Bearer some-old-token'`,
    errorResponse: {
      status: 401,
      body: { fault: { type: 'AuthenticationFailedException', message: 'The access token is invalid.' } },
    },
    providedScopes: null,
    cacheRoot: FAKE_CACHE,
    scrapeScript: FAKE_SCRAPE,
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce-ocapi-b2c-api-doc/references/ocapi-shop-customers',
  };
  const { code, stdout } = runTriage(input);
  assert.equal(code, 0, 'OCAPI version drift should resolve and diff, not exit 2');
  const out = JSON.parse(stdout);
  assert.equal(out.resolved.slug, 'get-customers-customer_id');
  const vm = out.shapeDiff.filter((f) => f.kind === 'version-mismatch');
  assert.equal(vm.length, 1, `expected one version-mismatch finding; got ${JSON.stringify(out.shapeDiff)}`);
  assert.equal(vm[0].liveVersion, 'v23_2');
  assert.equal(vm[0].specVersion, 'v25_6');
  assert.ok(out.sources.length > 0);
  assert.ok(out.sources.every((u) => /^https:\/\/developer\.salesforce\.com\//.test(u)),
    'sources must be developer.salesforce.com URLs');
}

console.log('ok');
