'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const {
  resolveReferenceDir,
  landingsForReference,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../scrape/resolve-cache.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-cache-'));
  const landingDir = path.join(root, '_landing');
  fs.mkdirSync(landingDir, { recursive: true });

  const scapi = {
    kind: 'area-landing',
    area: 'commerce_commerce-api',
    references: [
      { id: 'orders', referenceType: 'rest-oa3' },
      { id: 'shopper-baskets', referenceType: 'rest-oa3' },
    ],
  };
  const sm = {
    kind: 'area-landing',
    area: 'revenue_subscription-management',
    references: [
      { id: 'orders', referenceType: 'rest-raml' },
      { id: 'quotes', referenceType: 'rest-raml' },
    ],
  };
  fs.writeFileSync(path.join(landingDir, 'commerce_commerce-api.json'), JSON.stringify(scapi));
  fs.writeFileSync(path.join(landingDir, 'revenue_subscription-management.json'), JSON.stringify(sm));

  // Make the actual ref dirs so resolveReferenceDir's existence check passes.
  fs.mkdirSync(path.join(root, 'commerce_commerce-api', 'orders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'commerce_commerce-api', 'shopper-baskets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'revenue_subscription-management', 'orders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'revenue_subscription-management', 'quotes'), { recursive: true });

  return root;
}

function teardown(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const root = setup();
try {
  // Unique ref id resolves cleanly without an explicit area.
  {
    const r = resolveReferenceDir(root, 'shopper-baskets');
    assert.equal(r.area, 'commerce_commerce-api');
    assert.equal(r.dir, path.join(root, 'commerce_commerce-api', 'shopper-baskets'));
  }
  {
    const r = resolveReferenceDir(root, 'quotes');
    assert.equal(r.area, 'revenue_subscription-management');
  }

  // Colliding ref id (`orders` in both SCAPI and SM) requires an explicit area.
  assert.throws(
    () => resolveReferenceDir(root, 'orders'),
    (e) => e instanceof AmbiguousReferenceError &&
           e.candidates.length === 2 &&
           e.candidates.includes('commerce_commerce-api') &&
           e.candidates.includes('revenue_subscription-management'),
    'colliding ref id should throw AmbiguousReferenceError',
  );

  // With explicit area, colliding ref id resolves to the right dir.
  {
    const r = resolveReferenceDir(root, 'orders', { area: 'revenue_subscription-management' });
    assert.equal(r.area, 'revenue_subscription-management');
    assert.equal(r.dir, path.join(root, 'revenue_subscription-management', 'orders'));
  }
  {
    const r = resolveReferenceDir(root, 'orders', { area: 'commerce_commerce-api' });
    assert.equal(r.dir, path.join(root, 'commerce_commerce-api', 'orders'));
  }

  // Unknown ref id throws ReferenceNotCachedError.
  assert.throws(
    () => resolveReferenceDir(root, 'nonexistent'),
    (e) => e instanceof ReferenceNotCachedError,
  );

  // Explicit area + nonexistent dir also throws ReferenceNotCachedError.
  assert.throws(
    () => resolveReferenceDir(root, 'shopper-baskets', { area: 'wrong-area' }),
    (e) => e instanceof ReferenceNotCachedError,
  );

  // landingsForReference returns the area list for a given id.
  const ordersAreas = landingsForReference(root, 'orders').sort();
  assert.deepEqual(ordersAreas, ['commerce_commerce-api', 'revenue_subscription-management']);
  assert.deepEqual(landingsForReference(root, 'shopper-baskets'), ['commerce_commerce-api']);
  assert.deepEqual(landingsForReference(root, 'nonexistent'), []);
} finally {
  teardown(root);
}

console.log('ok');
