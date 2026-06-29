#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getReference, prewarmFamily, siblings, CacheAccessError } = require('../lib/scrape/cache-access.js');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../lib/scrape/resolve-cache.js');
const { resolveVersions } = require('../lib/scrape/reference-versions.js');
const { walkTypes, producersOfType, dominantPathId, ReferenceNotScrapedError } = require('./walk-types.js');
const { composePlan } = require('./compose.js');
const { renderCurlBlock } = require('./curl-block.js');

function die(code, obj) {
  const msg = obj && obj.error ? obj.error : JSON.stringify(obj);
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function readStdinJson() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = await readStdinJson().catch((e) => {
    die(2, { error: `scenario: expected JSON on stdin: ${e.message}` });
  });

  const { target, referenceUrl, cacheRoot, scrapeScript, graph: providedGraph, flowSignal, pinVersion } = input || {};
  if (!target) die(2, { error: 'scenario: missing `target`' });
  if (!referenceUrl) die(2, { error: 'scenario: missing `referenceUrl`' });

  // Every reference the run touches goes through the blind-ingress accessor:
  // it refreshes if stale/absent, serves stale-with-a-flag on refresh failure,
  // and resolves the dir. staleness[] accumulates any reference served stale so
  // the output can warn the user (a stale-backed plan must never look current).
  const staleness = [];
  function recordStaleness(res) {
    if (res && res.stale) staleness.push({ reference: res.reference, scrapedAt: res.scrapedAt });
    return res;
  }
  // prewarmFamily returns an array of getReference results; fold each into the
  // same staleness collector so a sibling served stale during pre-warm still warns.
  function recordStalenessAll(results) {
    for (const r of results || []) recordStaleness(r);
    return results;
  }
  // Note: if a bare reference is served stale and then bumped to a stale latest
  // version, BOTH are recorded -- the bare ref is discarded from the final plan,
  // so this slightly over-reports. That's deliberate: over-warning about stale
  // spec data degrades safely (the user verifies more), under-warning doesn't.

  let scrapeResult;
  try {
    scrapeResult = recordStaleness(await getReference({ scrapeScript, referenceUrl, cacheRoot }));
  } catch (e) {
    if (e instanceof CacheAccessError) {
      die(3, { error: `scenario: scrape failed: ${e.message}` });
    }
    throw e;
  }

  let reference = referenceUrl.split('/').filter(Boolean).pop();
  let effectiveReferenceUrl = referenceUrl;

  // Prefer the latest reference version (e.g. shopper-baskets -> shopper-baskets-v2),
  // unless the caller pinned a version. The getReference above wrote the area
  // landing (its reference scrape persists it), so resolveVersions can see
  // sibling versions here even on a cold cache. Doing this in scenario.js (not in
  // the SKILL.md prose) makes the choice deterministic regardless of the order
  // the model ran its own steps.
  if (!pinVersion) {
    let versions;
    try {
      versions = resolveVersions(cacheRoot, reference, scrapeResult.area ? { area: scrapeResult.area } : {});
    } catch {
      versions = null; // resolveVersions only throws on malformed args; treat as no-op
    }
    if (versions && versions.hasMultipleVersions && !versions.requestedIsVersioned
        && versions.latest !== reference) {
      // Scrape the latest reference so its dir exists for the walk/compose below.
      effectiveReferenceUrl = referenceUrl.replace(/\/[^/]+\/?$/, `/${versions.latest}`);
      try {
        scrapeResult = recordStaleness(await getReference({ scrapeScript, referenceUrl: effectiveReferenceUrl, cacheRoot }));
      } catch (e) {
        if (e instanceof CacheAccessError) {
          die(3, { error: `scenario: scrape failed for latest version '${versions.latest}': ${e.message}` });
        }
        throw e;
      }
      reference = versions.latest;
    }
  }

  let area;
  let refDir;
  try {
    const r = resolveReferenceDir(cacheRoot, reference, scrapeResult.area ? { area: scrapeResult.area } : {});
    area = r.area;
    refDir = r.dir;
  } catch (e) {
    if (e instanceof AmbiguousReferenceError || e instanceof ReferenceNotCachedError) {
      die(3, { error: `scenario: ${e.message}` });
    }
    throw e;
  }
  const indexPath = path.join(refDir, '_index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    die(3, { error: `scenario: cannot read _index.json: ${e.message}` });
  }

  if (!index.endpoints || !(target in index.endpoints)) {
    die(2, { error: `scenario: target '${target}' not found in reference '${reference}'` });
  }

  // --- Cross-reference bridge discovery (only if the target body is a named type) ---
  // If the target's body is a named type with no producer in its own reference,
  // discover the producer reference(s) deterministically: enumerate family
  // siblings from the landing the accessor guaranteed, NARROW-prefetch the
  // name-match candidates and scan; only if that finds nothing, WIDEN-prefetch
  // the whole family and rescan. The resulting siblingRefs feed the walk so it
  // can surface bridge candidates. A provided graph skips discovery (the caller
  // supplied the structure). Anything but a named-type body is a no-op, so every
  // existing single-reference target behaves exactly as before.
  let siblingRefs = [];
  const targetDoc = JSON.parse(fs.readFileSync(path.join(refDir, `${target}.json`), 'utf8'));
  const bodyRef = targetDoc.endpoint && targetDoc.endpoint.body && targetDoc.endpoint.body.schemaRef;
  if (!providedGraph && bodyRef) {
    const typeName = bodyRef.split('/').pop();
    const inThisRef = producersOfType(typeName, [reference], cacheRoot, area).length > 0;
    if (!inThisRef) {
      // Enumerate family siblings from the landing the accessor guaranteed.
      const fam = siblings(cacheRoot, area).map((s) => s.id).filter((id) => id !== reference);
      // Narrow: name-match candidates first.
      const typeWord = typeName.toLowerCase();
      const narrow = fam.filter((id) => id.toLowerCase().includes(typeWord) || typeWord.includes(id.toLowerCase().replace(/-v\d+$/, '')));
      const urlFor = (id) => effectiveReferenceUrl.replace(/\/[^/]+\/?$/, `/${id}`);
      if (narrow.length) {
        recordStalenessAll(await prewarmFamily({ referenceUrls: narrow.map(urlFor), cacheRoot, scrapeScript }));
      }
      let found = producersOfType(typeName, narrow, cacheRoot, area);
      // Widen: if narrow found nothing, warm the whole family and rescan.
      if (found.length === 0 && fam.length) {
        recordStalenessAll(await prewarmFamily({ referenceUrls: fam.map(urlFor), cacheRoot, scrapeScript }));
        found = producersOfType(typeName, fam, cacheRoot, area);
      }
      siblingRefs = [...new Set(found.map((f) => f.reference))];
      // Prefer the latest producer version, the same way the primary target is
      // bumped above. A producer type can be published in several version
      // families (Basket producers live in BOTH shopper-baskets and
      // shopper-baskets-v2); without this filter the walk surfaces every
      // version's producers as bridge candidates (a v1 duplicate of each v2 op)
      // and pass 2 can graft the superseded version. Drop any sibling whose
      // family has a newer version. siblingRefs is the single chokepoint feeding
      // both passes (pass 2's chosen comes from graph.bridgeCandidates, which
      // derives from siblingRefs), so filtering here fixes both. Honor
      // pinVersion: a deliberately pinned version must not be collapsed.
      if (!pinVersion) {
        siblingRefs = siblingRefs.filter((id) => {
          let versions;
          try {
            versions = resolveVersions(cacheRoot, id, { area });
          } catch {
            return true; // resolveVersions only throws on malformed args; keep on no-op
          }
          return versions.latest === id;
        });
      }
    }
  }

  const { bridgeProducer } = input || {};
  let graph;
  try {
    graph = providedGraph || walkTypes({ targetSlug: target, reference, cacheRoot, area, siblingRefs });
  } catch (e) {
    if (e instanceof ReferenceNotScrapedError) {
      die(3, { error: `scenario: ${e.message}` });
    }
    throw e;
  }

  if (!graph.nodes.some((n) => n.slug === target)) {
    die(2, { error: `scenario: provided graph does not include target '${target}'` });
  }

  // Pass 1: bridge candidates exist and the caller hasn't chosen -> return them,
  // do not compose the bridge step (the model picks, then re-invokes with bridgeProducer).
  if (graph.bridgeCandidates && graph.bridgeCandidates.length > 0 && !bridgeProducer) {
    const plan = composePlan({ graph: { nodes: graph.nodes, edges: graph.edges }, targetSlug: target, reference, cacheRoot, area, flowSignal });
    const runnable = renderCurlBlock({ plan });
    const out = { plan, runnable, sources: plan.steps.map((s) => s.specUrl), staleness, bridgeCandidates: graph.bridgeCandidates };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  // Pass 2: promote the chosen producer to a real node + edge before composing.
  if (bridgeProducer && graph.bridgeCandidates) {
    const chosen = graph.bridgeCandidates.find((c) => c.slug === bridgeProducer);
    if (!chosen) die(2, { error: `scenario: bridgeProducer '${bridgeProducer}' is not among the surfaced candidates` });
    // Warm + load the chosen producer's node via a focused walk in its own reference,
    // then graft it: add its node (tagged reference) and the bridge edge. Derive the
    // threading field from the CHOSEN producer's reference (not the pre-labeled
    // cands[0] input) so a candidate set spanning references with different dominant
    // ids still labels the edge from the producer the caller actually picked.
    try {
      recordStaleness(await getReference({ referenceUrl: effectiveReferenceUrl.replace(/\/[^/]+\/?$/, `/${chosen.reference}`), cacheRoot, scrapeScript }));
    } catch (e) {
      if (e instanceof CacheAccessError) {
        die(3, { error: `scenario: scrape failed for bridge producer '${chosen.reference}': ${e.message}` });
      }
      throw e;
    }
    const producerGraph = walkTypes({ targetSlug: chosen.slug, reference: chosen.reference, cacheRoot, area });
    const producerNode = producerGraph.nodes.find((n) => n.slug === chosen.slug);
    graph.nodes.push(producerNode);
    // viaField is the producer reference's dominant path id -- null when that
    // family addresses nothing by id (the walker marked the target's from-bridge
    // input needsNaming). Keep the edge either way: it justifies the producer
    // step's inclusion (compose derives its evidence from the edge), so the user
    // still sees they must call it. A null viaField carries that honestly -- it
    // threads no field name, and compose/curl-block suppress the jq line rather
    // than emitting a bogus `NULL=$(... jq -r .null)`. This is the graceful
    // degrade needsNaming always intended.
    const viaField = dominantPathId(cacheRoot, chosen.reference, area);
    graph.edges.push({ from: chosen.slug, to: target, viaField });
  }

  const plan = composePlan({ graph, targetSlug: target, reference, cacheRoot, area, flowSignal });
  const runnable = renderCurlBlock({ plan });
  const sources = plan.steps.map((s) => s.specUrl);

  const out = { plan, runnable, sources, staleness };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((e) => die(1, { error: `scenario: unexpected: ${e.stack || e.message}` }));
