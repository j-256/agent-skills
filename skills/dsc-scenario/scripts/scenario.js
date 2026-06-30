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
const { walkTypes, producersOfType, bridgeThreadingField, collapseDuplicateProducerEdges, ReferenceNotScrapedError } = require('./walk-types.js');
const { composePlan } = require('./compose.js');
const { renderCurlBlock } = require('./curl-block.js');
const { applySubmittability } = require('./submittability.js');

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

  const { target, referenceUrl, cacheRoot, scrapeScript, graph: providedGraph, flowSignal, pinVersion, submittabilityRegistry } = input || {};
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

  // Defense-in-depth: a PROVIDED graph (sub-agent path or hand-authored) can carry
  // the same-field multi-producer shape that walkTypes itself no longer emits
  // (it surfaces those as candidates). Collapse duplicate (consumer, viaField)
  // edges so a provided graph can't compose the bogus call-every-producer plan.
  // walkTypes output is already clean, so this only matters for providedGraph;
  // scope it there to keep the local path's behavior provably unchanged.
  const planWarnings = [];
  if (providedGraph) {
    const collapsed = collapseDuplicateProducerEdges(graph, target);
    graph = collapsed.graph;
    planWarnings.push(...collapsed.warnings);
  }

  // The target's request-body named type (e.g. createOrder's body is Basket).
  // Used by the submittability registry to decide whether the producer step's
  // body must be populated beyond the FK-threading minimum. Null when the target
  // takes no named-type body, in which case the registry is a pure no-op.
  const targetBodyType = bodyRef ? bodyRef.split('/').pop() : null;

  // Single output path for every composed plan. Folds the curated submittability
  // registry in BEFORE rendering, so a registry-backed producer step's runnable
  // body is populated (not the empty `{}` the structural walk alone emits). The
  // advisory it returns is surfaced on the output, framed as curated + cited, so
  // the model renders it as a checkout business-rule, never as spec. Absent a
  // registry entry this is a pure no-op -- today's behavior exactly.
  function emitPlan(plan, extra = {}) {
    const advisory = applySubmittability({
      plan,
      bodyTypeName: targetBodyType,
      ...(submittabilityRegistry ? { registry: submittabilityRegistry } : {}),
    });
    const runnable = renderCurlBlock({ plan });
    const out = { plan, runnable, sources: plan.steps.map((s) => s.specUrl), staleness, ...extra };
    if (advisory) out.submittability = advisory;
    if (planWarnings.length) out.warnings = planWarnings;
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }

  // Pass 1: bridge candidates exist and the caller hasn't chosen -> return them,
  // do not compose the bridge step (the model picks, then re-invokes with bridgeProducer).
  if (graph.bridgeCandidates && graph.bridgeCandidates.length > 0 && !bridgeProducer) {
    const plan = composePlan({ graph: { nodes: graph.nodes, edges: graph.edges }, targetSlug: target, reference, cacheRoot, area, flowSignal });
    emitPlan(plan, { bridgeCandidates: graph.bridgeCandidates });
    return;
  }

  // Pass 2: promote the chosen producer to a real node + edge before composing.
  if (bridgeProducer && graph.bridgeCandidates) {
    const chosen = graph.bridgeCandidates.find((c) => c.slug === bridgeProducer);
    if (!chosen) die(2, { error: `scenario: bridgeProducer '${bridgeProducer}' is not among the surfaced candidates` });

    // In-reference pick (the chosen producer lives in the target's own reference):
    // no graft needed. Re-walk passing chosenProducer, which collapses the
    // multi-producer alternative set to that single producer's edge and recurses
    // its prerequisites normally. This is the in-reference twin of the
    // cross-reference graft below; the two are distinguished by whether the chosen
    // producer's reference matches the target's.
    if (chosen.reference === reference) {
      graph = walkTypes({ targetSlug: target, reference, cacheRoot, area, siblingRefs, chosenProducer: bridgeProducer });
      const plan = composePlan({ graph, targetSlug: target, reference, cacheRoot, area, flowSignal });
      emitPlan(plan);
      return;
    }
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
    // viaField is the producer reference's dominant path id, but only when it is
    // actually a property on the produced body type (bridgeThreadingField verifies
    // it -- the same produced-type check findProducers makes before drawing an
    // in-reference edge). It is null when that family addresses nothing by id OR
    // its dominant path id is absent from the produced type (a phantom field the
    // walker marked needsNaming). Keep the edge either way: it justifies the
    // producer step's inclusion (compose derives its evidence from the edge), so
    // the user still sees they must call it. A null viaField carries that honestly
    // -- it threads no field name, and compose/curl-block suppress the jq line
    // rather than emitting a bogus `NULL=$(... jq -r .null)` (or a `jq -r .<phantom>`
    // that silently extracts null). This is the graceful degrade needsNaming
    // always intended.
    const producedType = bodyRef.split('/').pop();
    const viaField = bridgeThreadingField(cacheRoot, chosen.reference, producedType, area);
    graph.edges.push({ from: chosen.slug, to: target, viaField });
  }

  const plan = composePlan({ graph, targetSlug: target, reference, cacheRoot, area, flowSignal });
  emitPlan(plan);
}

main().catch((e) => die(1, { error: `scenario: unexpected: ${e.stack || e.message}` }));
