'use strict';

// Live drift probe for catalog-keys.js. URL/title drift on Salesforce
// rebrands is the failure mode. This test scrapes the live `/docs/apis`
// catalog and asserts that every catalog-keys productTitle resolves to
// a real product. Skipped by default; opt in with DSC_LIVE_TESTS=1.

const assert = require('node:assert/strict');
const { CATALOG_KEYS } = require('../scrape/catalog-keys.js');
const { parseApiCatalog } = require('../scrape/parse-api-catalog.js');

if (!process.env.DSC_LIVE_TESTS) {
  console.log('ok (skipped: set DSC_LIVE_TESTS=1 to probe live catalog)');
  process.exit(0);
}

async function main() {
  const url = 'https://developer.salesforce.com/docs/apis';
  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  assert.ok(res.ok, `failed to fetch catalog (status=${res.status}): ${url}`);
  const html = await res.text();
  const products = parseApiCatalog(html);
  assert.ok(products.length > 0, `parsed zero products from ${url}`);
  const titles = new Set(products.map((p) => p.title));

  const missing = [];
  for (const [key, productTitle] of Object.entries(CATALOG_KEYS)) {
    if (!titles.has(productTitle)) missing.push({ key, productTitle });
  }
  if (missing.length > 0) {
    const pretty = missing.map((m) => `  ${m.key} -> ${JSON.stringify(m.productTitle)}`).join('\n');
    assert.fail(
      `catalog-keys productTitle(s) did not resolve in live catalog ` +
      `(Salesforce probably rebranded one of these):\n${pretty}\n` +
      `live titles: ${[...titles].sort().join(', ')}`,
    );
  }
  console.log(`ok (probed ${Object.keys(CATALOG_KEYS).length} catalog-keys against ${products.length} live products)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
