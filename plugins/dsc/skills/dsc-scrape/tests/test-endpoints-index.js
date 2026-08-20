'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// We test by invoking the same code path scrape.js uses – import its internal
// pieces via the parsers and writeIndex, not by spawning the CLI (keeps the
// test offline and deterministic).
const { parseOas } = require('../../../shared/scrape/parse-oas.js');
const { parseAmf } = require('../../../shared/scrape/parse-amf.js');
const { writeIndex } = require('../../../shared/scrape/write-slugs.js');
const { basePathFromBaseUrl } = require('../../../shared/scrape/scrape.js');

// Helper: build an `endpoints` map the way Task 1 wires it in scrape.js.
// This is the reference shape; the production code must match.
function buildEndpointsMap(slugs) {
  const entries = new Map();
  for (const s of slugs) {
    if (s.kind !== 'endpoint') continue;
    entries.set(s.slug, {
      method: s.endpoint.method,
      path: s.endpoint.path,
    });
  }
  return Object.fromEntries(entries);
}

function runOasFixture() {
  const yaml = require('../../../shared/scrape/load-yaml.js');
  const fixturePath = path.join(__dirname, 'fixtures', 'mini-oas.yaml');
  const doc = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
  const slugs = parseOas(doc);
  const slugList = slugs.map((s) => s.slug);
  const endpoints = buildEndpointsMap(slugs);
  const summarySlug = slugs.find((s) => s.kind === 'summary');
  const basePath = basePathFromBaseUrl(summarySlug?.summary?.baseUrl);

  // Existing contract: `slugs` is still a flat array of strings.
  assert.deepEqual(slugList, ['Summary', 'getFoo', 'createFoo', 'type:Foo']);

  // New contract: `endpoints` only contains endpoint-kind slugs, with method + path.
  assert.deepEqual(endpoints, {
    getFoo: { method: 'GET', path: '/foo' },
    createFoo: { method: 'POST', path: '/foo' },
  });

  // basePath derived from the spec's servers[0].url pathname.
  // The fixture's `servers: [- url: https://example.test/api]` should yield '/api'.
  assert.equal(basePath, '/api');

  // Write + read back through writeIndex to confirm the shape round-trips.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-scrape-test-'));
  try {
    writeIndex(tmp, 'test-area', 'mini', {
      reference: 'mini',
      title: 'Mini',
      basePath,
      slugs: slugList,
      endpoints,
    });
    const readBack = JSON.parse(
      fs.readFileSync(path.join(tmp, 'test-area', 'mini', '_index.json'), 'utf8'),
    );
    assert.deepEqual(readBack.slugs, slugList);
    assert.deepEqual(readBack.endpoints, endpoints);
    assert.equal(readBack.basePath, '/api');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runBasePathDerivation() {
  // Templated SCAPI base URL with {shortCode} host token: pathname is recoverable.
  assert.equal(
    basePathFromBaseUrl('https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-orders/v1'),
    '/checkout/shopper-orders/v1',
  );
  // OCAPI Swagger 2 host+basePath rebuilt as URL.
  assert.equal(
    basePathFromBaseUrl('https://{host}/s/-/dw/data/v25_6'),
    '/s/-/dw/data/v25_6',
  );
  // OCAPI Swagger 2 with a templated {siteId} segment in the path: {...} survives
  // intact (URL parsing percent-encodes it; basePathFromBaseUrl decodes back).
  assert.equal(
    basePathFromBaseUrl('https://{host}/s/{siteId}/dw/shop/v25_6'),
    '/s/{siteId}/dw/shop/v25_6',
  );
  // Trailing slash on the base URL is normalized away.
  assert.equal(
    basePathFromBaseUrl('https://example.test/api/'),
    '/api',
  );
  // Empty / null / undefined / non-string -> null (skipped on write).
  assert.equal(basePathFromBaseUrl(''), null);
  assert.equal(basePathFromBaseUrl(null), null);
  assert.equal(basePathFromBaseUrl(undefined), null);
  // Bare host with no path component -> null (no prefix to strip on resolveSlug).
  assert.equal(basePathFromBaseUrl('https://example.test'), null);
  assert.equal(basePathFromBaseUrl('https://example.test/'), null);
  // Malformed URL -> null (don't crash the scrape).
  assert.equal(basePathFromBaseUrl('not a url at all'), null);
}

function runAmfFixture() {
  const fixturePath = path.join(__dirname, 'fixtures', 'einstein-recommendations.amf.json');
  const doc = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const slugs = parseAmf(doc);
  const endpoints = buildEndpointsMap(slugs);
  // At least one endpoint should appear; the exact names depend on the fixture.
  assert.ok(Object.keys(endpoints).length > 0, 'AMF fixture should produce at least one endpoint');
  for (const [slug, v] of Object.entries(endpoints)) {
    assert.ok(typeof v.method === 'string' && v.method === v.method.toUpperCase(), `slug ${slug} has uppercase method`);
    assert.ok(typeof v.path === 'string' && v.path.startsWith('/'), `slug ${slug} has absolute path`);
  }
}

function runPrototypeNamedSlug() {
  const endpoints = buildEndpointsMap([{
    kind: 'endpoint',
    slug: '__proto__',
    endpoint: { method: 'GET', path: '/safe' },
  }]);
  assert.equal(Object.getPrototypeOf(endpoints), Object.prototype);
  assert.equal(Object.hasOwn(endpoints, '__proto__'), true);
  assert.deepEqual(endpoints.__proto__, { method: 'GET', path: '/safe' });
}

runOasFixture();
runAmfFixture();
runBasePathDerivation();
runPrototypeNamedSlug();
console.log('ok');
