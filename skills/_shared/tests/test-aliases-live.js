'use strict';

// Live-URL probe for the catalog-missing alias map. URL drift on Salesforce
// rebrands is the known failure mode (an entry can be typo-free and still
// 404). The offline test (test-aliases.js) catches shape/typo regressions;
// this one catches drift. Skipped by default; opt in with DSC_LIVE_TESTS=1.

const assert = require('node:assert/strict');
const { CATALOG_MISSING_ALIASES } = require('../scrape/aliases.js');

if (!process.env.DSC_LIVE_TESTS) {
  console.log('ok (skipped: set DSC_LIVE_TESTS=1 to probe live alias URLs)');
  process.exit(0);
}

async function main() {
  const urls = [...new Set(Object.values(CATALOG_MISSING_ALIASES))];
  const results = await Promise.all(urls.map(async (url) => {
    try {
      // GET, not HEAD: DSC's CDN returns 404 on HEAD for some valid paths
      // (e.g. /docs/ai/agentforce/references) while GET returns 200. Use the
      // verb the cascade actually uses.
      const res = await fetch(url, { method: 'GET', redirect: 'follow' });
      return { url, status: res.status, ok: res.status >= 200 && res.status < 400 };
    } catch (err) {
      return { url, status: null, ok: false, error: err.message };
    }
  }));
  for (const r of results) {
    assert.ok(
      r.ok,
      `alias URL did not resolve (status=${r.status}${r.error ? `, error=${r.error}` : ''}): ${r.url}`,
    );
  }
  console.log(`ok (probed ${urls.length} live URLs)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
