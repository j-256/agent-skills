'use strict';

// Regression: same ref id (e.g. `orders`) appearing in two different product
// areas (SCAPI's commerce-api/orders vs. Subscription Management's
// orders) must not collide on disk. Pre-area-keying, the cache was
// `<root>/<ref-id>/` so the second scrape silently overwrote (or worse,
// short-circuited via the TTL on) the first. Now the cache is
// `<root>/<area>/<ref-id>/` and both coexist.
//
// This test exercises the writer end-to-end via handleReference + writeIndex,
// not the live network – we hand it canned slug docs.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const { writeIndex, writeSlug } = require('../../../shared/scrape/write-slugs.js');

function fakeIndex(area, scrapedAt) {
  return {
    reference: 'orders',
    area,
    title: 'Orders',
    referencePageUrl: `https://example.com/docs/${area.replace(/_/g, '/')}/references/orders?meta=Summary`,
    scrapedAt,
    source: { format: 'oas-3', specUrl: `https://example.com/${area}/orders.yaml` },
    slugs: ['Summary', `endpoint-from-${area}`],
    siblings: [],
  };
}

function fakeEndpoint(area, slug) {
  return {
    kind: 'endpoint',
    reference: 'orders',
    slug,
    url: `https://example.com/refs/orders?meta=${slug}`,
    scrapedAt: new Date().toISOString(),
    source: { format: 'oas-3', specUrl: `https://example.com/${area}/orders.yaml` },
    endpoint: { method: 'POST', path: `/${area}/orders` },
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-scrape-area-iso-'));
try {
  const SCAPI = 'commerce_commerce-api';
  const SM = 'revenue_subscription-management';

  // Write two distinct references under the same ref id, in different areas.
  writeIndex(root, SCAPI, 'orders', fakeIndex(SCAPI, '2026-05-09T12:00:00Z'));
  writeSlug(root, SCAPI, 'orders', 'endpoint-from-commerce_commerce-api', fakeEndpoint(SCAPI, 'endpoint-from-commerce_commerce-api'));

  writeIndex(root, SM, 'orders', fakeIndex(SM, '2026-05-09T12:01:00Z'));
  writeSlug(root, SM, 'orders', 'endpoint-from-revenue_subscription-management', fakeEndpoint(SM, 'endpoint-from-revenue_subscription-management'));

  // Both directories must exist and carry their own _index.json with the right specUrl.
  const scapiIndex = JSON.parse(fs.readFileSync(path.join(root, SCAPI, 'orders', '_index.json'), 'utf8'));
  const smIndex = JSON.parse(fs.readFileSync(path.join(root, SM, 'orders', '_index.json'), 'utf8'));
  assert.equal(scapiIndex.source.specUrl, `https://example.com/${SCAPI}/orders.yaml`,
    'SCAPI orders _index.json must reference SCAPI spec, not SM');
  assert.equal(smIndex.source.specUrl, `https://example.com/${SM}/orders.yaml`,
    'SM orders _index.json must reference SM spec, not SCAPI');

  // Per-endpoint files must live under their own area – no leakage.
  const scapiSlug = JSON.parse(fs.readFileSync(
    path.join(root, SCAPI, 'orders', 'endpoint-from-commerce_commerce-api.json'), 'utf8'
  ));
  const smSlug = JSON.parse(fs.readFileSync(
    path.join(root, SM, 'orders', 'endpoint-from-revenue_subscription-management.json'), 'utf8'
  ));
  assert.equal(scapiSlug.endpoint.path, '/commerce_commerce-api/orders');
  assert.equal(smSlug.endpoint.path, '/revenue_subscription-management/orders');

  // Sanity: the SCAPI dir does NOT carry the SM-area endpoint file or vice versa.
  assert.ok(!fs.existsSync(path.join(root, SCAPI, 'orders', 'endpoint-from-revenue_subscription-management.json')),
    'SCAPI dir leaked the SM endpoint file');
  assert.ok(!fs.existsSync(path.join(root, SM, 'orders', 'endpoint-from-commerce_commerce-api.json')),
    'SM dir leaked the SCAPI endpoint file');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('  area-isolation ok (SCAPI orders + SM orders coexist)');
