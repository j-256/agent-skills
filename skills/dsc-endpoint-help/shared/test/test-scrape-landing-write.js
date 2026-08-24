'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const { writeLanding } = require('../scrape/write-slugs.js');
const { resolveVersions } = require('../scrape/reference-versions.js');

// Simulate what runReferenceRoot now writes after parsing a reference page's
// full area catalog: an area-landing manifest listing every reference in the
// area, including both versions of a versioned reference.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-landing-'));
try {
  const catalog = [
    { id: 'shopper-baskets', title: 'Shopper Baskets V1', referenceType: 'rest-oa3' },
    { id: 'shopper-baskets-v2', title: 'Shopper Baskets V2', referenceType: 'rest-oa3' },
    { id: 'shopper-orders', title: 'Shopper Orders', referenceType: 'rest-oa3' },
  ];
  const area = 'commerce_commerce-api';
  writeLanding(root, area, {
    kind: 'area-landing',
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references',
    area,
    scrapedAt: '2026-06-27T00:00:00.000Z',
    references: catalog,
  });

  // The landing file exists where consumers look for it.
  const landingPath = path.join(root, '_landing', `${area}.json`);
  assert.ok(fs.existsSync(landingPath), 'area landing manifest must be written');
  const doc = JSON.parse(fs.readFileSync(landingPath, 'utf8'));
  assert.equal(doc.kind, 'area-landing');
  assert.equal(doc.references.length, 3);

  // The whole point: the exposer can now see the version sibling from a
  // per-reference-style cache (landing present, no need for the ref dirs).
  const r = resolveVersions(root, 'shopper-baskets', { area });
  assert.equal(r.latest, 'shopper-baskets-v2');
  assert.equal(r.hasMultipleVersions, true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ok');
