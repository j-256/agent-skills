'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { citeEnvelope } = require('../lib/cite.js');
const { resolveReferenceDir } = require('../lib/scrape/resolve-cache.js');
const { narrowOperationScopes, combinePlanScopes } = require('../lib/dedupe-scopes.js');
const { pickShopperFlow, pickAmFlow } = require('../lib/slas-flows.js');
const { resolveAuthProvider, applyCuratedNotes } = require('../lib/auth-providers.js');
const { B2C_AUTH_PROVIDERS } = require('../lib/b2c-auth-providers.js');
const { B2C_CURATED_FACTS } = require('../lib/b2c-curated-facts.js');

// Resolve the auth for one operation from its own reference's spec security +
// identity (area / reference / method / path). This is the family-aware router:
// SCAPI ops key off their scheme, OCAPI ops off their reference family. Returns
// the resolved provider object or null (SCAPI-unknown / non-Commerce).
function resolveStepAuth({ cacheRoot, reference, slug, area }) {
  let doc;
  try {
    doc = loadEndpoint(cacheRoot, reference, slug, area);
  } catch {
    return null;
  }
  const security = (doc.endpoint && doc.endpoint.security) || [];
  const ep = doc.endpoint || {};
  return resolveAuthProvider({
    context: { area, reference, method: ep.method, path: ep.path, security },
    providers: B2C_AUTH_PROVIDERS,
  });
}

// The bearer-only default for a step no provider claims (SCAPI ops on the
// 'unknown' branch, or references outside the Commerce providers). Preserves the
// pre-iteration request shape: a bearer, no client_id query param.
const DEFAULT_REQUEST_AUTH = Object.freeze({ query: {}, bearer: true });

function loadEndpoint(cacheRoot, reference, slug, area) {
  const { dir } = resolveReferenceDir(cacheRoot, reference, area ? { area } : {});
  return JSON.parse(fs.readFileSync(path.join(dir, `${slug}.json`), 'utf8'));
}

function readBasePath(cacheRoot, reference, area) {
  try {
    const { dir } = resolveReferenceDir(cacheRoot, reference, area ? { area } : {});
    const idx = JSON.parse(fs.readFileSync(path.join(dir, '_index.json'), 'utf8'));
    return typeof idx.basePath === 'string' ? idx.basePath : '';
  } catch {
    return '';
  }
}

