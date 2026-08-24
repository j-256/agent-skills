'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

// Stub the fetch surface BEFORE requiring scrape.js. fetch-url.js is the only
// network entry point in scrape.js's import chain; replacing its export is
// enough to make runApiCatalog deterministic.
const fetchUrlPath = require.resolve('../../../shared/scrape/fetch-url.js');
const apiCatalogHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'api-catalog-mini.html'),
  'utf8',
);
const areaLandingHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'area-landing-commerce.html'),
  'utf8',
);

require.cache[fetchUrlPath] = {
  id: fetchUrlPath,
  filename: fetchUrlPath,
  loaded: true,
  exports: {
    fetchUrl: async (url) => {
      if (/\/docs\/apis$/.test(url)) return apiCatalogHtml;
      if (/\/commerce\/commerce-api\/references$/.test(url)) return areaLandingHtml;
      throw new Error(`unexpected fetchUrl call in test: ${url}`);
    },
  },
};

const { main } = require('../../../shared/scrape/scrape.js');

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-enrich-'));
  try {
    await main(['node', 'scrape.js', 'https://developer.salesforce.com/docs/apis', tmp]);

    // --- Catalog written
    const catalogPath = path.join(tmp, '_catalog.json');
    assert.ok(fs.existsSync(catalogPath), '_catalog.json should be written');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    assert.equal(catalog.kind, 'api-catalog');
    assert.equal(catalog.products.length, 2);

    // --- Scrapeable product carries searchKeys
    const scapi = catalog.products.find((p) => p.title === 'B2C Commerce API');
    assert.ok(scapi, 'B2C Commerce API product should be present');
    assert.ok(Array.isArray(scapi.searchKeys),
      `B2C Commerce API should have searchKeys array; got ${JSON.stringify(scapi.searchKeys)}`);
    // Auto-derived from landing: OCI, SLAS. Hand-curated from catalog-keys: SCAPI.
    for (const expected of ['OCI', 'SLAS', 'SCAPI']) {
      assert.ok(
        scapi.searchKeys.includes(expected),
        `B2C Commerce API searchKeys must include ${expected}; got ${JSON.stringify(scapi.searchKeys)}`,
      );
    }

    // --- Non-scrapeable product (atlas) has searchKeys: [] (or no key, but present products
    // get an empty array for shape consistency)
    const pardot = catalog.products.find((p) => p.title === 'Pardot API');
    assert.ok(pardot, 'Pardot API product should be present');
    // Pardot has referenceShape: atlas -> no landing fetched -> no auto-derived keys.
    // No catalog-keys entry maps to "Pardot API" either. Result: empty array (or absent).
    if ('searchKeys' in pardot) {
      assert.deepEqual(pardot.searchKeys, [],
        'atlas-shaped product should have empty searchKeys (no landing to derive from)');
    }

    // --- Landing was written to _landing/<area>.json
    const landingPath = path.join(tmp, '_landing', 'commerce_commerce-api.json');
    assert.ok(fs.existsSync(landingPath),
      `landing JSON should be written at ${landingPath} (catalog-time pre-fetch)`);
    const landing = JSON.parse(fs.readFileSync(landingPath, 'utf8'));
    assert.equal(landing.references.length, 3);

    // --- Idempotency: re-running on a fresh cache changes nothing observable.
    const beforeMtime = fs.statSync(catalogPath).mtimeMs;
    await main(['node', 'scrape.js', 'https://developer.salesforce.com/docs/apis', tmp]);
    const afterMtime = fs.statSync(catalogPath).mtimeMs;
    assert.equal(beforeMtime, afterMtime,
      'second run on fresh cache should not rewrite _catalog.json (TTL hit)');

    console.log('ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
