'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../lib/scrape/resolve-cache.js');

class ReferenceNotScrapedError extends Error {
  constructor(reference, cacheRoot) {
    super(`Reference '${reference}' not found in cache at ${cacheRoot}; run dsc-scrape first.`);
    this.name = 'ReferenceNotScrapedError';
    this.reference = reference;
    this.cacheRoot = cacheRoot;
  }
}

function refDirFor(cacheRoot, reference, area) {
  try {
    return resolveReferenceDir(cacheRoot, reference, area ? { area } : {}).dir;
  } catch (e) {
    if (e instanceof ReferenceNotCachedError || e instanceof AmbiguousReferenceError) {
      throw new ReferenceNotScrapedError(reference, cacheRoot);
    }
    throw e;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// AMF/RAML-scraped specs emit object schemas as
// `{ type: 'object', properties: [{name, required, range}, ...] }`,
// whereas OAS uses `{ type: 'object', required: [...], properties: {name: schema} }`.
// Normalize AMF to OAS so the walker handles both. Same helper as
// skills/dsc-endpoint-help/scripts/diff.js:40 – keep in sync until a third
// consumer appears, then hoist to _shared/.
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.type !== 'object' || !Array.isArray(schema.properties)) return schema;
  const required = [];
  const properties = {};
  for (const p of schema.properties) {
    if (!p || typeof p.name !== 'string') continue;
    properties[p.name] = p.range || {};
    if (p.required) required.push(p.name);
  }
  return { ...schema, required, properties };
}