// Topological sort: Kahn's algorithm.
// Edges are {from, to} – from must come before to.
function topoSort(nodeSlugs, edges) {
  const incoming = new Map(nodeSlugs.map((s) => [s, 0]));
  const adj = new Map(nodeSlugs.map((s) => [s, []]));
  for (const e of edges) {
    if (!incoming.has(e.to) || !adj.has(e.from)) continue;
    incoming.set(e.to, incoming.get(e.to) + 1);
    adj.get(e.from).push(e.to);
  }
  const queue = [];
  for (const [s, n] of incoming.entries()) if (n === 0) queue.push(s);
  const order = [];
  while (queue.length) {
    const s = queue.shift();
    order.push(s);
    for (const next of adj.get(s)) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  const orderSet = new Set(order);
  const leftover = nodeSlugs.filter((s) => !orderSet.has(s));
  if (leftover.length) {
    throw new Error(`topoSort: cycle detected; remaining nodes: ${leftover.join(', ')}`);
  }
  return order;
}

// Compute the deduped, least-privilege scope set for the plan.
// Step 1: per-operation narrowing (drop .rw when bare also listed; drop meta-scope
//         when a specific expansion member is co-listed).
// Step 2: combinePlanScopes (cross-op dedup; drop bare when .rw is independently
//         in the union; flag whether sfcc.shopper-standard could replace the set).
function computeScopes(nodes, cacheRoot, reference, area) {
  const perOp = nodes.map((node) => {
    const doc = loadEndpoint(cacheRoot, node.reference || reference, node.slug, area);
    const opScopes = [];
    for (const sec of (doc.endpoint && doc.endpoint.security) || []) {
      for (const sc of sec.scopes || []) opScopes.push(sc);
    }
    return narrowOperationScopes(opScopes);
  });
  return combinePlanScopes(perOp);
}

function composePlan({ graph, targetSlug, reference, cacheRoot, area, flowSignal }) {
  const slugs = graph.nodes.map((n) => n.slug);
  // Filter out edges that reference unknown slugs before any consumer sees
  // them. The sub-agent walker (walk-via-agent.md) is an informal contract –
  // defending against a malformed graph keeps compose.js resilient.
  const validSlugs = new Set(slugs);
  const edges = graph.edges.filter((e) => validSlugs.has(e.from) && validSlugs.has(e.to));
  const order = topoSort(slugs, edges);

  // Ensure the target ends up last. If the topological order doesn't put it
  // at the end (can happen if the target has no outgoing edges among the
  // picked set, which it shouldn't – defensive), move it.
  const idx = order.indexOf(targetSlug);
  if (idx !== -1 && idx !== order.length - 1) {
    order.splice(idx, 1);
    order.push(targetSlug);
  }

  // Incoming edges: keyed by consumer slug. Used both for the target step's
  // evidence (prerequisites structurally cover the target) and for the
  // idPassing map (each consumer records which field comes from which producer).
  const edgesIn = new Map(); // to -> [{from, viaField}]
  for (const e of edges) {
    if (!edgesIn.has(e.to)) edgesIn.set(e.to, []);
    edgesIn.get(e.to).push({ from: e.from, viaField: e.viaField });
  }
  // Outgoing edges: keyed by producer slug. Used for non-target steps'
  // evidence – a step is in the plan because some downstream step needs a
  // field from its response.
  const edgesOut = new Map(); // from -> [{to, viaField}]
  for (const e of edges) {
    if (!edgesOut.has(e.from)) edgesOut.set(e.from, []);
    edgesOut.get(e.from).push({ to: e.to, viaField: e.viaField });
  }

  // The target must be a sink (no outgoing edges). walkTypes only pulls in
  // producers of the target, so this should never fire – but catch it here
  // rather than silently producing a plan where the target is not last.
  if (edgesOut.has(targetSlug) && edgesOut.get(targetSlug).length > 0) {
    const outgoing = edgesOut.get(targetSlug).map((e) => `${e.viaField}→${e.to}`).join(', ');
    throw new Error(`composePlan: target '${targetSlug}' has outgoing edges (${outgoing}) – not a valid sink. walkTypes should only return sink targets.`);
  }

  const steps = order.map((slug) => {
    const node = graph.nodes.find((n) => n.slug === slug);
    const nodeRef = (node && node.reference) || reference;
    const doc = loadEndpoint(cacheRoot, nodeRef, slug, area);
    const specUrl = citeEnvelope(doc);
    // Evidence answers "why is this step in the plan?". For the target, the
    // prerequisites (incoming edges) cover it. For non-target steps, the
    // justification is that a downstream consumer needs a field from this
    // step's response (outgoing edge).
    let evidence;
    if (slug === targetSlug) {
      const incoming = edgesIn.get(slug) || [];
      evidence = incoming.map((e) => ({
        kind: 'structural',
        viaField: e.viaField,
        producer: e.from,
      }));
    } else {
      const outgoing = edgesOut.get(slug) || [];
      evidence = outgoing.map((e) => ({
        kind: 'structural',
        viaField: e.viaField,
        consumer: e.to,
      }));
    }
    // Target always has at least one trivial evidence entry pointing to itself
    // as "this is the thing we're building toward" – but only if no structural
    // edges already cover it.
    if (evidence.length === 0 && slug === targetSlug) {
      evidence.push({ kind: 'target', description: 'Target operation; no prerequisites found.' });
    }
    // A non-target step with no structural evidence has no reason to be in
    // the plan – likely a walker bug or a malformed graph.
    if (evidence.length === 0 && slug !== targetSlug) {
      throw new Error(`composePlan: step '${slug}' has no structural edges linking it to the plan – likely a walker bug.`);
    }
    // Per-step request-auth shape (what the runnable emits on THIS call):
    // OCAPI steps carry a client_id query param (the floor) + a bearer per tier;
    // SCAPI steps carry a bearer only. Resolved from the step's own reference so
    // a multi-reference plan whose steps span families (all OCAPI here, but the
    // mechanism is general) renders each call with its own family's shape.
    const stepAuth = resolveStepAuth({ cacheRoot, reference: nodeRef, slug, area });
    const requestAuth = stepAuth ? stepAuth.requestAuth : DEFAULT_REQUEST_AUTH;
    return {
      slug,
      reference: nodeRef,
      area,
      basePath: readBasePath(cacheRoot, nodeRef, area),
      method: node.method,
      path: node.path,
      specUrl,
      produces: node.producedTypes,
      requiredInputs: node.requiredInputs,
      requestAuth,
      evidence,
    };
  });

  // idPassing records which field each consumer threads from which producer.
  // An edge with a null viaField (the bridge producer's family has no dominant
  // path id; the walker marked the input needsNaming) carries no threadable
  // field name, so drop those inputs -- the renderer must never receive a
  // {field: null} input (it would emit a bogus `NULL=$(... jq -r .null)`). The
  // producer step still appears in the plan; its inclusion is justified by the
  // edge's evidence, and the model names the id from the producer's response.
  const idPassing = [];
  for (const [to, inputs] of edgesIn.entries()) {
    const named = inputs.filter((i) => i.viaField).map((i) => ({ field: i.viaField, from: i.from }));
    if (named.length === 0) continue;
    idPassing.push({ consumer: to, inputs: named });
  }

  // Determine auth branch from the target's identity (family-aware). The
  // provider registry routes SCAPI by scheme and OCAPI by reference family;
  // authBranch is its resolved branch id, or 'unknown' when nothing matches
  // (non-Commerce schemes -- the plan still composes, just no auth-step block).
  const targetDoc = loadEndpoint(cacheRoot, reference, targetSlug, area);
  const targetEp = targetDoc.endpoint || {};
  const auth = resolveAuthProvider({
    context: {
      area, reference, method: targetEp.method, path: targetEp.path,
      security: targetEp.security || [],
    },
    providers: B2C_AUTH_PROVIDERS,
  });
  // Curated NOTE facts for the target: curated overrides that self-invalidate
  // when the spec field they patch drifts. Reuses the targetDoc already loaded
  // above -- no extra fetch. Product-neutral verifier + B2C curated-fact data;
  // applyCuratedNotes filters the shared registry to attach:'note' facts.
  const curatedNotes = applyCuratedNotes({
    context: { area, reference, method: targetEp.method, path: targetEp.path, security: targetEp.security || [] },
    facts: B2C_CURATED_FACTS,
    opDoc: targetDoc, cacheRoot, area, reference,
  });
  const authBranch = auth ? auth.branch : 'unknown';
  // authFlow is the SLAS/AM flow-data the renderer uses for the SCAPI branches
  // (selected by the user's flowSignal). OCAPI branches carry their token flow
  // on `auth.token` instead, so authFlow stays null there.
  let authFlow = null;
  if (authBranch === 'shopper-slas') authFlow = pickShopperFlow(flowSignal);
  else if (authBranch === 'am') authFlow = pickAmFlow(flowSignal);

  const { deduped, asMetaScope } = computeScopes(graph.nodes, cacheRoot, reference, area);

  // Fold curated notes into the single prerequisites array the renderer reads.
  // auth may be null (branch 'unknown'); still surface notes if any matched.
  const authOut = auth
    ? { ...auth, prerequisites: [ ...(auth.prerequisites || []), ...curatedNotes ] }
    : (curatedNotes.length ? { branch: 'unknown', tier: null, requestAuth: { query: {}, bearer: true }, token: null, prerequisites: curatedNotes } : null);

  return {
    reference,
    area,
    targetSlug,
    steps,
    combinedScopes: deduped,
    metaScopeSuggested: asMetaScope,
    authBranch,
    authFlow,
    auth: authOut,
    idPassing,
  };
}

module.exports = { composePlan };
