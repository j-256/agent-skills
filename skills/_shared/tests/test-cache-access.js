'use strict';

// Unit tests for the blind-ingress cache accessor (cache-access.js getReference).
// Offline: drives the fake scrape script via FAKE_MODE so no live network.
// See docs/superpowers/specs/2026-06-28-blind-ingress-cache-accessor-design.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getReference, siblings, prewarmFamily, CacheAccessError } = require('../scrape/cache-access.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-scrape.js');

// Each test gets its own temp cache root so cases don't bleed into each other.
function freshCacheRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-cache-access-'));
}

const REF_URL = 'https://developer.salesforce.com/docs/x/references/orders';
// areaKeyFromReferencesPath('.../docs/x/references/orders') -> 'x'
const AREA = 'x';
const REF = 'orders';

// Write a reference dir with an _index.json carrying a given scrapedAt, so
// freshness/staleness can be controlled deterministically in tests.
function seedReference(cacheRoot, area, reference, scrapedAt, extra = {}) {
  const dir = path.join(cacheRoot, area, reference);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '_index.json'),
    JSON.stringify({ reference, area, scrapedAt, endpoints: {}, ...extra }),
  );
  return dir;
}

async function main() {
  // --- Cold cache: nothing present -> refresh invoked, dir exists after, refreshed:true
  {
    const cacheRoot = freshCacheRoot();
    process.env.FAKE_MODE = 'ok-refreshed';
    const r = await getReference({ referenceUrl: REF_URL, cacheRoot, scrapeScript: FAKE });
    assert.equal(r.reference, REF, 'resolves the reference id from the URL');
    assert.equal(r.area, AREA, 'resolves the area key from the URL');
    assert.equal(r.refreshed, true, 'cold cache triggers a refresh');
    assert.equal(r.stale, false, 'a successful refresh is not stale');
    assert.ok(fs.existsSync(r.dir), 'the resolved dir exists after a cold refresh');
    assert.ok(typeof r.scrapedAt === 'string' && r.scrapedAt.length > 0, 'scrapedAt is reported');
  }

  // --- Warm + fresh: scrapeRefresh reports refreshed:false -> refreshed:false, not stale
  {
    const cacheRoot = freshCacheRoot();
    seedReference(cacheRoot, AREA, REF, new Date().toISOString());
    process.env.FAKE_MODE = 'ok-fresh';
    const r = await getReference({ referenceUrl: REF_URL, cacheRoot, scrapeScript: FAKE });
    assert.equal(r.refreshed, false, 'a fresh cache is not refreshed');
    assert.equal(r.stale, false, 'a fresh cache is not stale');
    assert.ok(fs.existsSync(r.dir), 'the dir is still resolvable');
  }

  // --- Serve-stale-on-fail: stale dir present + scrape fails -> stale:true, no throw
  {
    const cacheRoot = freshCacheRoot();
    // Seed an old reference dir so there is cached data to fall back to.
    seedReference(cacheRoot, AREA, REF, '2020-01-01T00:00:00.000Z');
    process.env.FAKE_MODE = 'not-found'; // scrape fails (exit 1)
    const r = await getReference({ referenceUrl: REF_URL, cacheRoot, scrapeScript: FAKE });
    assert.equal(r.stale, true, 'refresh failed but cached data exists -> served stale');
    assert.equal(r.refreshed, false, 'a stale-served reference was not refreshed');
    assert.equal(r.scrapedAt, '2020-01-01T00:00:00.000Z', 'reports the cached (stale) scrapedAt');
  }

  // --- Hard-fail: nothing cached + scrape fails -> CacheAccessError
  {
    const cacheRoot = freshCacheRoot();
    process.env.FAKE_MODE = 'not-found';
    await assert.rejects(
      () => getReference({ referenceUrl: REF_URL, cacheRoot, scrapeScript: FAKE }),
      (e) => e instanceof CacheAccessError,
      'no cached data + failed refresh must throw CacheAccessError',
    );
  }

  // --- Landing-eager: a cold request leaves the family landing written, and
  //     siblings() lists the family from it.
  {
    const cacheRoot = freshCacheRoot();
    process.env.FAKE_MODE = 'ok-refreshed';
    const r = await getReference({ referenceUrl: REF_URL, cacheRoot, scrapeScript: FAKE });
    assert.ok(fs.existsSync(r.landingFile), 'the family landing manifest is written');
    const sibs = siblings(cacheRoot, AREA);
    assert.ok(sibs.some((s) => s.id === REF), 'siblings() lists the family from the landing');
  }

  // --- Malformed args: lib-level typed throw (not a CLI/stdin path)
  {
    await assert.rejects(
      () => getReference({}),
      (e) => e instanceof CacheAccessError,
      'missing referenceUrl/cacheRoot must throw CacheAccessError',
    );
  }

  // --- prewarmFamily: warms multiple sibling references with bounded concurrency,
  // returns the list warmed. Offline via fake-scrape.
  {
    const cacheRoot = freshCacheRoot();
    process.env.FAKE_MODE = 'ok-refreshed';
    const warmed = await prewarmFamily({
      referenceUrls: [
        'https://developer.salesforce.com/docs/x/references/alpha',
        'https://developer.salesforce.com/docs/x/references/beta',
      ],
      cacheRoot, scrapeScript: FAKE, concurrency: 2,
    });
    assert.deepEqual(warmed.map((w) => w.reference).sort(), ['alpha', 'beta']);
    assert.ok(fs.existsSync(path.join(cacheRoot, 'x', 'alpha', '_index.json')));
  }

  console.log('ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
