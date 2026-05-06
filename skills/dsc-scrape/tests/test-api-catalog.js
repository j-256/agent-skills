'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseApiCatalog } = require('../scripts/parse-api-catalog.js');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'docs-apis.html'), 'utf8');
const products = parseApiCatalog(html);

assert.ok(products.length >= 15, `expected many products, got ${products.length}`);

const scapi = products.find((p) => p.referenceUrl && p.referenceUrl.endsWith('/commerce/commerce-api/references'));
assert.ok(scapi, 'SCAPI product missing');
assert.equal(scapi.title, 'B2C Commerce API');
assert.ok(scapi.body.length > 20, 'body should be a real description');
assert.equal(scapi.referenceShape, 'area-landing');
assert.ok(scapi.overviewUrl.startsWith('https://developer.salesforce.com/'));

const pardot = products.find((p) => /pardot/.test(p.referenceUrl || ''));
assert.ok(pardot, 'Pardot product missing');
assert.ok(pardot.referenceShape === 'atlas' || pardot.referenceShape === 'static-html',
  `Pardot referenceHref is a non-scrapeable static page (got ${pardot.referenceShape})`);

const areaLandings = products.filter((p) => p.referenceShape === 'area-landing');
assert.ok(areaLandings.length >= 10,
  `expected a bunch of area-landing products (scrapeable targets), got ${areaLandings.length}`);

const staticPages = products.filter((p) => p.referenceShape === 'atlas' || p.referenceShape === 'static-html');
assert.ok(staticPages.length >= 1, 'expected at least one static-html product (out-of-scope)');

const ids = new Set(products.map((p) => p.referenceUrl));
assert.equal(ids.size, products.length, 'no duplicate referenceUrls');

console.log(`  api-catalog parser ok (${products.length} products)`);
