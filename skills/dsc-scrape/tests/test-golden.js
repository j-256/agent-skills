'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require('../lib/scrape/load-yaml.js');
const { parseOas } = require('../lib/scrape/parse-oas.js');
const { parseAmf } = require('../lib/scrape/parse-amf.js');
const { parseSwagger2 } = require('../lib/scrape/parse-swagger2.js');

const FIX = path.join(__dirname, 'fixtures');
const EXP = path.join(__dirname, 'expected');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function assertGolden(goldenFile, actual) {
  const goldenPath = path.join(EXP, goldenFile);
  const expected = loadJson(goldenPath);
  assert.deepEqual(actual, expected, `golden mismatch: ${goldenFile}`);
}

const oasSpec = yaml.load(fs.readFileSync(path.join(FIX, 'orders.yaml'), 'utf8'));
const oasSlugs = parseOas(oasSpec);
assertGolden(
  'orders-Summary.json',
  oasSlugs.find((s) => s.slug === 'Summary')
);
assertGolden(
  'orders-createOrders.json',
  oasSlugs.find((s) => s.slug === 'createOrders')
);
assertGolden(
  'orders-type-Order.json',
  oasSlugs.find((s) => s.slug === 'type:Order')
);

const amfDoc = JSON.parse(
  fs.readFileSync(path.join(FIX, 'einstein-recommendations.amf.json'), 'utf8')
);
const amfSlugs = parseAmf(amfDoc);
assertGolden(
  'einstein-recommendations-Summary.json',
  amfSlugs.find((s) => s.slug === 'Summary')
);
assertGolden(
  'einstein-recommendations-getRecommendations.json',
  amfSlugs.find((s) => s.slug === 'getRecommendations')
);
assertGolden(
  'einstein-recommendations-type-ProductForView.json',
  amfSlugs.find((s) => s.slug === 'type:ProductForView')
);

const swagger2Spec = loadJson(path.join(FIX, 'ocapi-shop-products.json'));
const swagger2Slugs = parseSwagger2(swagger2Spec);
assertGolden(
  'ocapi-shop-products-Summary.json',
  swagger2Slugs.find((s) => s.slug === 'Summary')
);
assertGolden(
  'ocapi-shop-products-get-products-ids.json',
  swagger2Slugs.find((s) => s.slug === 'get-products-ids')
);
assertGolden(
  'ocapi-shop-products-type-product.json',
  swagger2Slugs.find((s) => s.slug === 'type:product')
);

console.log('  golden-diff ok (9 slugs)');