function listEndpointSlugs(cacheRoot, reference, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  let index;
  try {
    index = readJson(path.join(refDir, '_index.json'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new ReferenceNotScrapedError(reference, cacheRoot);
    }
    throw e;
  }
  return Object.keys(index.endpoints || {});
}

function loadEndpoint(cacheRoot, reference, slug, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  const p = path.join(refDir, `${slug}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

// The structural threading-field signal: the most-frequently-required path
// parameter across a reference, excluding the universal org/site params. A
// produced type's identity field (basketId, orderNo, customerId) is almost
// always the reference's dominant path id -- verified on the real cache
// (shopper-baskets-v2: basketId 35 uses vs 7x the runner-up). Returns null when
// the reference addresses nothing by id (then the bridge falls back to prose).
const UNIVERSAL_PATH_PARAMS = new Set(['organizationId', 'siteId']);
function dominantPathId(cacheRoot, reference, area) {
  const counts = new Map();
  for (const slug of listEndpointSlugs(cacheRoot, reference, area)) {
    const doc = loadEndpoint(cacheRoot, reference, slug, area);
    if (!doc) continue;
    for (const p of (doc.endpoint && doc.endpoint.parameters) || []) {
      if (p.in !== 'path' || !p.required) continue;
      if (UNIVERSAL_PATH_PARAMS.has(p.name)) continue;
      counts.set(p.name, (counts.get(p.name) || 0) + 1);
    }
  }
  let best = null;
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) { best = name; bestN = n; }
  }
  return best;
}

// Extract the required inputs of an endpoint as [{name, in, typeRef, typeName}].
// `in` is 'path' | 'query' | 'body'. typeRef is the $ref string if present,
// typeName is the named type (last segment of $ref) for convenience.
//
// The body schema arrives in one of two real shapes:
//   - `body.schemaRef` ("#/components/schemas/Basket") for a named type
//     (OAS/Swagger2). We resolve it to the type file to read its required
//     fields, so a named-type body still yields body-field edges. Resolving
//     needs cacheRoot/reference/area; when unavailable (or the type file is
//     missing), the body's required fields are simply not enumerated rather
//     than throwing -- the walk degrades, it doesn't crash.
//   - inline `body.schema` (OAS inline object, or AMF's array-properties form,
//     which normalizeSchema folds to OAS shape).
function requiredInputs(endpointDoc, { cacheRoot, reference, area } = {}) {
  const ep = endpointDoc.endpoint || {};
  const out = [];
  for (const p of ep.parameters || []) {
    if (!p.required) continue;
    // Param type lives on p.schema.type in the real cache; p.type is the older
    // shape some fixtures used. typeRef set if the param schema is a $ref.
    const ref = (p.schema && p.schema.$ref) || null;
    const typeName = ref ? ref.split('/').pop() : ((p.schema && p.schema.type) || p.type || null);
    out.push({ name: p.name, in: p.in, typeRef: ref, typeName });
  }

  let bodySchema = ep.body && ep.body.schema;
  if (!bodySchema && ep.body && typeof ep.body.schemaRef === 'string' && reference && cacheRoot) {
    const typeName = ep.body.schemaRef.split('/').pop();
    const typeDoc = loadType(cacheRoot, reference, typeName, area);
    bodySchema = typeDoc && typeDoc.type && typeDoc.type.schema;
  }
  const s = normalizeSchema(bodySchema);
  if (s && s.type === 'object' && Array.isArray(s.required)) {
    const props = s.properties || {};
    for (const req of s.required) {
      const prop = props[req] || {};
      const ref = prop.$ref || null;
      out.push({
        name: req,
        in: 'body',
        typeRef: ref,
        typeName: ref ? ref.split('/').pop() : (prop.type || null),
      });
    }
  }
  return out;
}

// Extract the types produced in any 2xx response schema.
// Returns [{name, ref}] for each top-level response schema ref, or
// {ref:null, name:null, inlineProperties:[...]} for an inline object schema.
//
// `responses` is the array the scrapers emit (parse-oas/parse-swagger2/parse-amf
// all `.push()` entries): each entry is `{code, schemaRef?, schema?, payloads?}`.
// Three response sub-shapes occur across the parser families:
//   - OAS-3 / Swagger-2 named: `{code, schemaRef: "#/components/schemas/Basket"}`
//   - OAS-3 / Swagger-2 inline: `{code, schema: {...}}`
//   - AMF-RAML: `{code, payloads: [{mediaType, schema: {...}}]}` (schema inline,
//     array-properties form; AMF emits no named-type files)
function producedTypes(endpointDoc) {
  const ep = endpointDoc.endpoint || {};
  const out = [];
  for (const resp of ep.responses || []) {
    if (!resp || !/^2\d\d$/.test(String(resp.code))) continue;
    // Named type: a `$ref` string in schemaRef (OAS/Swagger2). The ref's last
    // segment is the type name, which loadType() reads from types/<name>.json.
    if (typeof resp.schemaRef === 'string') {
      out.push({ ref: resp.schemaRef, name: resp.schemaRef.split('/').pop() });
      continue;
    }
    // Inline schema: OAS/Swagger2 carry it on resp.schema; AMF nests it under
    // resp.payloads[].schema. Take the first JSON payload's schema for AMF.
    const inline = resp.schema || (Array.isArray(resp.payloads) && resp.payloads[0] && resp.payloads[0].schema);
    if (!inline) continue;
    const s = normalizeSchema(inline);
    if (s && s.type === 'object' && s.properties) {
      out.push({ ref: null, name: null, inlineProperties: Object.keys(s.properties) });
    }
  }
  return out;
}

// Load a type file and return its {name, schema}, or null if absent.
function loadType(cacheRoot, reference, typeName, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  const p = path.join(refDir, 'types', `${typeName}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

// Does the named type's response schema carry a property `fieldName`? Loads the
// type file, normalizes AMF->OAS, and checks `fieldName in props`. False when the
// type file is absent or the property is missing. This is the single produced-type
// property check both findProducers (in-reference edges) and the cross-reference
// bridge use, so the two can't drift -- a divergence between them is exactly the
// asymmetry this consolidates.
function typeHasProperty(cacheRoot, reference, typeName, fieldName, area) {
  if (!fieldName) return false;
  const typeDoc = loadType(cacheRoot, reference, typeName, area);
  if (!typeDoc) return false;
  const typeSchema = normalizeSchema(typeDoc.type && typeDoc.type.schema);
  const props = (typeSchema && typeSchema.properties) || {};
  return fieldName in props;
}

// The cross-reference bridge's threading field: the producer reference's dominant
// path id, but only when that field is actually a property on the produced type.
// dominantPathId is a structural *guess* (the most-required path param across the
// producer's reference); it must be verified against the produced type's schema
// before it can be threaded -- the same `input.name in props` check findProducers
// makes before drawing an in-reference edge. Without it, a producer whose dominant
// path id names something absent from the produced type (e.g. a status
// sub-resource's token, not the resource's own id) threads a phantom field: the
// runnable emits `jq -r .<phantom>` and silently extracts null on a real run, the
// fabricated-looking artifact this family must never ship. Returns null when there
// is no dominant id OR it is not on the produced type; the caller marks the input
// needsNaming and the flow degrades to "supply the id from the producer response
// manually" (the same graceful path the null-dominant-id case already takes).
function bridgeThreadingField(cacheRoot, producerRef, producedType, area) {
  const field = dominantPathId(cacheRoot, producerRef, area);
  return typeHasProperty(cacheRoot, producerRef, producedType, field, area) ? field : null;
}

// For a given required-input {name, typeRef, typeName}, find producer operations
// in the reference whose response type, or inline response properties, produce it.
function findProducers(input, allEndpoints, cacheRoot, reference, area) {
  const producers = [];
  for (const ep of allEndpoints) {
    // Skip endpoints that require the same input we're trying to produce --
    // they can't produce what they already depend on (e.g. getItem requires
    // containerId, so its response doesn't count as a producer of containerId).
    const epInputs = requiredInputs(ep, { cacheRoot, reference, area });
    if (epInputs.some((i) => i.name === input.name)) continue;

    const produced = producedTypes(ep);
    for (const p of produced) {
      // Case A: response is a $ref to a named type. Check whether its schema has
      // a property matching the input name -- the same produced-type property
      // check the cross-reference bridge uses (typeHasProperty), so the two
      // can't drift.
      if (p.ref) {
        if (typeHasProperty(cacheRoot, reference, p.name, input.name, area)) {
          producers.push({ slug: ep.slug, viaField: input.name });
        }
      }
      // Case B: response has inline properties. Check directly.
      if (Array.isArray(p.inlineProperties) && p.inlineProperties.includes(input.name)) {
        producers.push({ slug: ep.slug, viaField: input.name });
      }
    }
  }
  return producers;
}

// Find every op across `refs` whose 2xx response produces `typeName` and which
// does NOT itself require that type's identity (the "from-nothing" producers).
// Returns candidates only -- selecting the canonical create among them is the
// model's judgment (the fewest-prereq tiebreaker is provably wrong: createBasket
// requires a body, merge/transfer don't, so fewest-prereq picks the wrong op).
function producersOfType(typeName, refs, cacheRoot, area) {
  const out = [];
  for (const ref of refs) {
    // A non-scraped reference contributes zero producers -- skip it, don't abort
    // the scan. The widen branch of the cross-reference bridge passes the whole
    // family as `refs`, which can include markdown concept pages (e.g.
    // `about-commerce-api`) the landing lists but the scraper writes no dir for.
    // refDirFor throws ReferenceNotScrapedError for those; tolerate it here, the
    // same way prewarmFamily tolerates a dir-less sibling during pre-warm.
    let idField;
    try {
      idField = dominantPathId(cacheRoot, ref, area);
    } catch (e) {
      if (e instanceof ReferenceNotScrapedError) continue;
      throw e;
    }
    for (const slug of listEndpointSlugs(cacheRoot, ref, area)) {
      const doc = loadEndpoint(cacheRoot, ref, slug, area);
      if (!doc) continue;
      const produces = producedTypes(doc).some((p) => p.name === typeName);
      if (!produces) continue;
      // From-nothing: skip ops that require the type's id as an input.
      const inputs = requiredInputs(doc, { cacheRoot, reference: ref, area });
      if (idField && inputs.some((i) => i.name === idField)) continue;
      const ep = doc.endpoint || {};
      out.push({ slug, reference: ref, operationId: ep.operationId || slug, method: ep.method, path: ep.path });
    }
  }
  return out;
}

function walkTypes({ targetSlug, reference, cacheRoot, area, siblingRefs = [], chosenProducer = null }) {
  const slugs = listEndpointSlugs(cacheRoot, reference, area);
  const allEndpoints = slugs
    .map((s) => loadEndpoint(cacheRoot, reference, s, area))
    .filter(Boolean);

  const nodes = new Map(); // slug -> node
  const edges = [];
  // Candidates the model must choose among (pick the canonical create). Populated
  // by two sources that never both fire for one target in practice: the
  // in-reference multi-producer choice point in visit() below, and the
  // cross-reference body-type bridge after the walk. Declared here so visit() can
  // push to it. Each entry: {slug, reference, operationId, method, path, viaField?}.
  const bridgeCandidates = [];

  function visit(slug) {
    if (nodes.has(slug)) return;
    const doc = allEndpoints.find((e) => e.slug === slug);
    if (!doc) return;
    const ep = doc.endpoint || {};
    const inputs = requiredInputs(doc, { cacheRoot, reference, area });
    const produced = producedTypes(doc);
    nodes.set(slug, {
      slug,
      reference,
      method: ep.method,
      path: ep.path,
      producedTypes: produced.map(({ name, ref }) => ({ name, ref })),
      requiredInputs: inputs,
    });
    for (const inp of inputs) {
      // Match the prompt's "whose type is an ID or a reference to a named type"
      // filter – otherwise a shared named type (e.g. both getItem and addItem return
      // Item) would make every endpoint a "producer" of every property on that type.
      const isId = /Id$/i.test(inp.name);
      const isNamedTypeRef = inp.typeRef !== null;
      if (!isId && !isNamedTypeRef) continue;

      // findProducers already skips any op that itself requires inp.name, so every
      // producer it returns yields inp.name from-nothing. Dedupe by slug (one op
      // can match via two produced types) so the alternative count is by operation.
      const producers = [];
      for (const p of findProducers(inp, allEndpoints, cacheRoot, reference, area)) {
        if (p.slug === slug) continue; // no self-edges
        if (!producers.some((q) => q.slug === p.slug)) producers.push(p);
      }

      // Multiple from-nothing producers of one field are ALTERNATIVES, not an
      // AND-chain: e.g. basketId is produced from-nothing by createBasket,
      // mergeBasket and transferBasket alike, but only the canonical create
      // belongs in the plan (merge/transfer presuppose an existing basket).
      // Picking among them is the model's judgment -- the fewest-prereq tiebreaker
      // is provably wrong (createBasket requires a body, merge/transfer don't). So
      // when >1 producer exists, surface them as candidates the model picks among
      // (the same mechanism the cross-reference body-type bridge uses) rather than
      // chaining every one as a mandatory step. Pass 2 supplies chosenProducer,
      // which collapses the set to that single edge.
      if (producers.length > 1 && !chosenProducer) {
        for (const p of producers) {
          if (bridgeCandidates.some((c) => c.slug === p.slug)) continue;
          const pdoc = allEndpoints.find((e) => e.slug === p.slug);
          const pep = (pdoc && pdoc.endpoint) || {};
          bridgeCandidates.push({
            slug: p.slug, reference,
            operationId: pep.operationId || p.slug,
            method: pep.method, path: pep.path,
            viaField: p.viaField,
          });
        }
        continue; // do not chain the alternatives; the model picks one in pass 2
      }

      // Single producer (or the model already chose): chain. When the model has
      // chosen among a multi set, keep only the chosen producer's edge.
      const chained = (producers.length > 1 && chosenProducer)
        ? producers.filter((p) => p.slug === chosenProducer)
        : producers;
      for (const p of chained) {
        edges.push({ from: p.slug, to: slug, viaField: p.viaField });
        visit(p.slug);
      }
    }
  }

  visit(targetSlug);

  // Body-type bridge: if the target's body is a named type with no in-reference
  // producer, surface from-nothing producers in the warmed sibling references as
  // candidates (the model selects the canonical create). Label the threaded field
  // structurally from the producer reference's dominant path id; mark needsNaming
  // when there is none (the model then reads it from the description prose).
  // bridgeCandidates is declared at the top of walkTypes (the in-reference
  // multi-producer choice point may already have populated it); a given target
  // hits at most one of the two sources in practice.
  const targetDoc = allEndpoints.find((e) => e.slug === targetSlug);
  const bodyRef = targetDoc && targetDoc.endpoint && targetDoc.endpoint.body && targetDoc.endpoint.body.schemaRef;
  if (bodyRef && Array.isArray(siblingRefs) && siblingRefs.length > 0) {
    const typeName = bodyRef.split('/').pop();
    const producedInRef = allEndpoints.some((e) => producedTypes(e).some((p) => p.name === typeName));
    if (!producedInRef) {
      const cands = producersOfType(typeName, siblingRefs, cacheRoot, area);
      for (const c of cands) bridgeCandidates.push(c);
      if (cands.length > 0) {
        const producerRef = cands[0].reference;
        const fieldName = bridgeThreadingField(cacheRoot, producerRef, typeName, area);
        const targetNode = nodes.get(targetSlug);
        if (targetNode) {
          targetNode.requiredInputs.push({
            name: fieldName, in: 'body', typeRef: bodyRef, typeName,
            fromBridge: true, needsNaming: fieldName === null,
          });
        }
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    bridgeCandidates,
  };
}

// NOTE: walk-via-agent.md restates the same algorithm as walkTypes() above.
// If you change the walkTypes algorithm here, update walk-via-agent.md to
// match – both are the contract for sub-agent vs. local execution.
function walkViaAgentPrompt({ targetSlug, reference, cacheRoot }) {
  if (typeof targetSlug !== 'string' || !targetSlug) {
    throw new Error('walkViaAgentPrompt: targetSlug is required');
  }
  if (typeof reference !== 'string' || !reference) {
    throw new Error('walkViaAgentPrompt: reference is required');
  }
  if (typeof cacheRoot !== 'string' || !cacheRoot) {
    throw new Error('walkViaAgentPrompt: cacheRoot is required');
  }
  const promptPath = path.join(__dirname, 'walk-via-agent.md');
  const template = fs.readFileSync(promptPath, 'utf8');
  return template
    .replace(/\{\{TARGET_SLUG\}\}/g, targetSlug)
    .replace(/\{\{REFERENCE\}\}/g, reference)
    .replace(/\{\{CACHE_ROOT\}\}/g, cacheRoot);
}

// Defense-in-depth guard for graphs scenario.js did NOT build itself (a provided
// `graph` from the sub-agent path or a hand-authored one). walkTypes already
// surfaces multiple from-nothing producers of one field as candidates rather than
// chaining them, but a provided graph can still carry the pathological shape:
// >1 edge into the same consumer via the same viaField (e.g. createBasket,
// transferBasket and mergeBasket all threading basketId into addItemToBasket).
// Composing that yields a plan that tells the user to call every basket producer
// as a mandatory prerequisite -- the exact wrong output the choice-point fix
// prevents on the local path. Collapse each (consumer, viaField) group to a
// single edge (first wins, deterministically) and return a warning per collapsed
// group so the arbitrary pick is never silent. A normal fan-in (distinct fields,
// or one producer per field) passes through untouched.
//
// Collapsing an edge can orphan the producer node it pointed from (e.g. dropping
// the mergeBasket->target edge leaves mergeBasket in nodes[] with no link).
// composePlan rejects non-target nodes that have no linking edge, so prune any
// node left unreferenced by a surviving edge (the target is always kept).
function collapseDuplicateProducerEdges(graph, targetSlug) {
  const warnings = [];
  if (!graph || !Array.isArray(graph.edges)) return { graph, warnings };
  const seen = new Map(); // `${to}|${viaField}` -> first `from` kept
  const groups = new Map(); // same key -> [all froms], for warning detail
  const kept = [];
  for (const e of graph.edges) {
    const key = `${e.to}|${e.viaField}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.from);
    if (seen.has(key)) continue; // a later producer of the same field into the same consumer
    seen.set(key, e.from);
    kept.push(e);
  }
  for (const [key, froms] of groups) {
    if (froms.length > 1) {
      const [to, viaField] = key.split('|');
      const chosen = seen.get(key);
      warnings.push(
        `multiple producers of '${viaField}' into '${to}' (${froms.join(', ')}); ` +
        `kept '${chosen}', dropped the rest -- these are alternatives, not a chain. ` +
        `If '${chosen}' is not the canonical create, re-invoke with the intended producer.`,
      );
    }
  }
  // Nothing collapsed -> return the graph untouched (no node pruning needed).
  if (!warnings.length) return { graph: { ...graph, edges: kept }, warnings };
  // Prune nodes orphaned by the dropped edges: keep a node if a surviving edge
  // still references it, or it is the target.
  const linked = new Set();
  for (const e of kept) { linked.add(e.from); linked.add(e.to); }
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes.filter((n) => n.slug === targetSlug || linked.has(n.slug))
    : graph.nodes;
  return { graph: { ...graph, nodes, edges: kept }, warnings };
}

module.exports = { walkTypes, walkViaAgentPrompt, dominantPathId, bridgeThreadingField, typeHasProperty, producersOfType, collapseDuplicateProducerEdges, ReferenceNotScrapedError };
