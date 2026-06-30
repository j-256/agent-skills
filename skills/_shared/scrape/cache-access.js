'use strict';

// Blind-ingress cache accessor. Scripts call getReference() to *get data*: it
// refreshes the reference first if absent/stale, warms the family landing
// manifest so cross-reference walks can't cold-miss siblings, and returns the
// resolved dir + staleness. The model never orchestrates scraping; this is the
// deterministic ingress that replaces model-driven scrapeRefresh calls.
// See docs/superpowers/specs/2026-06-28-blind-ingress-cache-accessor-design.md.

const fs = require('node:fs');
const path = require('node:path');
const { scrapeRefresh, ScrapeInvocationError } = require('../scrape-refresh.js');
const { areaKeyFromReferencesPath } = require('./scrape.js');
const { resolveReferenceDir, ReferenceNotCachedError } = require('./resolve-cache.js');

class CacheAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CacheAccessError';
  }
}

function readScrapedAt(dir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, '_index.json'), 'utf8'));
    return typeof doc.scrapedAt === 'string' ? doc.scrapedAt : null;
  } catch {
    return null;
  }
}

// Get a reference's cache data, refreshing first if needed. Returns
// { area, reference, dir, refreshed, stale, scrapedAt, landingFile }.
// On refresh failure: serve stale data if the reference dir already exists
// (with stale:true), else throw CacheAccessError.
async function getReference({ referenceUrl, cacheRoot, scrapeScript } = {}) {
  if (typeof referenceUrl !== 'string' || referenceUrl.length === 0) {
    throw new CacheAccessError('getReference: referenceUrl is required');
  }
  if (typeof cacheRoot !== 'string' || cacheRoot.length === 0) {
    throw new CacheAccessError('getReference: cacheRoot is required');
  }

  // area + reference id are always derived from the URL: scrapeRefresh scrapes by
  // URL and derives its own area, so accepting a caller override here would let
  // the resolve half disagree with the scrape half (review finding A). Derive both.
  const refId = referenceUrl.split('/').filter(Boolean).pop();
  const areaKey = areaKeyFromReferencesPath(referenceUrl);
  const landingFile = path.join(cacheRoot, '_landing', `${areaKey}.json`);

  // Refresh the requested reference. scrapeRefresh handles its own TTL freshness
  // check (returns refreshed:false when the cache is fresh).
  let refreshed = false;
  let stale = false;
  try {
    const result = await scrapeRefresh({ scrapeScript, referenceUrl, cacheRoot });
    refreshed = result.refreshed === true;
  } catch (e) {
    if (e instanceof ScrapeInvocationError) {
      // Refresh failed. Serve stale if we already have something cached.
      const refDir = path.join(cacheRoot, areaKey, refId);
      if (fs.existsSync(refDir)) {
        stale = true;
      } else {
        throw new CacheAccessError(`getReference: refresh failed and no cached data for '${refId}': ${e.message}`);
      }
    } else {
      throw e;
    }
  }

  const { dir } = resolveReferenceDir(cacheRoot, refId, { area: areaKey });

  return {
    area: areaKey,
    reference: refId,
    dir,
    refreshed,
    stale,
    scrapedAt: readScrapedAt(dir),
    landingFile,
  };
}

// Pre-warm several references with bounded concurrency (default 5). Each goes
// through getReference (refresh-if-stale, serve-stale-on-fail). Returns the
// resolved results. Used by the cross-reference bridge's cold-cache discovery;
// the cap avoids a spoofed-browser burst that would trip rate-limiting.
async function prewarmFamily({ referenceUrls, cacheRoot, scrapeScript, concurrency = 5 } = {}) {
  if (!Array.isArray(referenceUrls)) {
    throw new CacheAccessError('prewarmFamily: referenceUrls must be an array');
  }
  const results = [];
  let i = 0;
  async function worker() {
    while (i < referenceUrls.length) {
      const myUrl = referenceUrls[i++];
      try {
        results.push(await getReference({ referenceUrl: myUrl, cacheRoot, scrapeScript }));
      } catch (e) {
        // A single sibling that can't warm is skipped, not fatal -- the structural
        // scan over whatever warmed will still find the producer if present. Two
        // ways a sibling fails to warm: CacheAccessError (refresh failed, nothing
        // cached) and ReferenceNotCachedError (refresh exited 0 but wrote no ref
        // dir -- a markdown concept page like `about-commerce-api` that the family
        // landing lists but the scraper skips). Both are non-fatal here.
        if (!(e instanceof CacheAccessError) && !(e instanceof ReferenceNotCachedError)) throw e;
      }
    }
  }
  const pool = Math.max(1, Math.min(concurrency, referenceUrls.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

// Enumerate the family's references from the landing manifest. Read-only.
function siblings(cacheRoot, area) {
  const landingFile = path.join(cacheRoot, '_landing', `${area}.json`);
  try {
    const doc = JSON.parse(fs.readFileSync(landingFile, 'utf8'));
    return Array.isArray(doc.references)
      ? doc.references.filter((r) => r && typeof r.id === 'string').map((r) => ({ id: r.id, title: r.title || null }))
      : [];
  } catch {
    return [];
  }
}

module.exports = { getReference, siblings, prewarmFamily, CacheAccessError };
