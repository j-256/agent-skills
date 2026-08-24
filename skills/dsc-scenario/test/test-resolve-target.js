'use strict';

// Deterministic target discovery via landing-scan. The model often can't guess
// an OCAPI reference slug (it reaches for `ocapi-shop-api`, which 404s), so this
// resolver turns a METHOD + path (which the user usually gives -- "POST /orders")
// into the exact {reference, slug} by scanning the area landing the accessor
// warmed, narrowing to references whose id shares a path token, prewarming those,
// and matching each index with the shared resolveSlug. Product-neutral: it's a
// generic "resolve a live METHOD/path to {reference, slug} within an area", not
// OCAPI-specific -- but OCAPI is the family it unblocks (aliases.js maps OCAPI
// hints to the area landing, never a reference slug; this closes the last mile).

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RESOLVE = path.join(__dirname, '..', 'scripts', 'resolve-target.js');
const FAKE_SCRAPE = path.join(__dirname, '..', 'shared', 'test', 'fixtures', 'fake-scrape.js');
const CACHE = path.join(__dirname, 'fixtures');

// Narrowing normalization (unit). The reference ids are hyphenated
// (ocapi-data-code-versions) but OCAPI resource paths are snake_case
// (/code_versions). A raw substring test never matches, so narrowing must strip
// _/- on BOTH sides. This asserts the match directly -- the integration cases
// below produce the right answer even if narrowing silently widens, so without
// this unit check the underscore-vs-hyphen regression would pass unnoticed.
{
  const { firstPathToken, refKey } = require('../scripts/resolve-target.js');
  assert.equal(firstPathToken('/code_versions'), 'codeversions', 'path token lowercased + separator-stripped');
  assert.equal(firstPathToken('/products/{id}'), 'products');
  assert.equal(refKey('ocapi-data-code-versions'), 'ocapidatacodeversions', 'ref id separator-stripped');
  // The load-bearing assertion: the snake_case path token is a substring of the
  // hyphenated ref key after normalization (this is the narrowing predicate).
  assert.ok(refKey('ocapi-data-code-versions').includes(firstPathToken('/code_versions')),
    'code_versions path narrows to ocapi-data-code-versions (underscore/hyphen agnostic)');
  assert.ok(refKey('ocapi-shop-orders').includes(firstPathToken('/orders')),
    'orders path narrows to ocapi-shop-orders');
  // A raw (un-normalized) compare would FAIL this, which is the bug guarded against.
  assert.ok(!'ocapi-data-code-versions'.includes('code_versions'),
    'sanity: the raw substring test does NOT match -- normalization is what makes narrowing work');
}

function runResolve(input, extraEnv = {}) {
  const res = spawnSync('node', [RESOLVE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'ok-fresh', ...extraEnv },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// POST /orders against the b2c-commerce area landing must resolve to
// ocapi-shop-orders.post-orders -- the exact reference + slug scenario.js needs.
{
  const input = {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
    method: 'POST', path: '/orders',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runResolve(input);
  assert.equal(code, 0, `resolve should exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.equal(out.area, 'commerce_b2c-commerce', 'area derived from the landing URL');
  assert.ok(Array.isArray(out.candidates) && out.candidates.length >= 1, 'at least one candidate');
  const top = out.candidates[0];
  assert.equal(top.reference, 'ocapi-shop-orders', `top candidate reference; got ${JSON.stringify(out.candidates)}`);
  assert.equal(top.slug, 'post-orders', 'top candidate slug');
  assert.equal(top.method, 'POST');
  // The candidate carries a ready-to-use referenceUrl for scenario.js.
  assert.match(top.referenceUrl, /references\/ocapi-shop-orders$/, 'candidate carries a scenario-ready referenceUrl');
}

// GET /code_versions must resolve to the Data reference (ocapi-data-code-versions).
{
  const input = {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
    method: 'GET', path: '/code_versions',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runResolve(input);
  assert.equal(code, 0, `resolve should exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  const top = out.candidates[0];
  assert.equal(top.reference, 'ocapi-data-code-versions', `Data reference resolved; got ${JSON.stringify(out.candidates)}`);
  assert.equal(top.slug, 'get-code_versions');
}

// A path that needs the version-tolerant fallback + a templated segment:
// GET /products/{id} (with a concrete id) resolves to ocapi-shop-products.
{
  const input = {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
    method: 'GET', path: '/products/ABC-123',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runResolve(input);
  assert.equal(code, 0, `resolve should exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  const top = out.candidates[0];
  assert.equal(top.reference, 'ocapi-shop-products');
  assert.equal(top.slug, 'get-products-id');
}

// No match -> exit 0 with an empty candidate list (the model then asks the user
// or falls back), NOT a crash and NOT a fabricated slug.
{
  const input = {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
    method: 'POST', path: '/nonexistent-resource-xyz',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout } = runResolve(input);
  assert.equal(code, 0, 'no-match still exits 0');
  const out = JSON.parse(stdout);
  assert.deepEqual(out.candidates, [], 'no fabricated candidate on a miss');
}

// Missing method/path -> exit 2 (bad input), like scenario.js's contract.
{
  const { code, stderr } = runResolve({
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  });
  assert.equal(code, 2, 'missing method/path is a usage error');
  assert.match(stderr, /method|path/i);
}

console.log('ok');
