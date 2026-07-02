#!/usr/bin/env node
'use strict';

// Deterministic target discovery: turn a METHOD + live path into the exact
// {reference, slug} within an API area, by scanning the area landing the blind
// accessor warms. This closes the last mile the alias map can't: aliases.js
// resolves an OCAPI hint ("OCAPI shop API", "/dw/shop") to the AREA-LANDING URL,
// but not to a reference slug -- and the model can't guess OCAPI reference slugs
// (it reaches for `ocapi-shop-api`, which 404s). Given "POST /orders" this
// returns ocapi-shop-orders.post-orders, ready to hand to scenario.js.
//
// Algorithm (mirrors scenario.js's cross-reference discovery, reused wholesale):
//   1. Warm the area landing via the accessor (getReference on the landing URL).
//   2. Enumerate siblings from the landing manifest.
//   3. Narrow to references whose id shares a token with the path's first
//      segment (orders -> ocapi-shop-orders, ocapi-data-orders, ...), so we
//      prewarm a handful, not the whole 80-reference family. Widen to the whole
//      family only if narrowing matched nothing.
//   4. Prewarm the narrowed set, then resolveSlug each index against METHOD/path.
//   5. Return every match as a candidate (most-specific path first), each with a
//      scenario-ready referenceUrl. Empty list on a miss -- never a fabricated
//      slug (the decline-don't-fabricate contract).
//
// This is generic ("resolve a live request within an area"); OCAPI is the family
// it unblocks. It never scrapes on its own beyond the accessor's refresh-if-stale.

const fs = require('node:fs');
const path = require('node:path');
const { siblings, prewarmFamily, CacheAccessError } = require('../lib/scrape/cache-access.js');
const { scrapeRefresh, ScrapeInvocationError } = require('../lib/scrape-refresh.js');
const { areaKeyFromReferencesPath } = require('../lib/scrape/scrape.js');
const { resolveReferenceDir } = require('../lib/scrape/resolve-cache.js');
const { matchRelativePath } = require('../lib/resolve-slug.js');

function die(code, obj) {
  process.stderr.write(`${obj && obj.error ? obj.error : JSON.stringify(obj)}\n`);
  process.exit(code);
}

async function readStdinJson() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    process.stdin.on('error', reject);
  });
}

// The path's first meaningful segment, lowercased (orders, code_versions,
// products). Used to narrow the sibling set to references likely to carry it.
// The path's first meaningful segment, lowercased AND separator-stripped. OCAPI
// resource paths are snake_case (`code_versions`, `custom_objects`) but the
// reference ids in the landing are hyphenated (`ocapi-data-code-versions`), so a
// raw substring test (`id.includes('code_versions')`) never matches and the
// narrowing silently falls back to widening the whole family. Strip `_`/`-` on
// both sides (see refKey) so `code_versions` matches `ocapi-data-code-versions`.
function firstPathToken(p) {
  const seg = String(p || '').split('?')[0].split('/').filter(Boolean)[0] || '';
  return seg.toLowerCase().replace(/[_-]/g, '');
}

// Normalize a reference id the same way, so the narrowing comparison is
// separator-agnostic on both sides.
function refKey(id) {
  return String(id || '').toLowerCase().replace(/[_-]/g, '');
}

function readIndex(cacheRoot, reference, area) {
  try {
    const { dir } = resolveReferenceDir(cacheRoot, reference, area ? { area } : {});
    return JSON.parse(fs.readFileSync(path.join(dir, '_index.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const input = await readStdinJson().catch((e) => die(2, { error: `resolve-target: expected JSON on stdin: ${e.message}` }));
  const { referenceUrl, method, path: livePath, cacheRoot, scrapeScript } = input || {};
  if (!referenceUrl) die(2, { error: 'resolve-target: missing `referenceUrl` (the area-landing URL)' });
  if (!method || !livePath) die(2, { error: 'resolve-target: missing `method` and/or `path`' });
  if (!cacheRoot) die(2, { error: 'resolve-target: missing `cacheRoot`' });

  // 1. Warm the area landing. A `.../references` URL is landing-only, so warm it
  //    via scrapeRefresh directly (getReference expects a reference dir and would
  //    fail on a landing URL). scrapeRefresh writes the landing manifest so
  //    siblings() can enumerate it. On refresh failure, fall back to whatever
  //    landing is already cached (area derived from the URL) rather than aborting.
  const area = areaKeyFromReferencesPath(referenceUrl);
  try {
    await scrapeRefresh({ scrapeScript, referenceUrl, cacheRoot });
  } catch (e) {
    if (!(e instanceof ScrapeInvocationError)) throw e;
    // Refresh failed -- if we have a cached landing, scan it; else there's
    // nothing to resolve against.
    const landingFile = path.join(cacheRoot, '_landing', `${area}.json`);
    if (!fs.existsSync(landingFile)) {
      die(3, { error: `resolve-target: could not warm the area landing and none is cached: ${e.message}` });
    }
  }

  // 2. Enumerate siblings from the landing manifest.
  const fam = siblings(cacheRoot, area).map((s) => s.id).filter(Boolean);

  // 3. Narrow to references whose id shares the path's first token. The
  //    landing lists ids like ocapi-shop-orders / ocapi-data-orders; both share
  //    the token "orders" with POST /orders. Widen to the whole family if the
  //    token narrowing matched nothing (defensive -- e.g. a resource whose path
  //    segment isn't in the ref id).
  const token = firstPathToken(livePath);
  const urlFor = (id) => referenceUrl.replace(/\/references\/?$/, `/references/${id}`);
  let narrow = token ? fam.filter((id) => refKey(id).includes(token)) : [];
  if (narrow.length === 0) narrow = fam;

  // 4. Prewarm the narrowed set, then resolveSlug each index.
  try {
    await prewarmFamily({ referenceUrls: narrow.map(urlFor), cacheRoot, scrapeScript });
  } catch (e) {
    if (!(e instanceof CacheAccessError)) throw e;
    // A prewarm failure is non-fatal: scan whatever is already cached.
  }

  const candidates = [];
  for (const id of narrow) {
    const index = readIndex(cacheRoot, id, area);
    if (!index) continue;
    const match = matchRelativePath({ method, relPath: livePath, index });
    if (!match) continue;
    candidates.push({
      reference: id,
      slug: match.slug,
      method: String(method).toUpperCase(),
      referenceUrl: urlFor(id),
      pathParams: match.pathParams || {},
    });
  }

  // 5. Most-specific path wins the top slot (longest spec path). resolveSlug
  //    already sorts within a reference; this orders across references so a
  //    literal-heavy match outranks a parametric one.
  candidates.sort((a, b) => (b.slug || '').length - (a.slug || '').length);

  process.stdout.write(`${JSON.stringify({ area, candidates }, null, 2)}\n`);
}

// Run as a CLI when invoked directly; stay silent (just export the helpers)
// when required by a test, so the narrowing normalization can be unit-tested
// without spawning the whole stdin-driven flow.
if (require.main === module) {
  main().catch((e) => die(1, { error: `resolve-target: unexpected: ${e.stack || e.message}` }));
}

module.exports = { firstPathToken, refKey };
