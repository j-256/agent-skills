'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// We test by invoking the same code path scrape.js uses – import its internal
// pieces via the parsers and writeIndex, not by spawning the CLI (keeps the
// test offline and deterministic).
const { parseOas } = require('../lib/scrape/parse-oas.js');
const { parseAmf } = require('../lib/scrape/parse-amf.js');
const { writeIndex } = require('../lib/scrape/write-slugs.js');

// Helper: build an `endpoints` map the way Task 1 wires it in scrape.js.
// This is the reference shape; the production code must match.
function buildEndpointsMap(slugs) {
  const endpoints = {};
  for (const s of slugs) {
    if (s.kind !== 'endpoint') continue;
    endpoints[s.slug] = {
      method: s.endpoint.method,
      path: s.endpoint.path,
    };
  }
  return endpoints;
}

function runOasFixture() {
  const yaml = require('../lib/scrape/load-yaml.js');
  const fixturePath = path.join(__dirname, 'fixtures', 'mini-oas.yaml');
  const doc = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
  const slugs = parseOas(doc);
  const slugList = slugs.map((s) => s.slug);
  const endpoints = buildEndpointsMap(slugs);

  // Existing contract: `slugs` is still a flat array of strings.
  assert.deepEqual(slugList, ['Summary', 'getFoo', 'createFoo', 'type:Foo']);

  // New contract: `endpoints` only contains endpoint-kind slugs, with method + path.
  assert.deepEqual(endpoints, {
    getFoo: { method: 'GET', path: '/foo' },
    createFoo: { method: 'POST', path: '/foo' },
  });

  // Write + read back through writeIndex to confirm the shape round-trips.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-scrape-test-'));
  try {
    writeIndex(tmp, 'test-area', 'mini', {
      reference: 'mini',
      title: 'Mini',
      slugs: slugList,
      endpoints,
    });
    const readBack = JSON.parse(
      fs.readFileSync(path.join(tmp, 'test-area', 'mini', '_index.json'), 'utf8'),
    );
    assert.deepEqual(readBack.slugs, slugList);
    assert.deepEqual(readBack.endpoints, endpoints);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

runOasFixture();
runAmfFixture();
console.log('ok');
