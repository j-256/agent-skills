'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { walkTypes, ReferenceNotScrapedError, collapseDuplicateProducerEdges } = require('../scripts/walk-types.js');

const CACHE = path.join(__dirname, 'fixtures');
const REF = 'tiny-ref';

// Target: getItem, which needs a containerId and an itemId.
// Expected producers:
//   containerId -> createContainer (response.Container.containerId)
//   itemId      -> addItem          (response.Item.itemId)
//   addItem itself needs a containerId too -> createContainer again
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });

  const nodeSlugs = graph.nodes.map((n) => n.slug).sort();
  assert.deepEqual(nodeSlugs, ['addItem', 'createContainer', 'getItem']);

  // Check that getItem has the two required inputs recorded.
  const getItem = graph.nodes.find((n) => n.slug === 'getItem');
  assert.ok(getItem);
  assert.equal(getItem.method, 'GET');
  const reqNames = getItem.requiredInputs.map((i) => i.name).sort();
  assert.deepEqual(reqNames, ['containerId', 'itemId']);

  // Check that createContainer produces Container type (which has containerId).
  const createC = graph.nodes.find((n) => n.slug === 'createContainer');
  assert.ok(createC.producedTypes.some((t) => t.name === 'Container' || t.ref === '#/types/Container'));

  // Edges: getItem <- createContainer via containerId, getItem <- addItem via itemId,
  //        addItem <- createContainer via containerId.
  const hasEdge = (from, to, via) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.viaField === via);
  assert.ok(hasEdge('createContainer', 'getItem', 'containerId'));
  assert.ok(hasEdge('addItem', 'getItem', 'itemId'));
  assert.ok(hasEdge('createContainer', 'addItem', 'containerId'));
}

// Target: addItem (one hop from the auth boundary)
{
  const graph = walkTypes({ targetSlug: 'addItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const nodeSlugs = graph.nodes.map((n) => n.slug).sort();
  assert.deepEqual(nodeSlugs, ['addItem', 'createContainer']);
}

// Target with no required inputs: just itself
{
  const graph = walkTypes({ targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  assert.deepEqual(graph.nodes.map((n) => n.slug), ['createContainer']);
  assert.deepEqual(graph.edges, []);
}

// Input with no producer: recorded as unresolved, not hallucinated
{
  const graph = walkTypes({ targetSlug: 'addItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const addItem = graph.nodes.find((n) => n.slug === 'addItem');
  const unresolved = addItem.requiredInputs.filter((i) => i.name === 'itemName');
  assert.equal(unresolved.length, 1);
  // itemName is a body field with no producer – walkTypes shouldn't invent one.
  const invented = graph.edges.filter((e) => e.viaField === 'itemName');
  assert.deepEqual(invented, []);
}

// AMF schema shape: `properties: [{name, required, range}, ...]` must be
// normalized to OAS shape so the walker finds producers correctly.
{
  const graph = walkTypes({ targetSlug: 'useWidget', reference: 'amf-ref', cacheRoot: CACHE, area: 'amf-area' });
  const nodeSlugs = graph.nodes.map((n) => n.slug).sort();
  assert.deepEqual(nodeSlugs, ['createWidget', 'useWidget']);

  // createWidget produces Widget (AMF-shaped) with a widgetId property,
  // so an edge from createWidget -> useWidget via widgetId must exist.
  const hasEdge = (from, to, via) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.viaField === via);
  assert.ok(hasEdge('createWidget', 'useWidget', 'widgetId'));
}

// Missing reference cache: typed error, not a bare ENOENT.
{
  assert.throws(
    () => walkTypes({ targetSlug: 'x', reference: 'nonexistent', cacheRoot: CACHE, area: 'tiny-area' }),
    (e) => e instanceof ReferenceNotScrapedError && e.reference === 'nonexistent',
  );
}

// Body declared as a named-type $ref (`body.schemaRef`, not inline `body.schema`)
// must be resolved to its type file so its required fields still produce edges.
// linkItems' body is a $ref to ItemLink, whose required `itemId` is produced by
// addItem's Item response. The edge only forms if requiredInputs() resolves the
// schemaRef body against types/ItemLink.json.
{
  const graph = walkTypes({ targetSlug: 'linkItems', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const linkItems = graph.nodes.find((n) => n.slug === 'linkItems');
  assert.ok(linkItems, 'linkItems node present');
  const itemIdInput = linkItems.requiredInputs.find((i) => i.name === 'itemId' && i.in === 'body');
  assert.ok(itemIdInput, 'schemaRef body resolved: itemId surfaced as a required body input');
  const hasEdge = (from, to, via) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.viaField === via);
  assert.ok(hasEdge('addItem', 'linkItems', 'itemId'),
    'addItem produces itemId (via Item) -> linkItems edge requires schemaRef-body resolution');
}

// producedTypes in stored nodes: only {name, ref}, no inlineProperties leak.
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  for (const node of graph.nodes) {
    for (const pt of node.producedTypes) {
      assert.deepEqual(Object.keys(pt).sort(), ['name', 'ref']);
    }
  }
}

// Every node carries the reference its spec lives in (consumed by multi-reference compose).
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  for (const node of graph.nodes) {
    assert.equal(node.reference, REF, `node ${node.slug} must carry its reference`);
  }
}

// dominantPathId: the most-used required path param in a reference (the structural
// threading-field signal). tiny-ref uses containerId twice, itemId once.
{
  const { dominantPathId } = require('../scripts/walk-types.js');
  assert.equal(dominantPathId(CACHE, REF, 'tiny-area'), 'containerId');
}

// producersOfType: finds from-nothing producers of a type across references,
// filtering out ops that require the type's id (updateWidget needs widgetId).
{
  const { producersOfType } = require('../scripts/walk-types.js');
  const found = producersOfType('Widget', ['refB'], CACHE, 'bridge-area');
  const slugs = found.map((f) => f.slug).sort();
  assert.deepEqual(slugs, ['createWidget'], 'only the from-nothing producer, not updateWidget');
  assert.equal(found[0].reference, 'refB');
  assert.equal(found[0].operationId, 'createWidget');
}

// producersOfType tolerates a dir-less sibling in the scan set. The widen
// branch of the cross-reference bridge passes the WHOLE family as `refs`, which
// includes markdown concept pages (e.g. `about-commerce-api`) that the scraper
// lists in the landing but never writes a ref dir for. A non-scraped reference
// contributes zero producers; it must be skipped, not abort the whole scan with
// ReferenceNotScrapedError. Regression for the addPaymentInstrumentToBasket
// crash (the second site of the dir-less-sibling bug; the first was
// prewarmFamily in shared/scrape/cache-access.js).
{
  const { producersOfType } = require('../scripts/walk-types.js');
  const found = producersOfType('Widget', ['about-bridge-area', 'refB'], CACHE, 'bridge-area');
  const slugs = found.map((f) => f.slug).sort();
  assert.deepEqual(slugs, ['createWidget'],
    'dir-less concept-page sibling skipped; the real producer in refB still found');
  assert.equal(found[0].reference, 'refB');
}

// In-reference multi-producer choice point. When a single required field has
// MORE THAN ONE from-nothing producer in the SAME reference, those producers are
// alternatives (pick the canonical create), not an AND-chain of mandatory steps.
// addItemToCart needs cartId, produced from-nothing by BOTH createCart (the bare
// collection POST) and mergeCart (a /actions/merge POST that the structural
// from-nothing filter can't exclude -- it takes no cartId input). The walk must
// NOT chain both as steps; it surfaces them as candidates the model picks among,
// exactly like the cross-reference bridge. Regression for the
// addPaymentInstrumentToBasket plan that listed createBasket -> transferBasket ->
// mergeBasket as three mandatory prerequisites.
{
  const graph = walkTypes({ targetSlug: 'addItemToCart', reference: 'multi-ref', cacheRoot: CACHE, area: 'multi-area' });

  // The alternatives must NOT both be chained as mandatory plan steps.
  const nodeSlugs = graph.nodes.map((n) => n.slug).sort();
  assert.ok(!nodeSlugs.includes('mergeCart'),
    'mergeCart (an /actions/ producer) must not be chained as a mandatory step');

  // They surface as candidates for the model to choose the canonical create.
  assert.ok(Array.isArray(graph.bridgeCandidates), 'graph carries a candidate list');
  const candSlugs = graph.bridgeCandidates.map((c) => c.slug).sort();
  assert.deepEqual(candSlugs, ['createCart', 'mergeCart'],
    'both from-nothing producers surface as alternatives the model picks among');
  for (const c of graph.bridgeCandidates) {
    assert.equal(c.reference, 'multi-ref', 'in-reference candidate tagged with its own reference');
  }

  // No duplicate edges chaining every producer into the target.
  const cartIdEdges = graph.edges.filter((e) => e.to === 'addItemToCart' && e.viaField === 'cartId');
  assert.ok(cartIdEdges.length <= 1,
    'at most one cartId edge into the target before the model picks (no all-producers AND-chain)');
}

// Body-type bridge: submitWidget's body is Widget, produced by refB.createWidget
// (from nothing). With refB supplied as a sibling, the walk surfaces createWidget
// as a bridge candidate and labels the threading field structurally (widgetId).
{
  const graph = walkTypes({
    targetSlug: 'submitWidget', reference: 'refA', cacheRoot: CACHE, area: 'bridge-area',
    siblingRefs: ['refB'],
  });
  assert.ok(Array.isArray(graph.bridgeCandidates), 'graph carries bridgeCandidates');
  const cand = graph.bridgeCandidates.find((c) => c.slug === 'createWidget');
  assert.ok(cand, 'createWidget surfaced as a bridge candidate');
  assert.equal(cand.reference, 'refB', 'candidate tagged with its reference');
  assert.ok(!graph.bridgeCandidates.some((c) => c.slug === 'updateWidget'), 'updateWidget filtered (needs widgetId)');
  // Structural threading field: Widget's producing ref (refB) dominant path id is widgetId.
  const target = graph.nodes.find((n) => n.slug === 'submitWidget');
  const bridged = target.requiredInputs.find((i) => i.fromBridge);
  assert.ok(bridged, 'target has a from-bridge body input');
  assert.equal(bridged.name, 'widgetId', 'threading field labeled structurally');
  assert.equal(bridged.needsNaming, false, 'dominant path id found -> no prose fallback needed');
}

// Body-type bridge, PHANTOM threading field. refE produces the Gizmo body type
// from nothing via createGizmo, and refE HAS a dominant path id (gizmoToken, off
// getGizmoStatus) -- but gizmoToken is NOT a property on the produced Gizmo type
// ({gizmoId, label}). dominantPathId is a structural guess at the threading field;
// it must be verified against the produced type's schema, exactly as findProducers
// checks `input.name in props` before drawing an edge. An unverified field would
// thread into the runnable as `jq -r .gizmoToken`, silently yielding null on a
// paste-and-run script -- the fabricated-looking artifact this family must avoid.
// So the walk must degrade to needsNaming rather than label the phantom field.
{
  const graph = walkTypes({
    targetSlug: 'submitGizmo', reference: 'refA', cacheRoot: CACHE, area: 'bridge-area',
    siblingRefs: ['refE'],
  });
  // The producer must still surface as a candidate -- the user has to call it;
  // only the (phantom) threading field is dropped, not the bridge itself.
  const cand = graph.bridgeCandidates.find((c) => c.slug === 'createGizmo');
  assert.ok(cand, 'createGizmo still surfaced as a bridge candidate');
  assert.equal(cand.reference, 'refE', 'candidate tagged with its reference');
  const target = graph.nodes.find((n) => n.slug === 'submitGizmo');
  const bridged = target.requiredInputs.find((i) => i.fromBridge);
  assert.ok(bridged, 'target has a from-bridge body input');
  assert.equal(bridged.needsNaming, true,
    'dominant path id (gizmoToken) absent from the produced Gizmo type -> degrade to needsNaming');
  assert.equal(bridged.name, null, 'no phantom threading field labeled when it is not on the produced type');
}

// OCAPI Swagger-2 success responses live under the `default` response code, not
// a 2xx code (verified on the real cache: post-baskets/post-orders declare
// 400/404 -> fault and default -> the success type). producedTypes() must accept
// `default` as a success response, or every OCAPI producer is invisible and the
// cross-reference bridge (post-baskets -> post-orders) returns nothing. SCAPI is
// unaffected: its ops carry an explicit 2xx (200/201) and no `default`, so the
// broadened filter is a no-op there (guarded by the SCAPI-shaped tiny-ref tests
// above, which never regress). This is the root cause behind bridgeCandidates:[]
// on the OCAPI submit-basket scenario.
{
  const OCAPI_CACHE = path.join(__dirname, 'fixtures');
  const AREA = 'commerce_b2c-commerce';
  const { producersOfType } = require('../scripts/walk-types.js');

  // post-baskets produces `basket` under a `default` response -> must be found.
  const found = producersOfType('basket', ['ocapi-shop-baskets'], OCAPI_CACHE, AREA);
  const slugs = found.map((f) => f.slug).sort();
  assert.deepEqual(slugs, ['post-baskets'],
    `OCAPI default-response producer must be found; get-baskets-basket_id (needs basket_id) filtered. got ${JSON.stringify(slugs)}`);
  assert.equal(found[0].reference, 'ocapi-shop-baskets');
  assert.equal(found[0].operationId, 'Create basket');

  // The full cross-reference bridge: post-orders' body is `basket`, produced by
  // ocapi-shop-baskets.post-baskets. With the sibling supplied, post-baskets must
  // surface as a bridge candidate and the threading field label as basket_id.
  const graph = walkTypes({
    targetSlug: 'post-orders', reference: 'ocapi-shop-orders', cacheRoot: OCAPI_CACHE, area: AREA,
    siblingRefs: ['ocapi-shop-baskets'],
  });
  const cand = graph.bridgeCandidates.find((c) => c.slug === 'post-baskets');
  assert.ok(cand, `post-baskets must surface as an OCAPI bridge candidate; got ${JSON.stringify(graph.bridgeCandidates)}`);
  assert.equal(cand.reference, 'ocapi-shop-baskets', 'candidate tagged with its reference');
  const target = graph.nodes.find((n) => n.slug === 'post-orders');
  assert.ok(target, 'post-orders node present');
  // The target must also record its produced type now (order, under default).
  assert.ok(target.producedTypes.some((t) => t.name === 'order'),
    `post-orders must record its default-response produced type (order); got ${JSON.stringify(target.producedTypes)}`);
  const bridged = target.requiredInputs.find((i) => i.fromBridge);
  assert.ok(bridged, 'target has a from-bridge body input');
  assert.equal(bridged.name, 'basket_id', 'OCAPI threading field labeled structurally (basket_id)');
  assert.equal(bridged.needsNaming, false, 'basket_id present on the produced basket type -> no prose fallback');
}

// collapseDuplicateProducerEdges: defense-in-depth guard for PROVIDED graphs.
// walkTypes no longer emits multiple edges into one consumer via the same field
// (it surfaces them as candidates), but a provided graph -- from the sub-agent
// path or hand-authored -- could still carry the pathological shape. The guard
// collapses each (consumer, viaField) group to a single edge so the bad
// multi-prerequisite plan (createBasket -> transferBasket -> mergeBasket -> ...)
// can't compose, and records a warning so the arbitrary pick is never silent.
{
  const graph = {
    nodes: [
      { slug: 'createBasket', requiredInputs: [] },
      { slug: 'transferBasket', requiredInputs: [] },
      { slug: 'mergeBasket', requiredInputs: [] },
      { slug: 'addPaymentInstrumentToBasket', requiredInputs: [{ name: 'basketId', in: 'path' }] },
    ],
    edges: [
      { from: 'createBasket', to: 'addPaymentInstrumentToBasket', viaField: 'basketId' },
      { from: 'transferBasket', to: 'addPaymentInstrumentToBasket', viaField: 'basketId' },
      { from: 'mergeBasket', to: 'addPaymentInstrumentToBasket', viaField: 'basketId' },
    ],
  };
  const { graph: collapsed, warnings } = collapseDuplicateProducerEdges(graph, 'addPaymentInstrumentToBasket');
  const basketIdEdges = collapsed.edges.filter(
    (e) => e.to === 'addPaymentInstrumentToBasket' && e.viaField === 'basketId',
  );
  assert.equal(basketIdEdges.length, 1, 'same-field producer edges collapsed to exactly one');
  assert.ok(Array.isArray(warnings) && warnings.length >= 1,
    'collapsing records a warning so the arbitrary pick is not silent');
  assert.match(warnings[0], /basketId/, 'the warning names the field that had multiple producers');
  // The dropped producers must also be pruned from nodes -- a node left with no
  // surviving edge would trip composePlan's "no structural edges" guard.
  const nodeSlugs = collapsed.nodes.map((n) => n.slug).sort();
  assert.deepEqual(nodeSlugs, ['addPaymentInstrumentToBasket', 'createBasket'],
    'orphaned alternative producers (transferBasket, mergeBasket) pruned; the kept create + target remain');
}

// collapseDuplicateProducerEdges: a normal fan-in (two DISTINCT fields, each with
// one producer) is untouched -- both edges survive. This is the shape the rewritten
// provided-graph integration test uses; the guard must not disturb it.
{
  const graph = {
    nodes: [
      { slug: 'createContainer', requiredInputs: [] },
      { slug: 'getItem', requiredInputs: [] },
      { slug: 'addItem', requiredInputs: [{ name: 'containerId' }, { name: 'itemFingerprint' }] },
    ],
    edges: [
      { from: 'createContainer', to: 'addItem', viaField: 'containerId' },
      { from: 'getItem', to: 'addItem', viaField: 'itemFingerprint' },
    ],
  };
  const { graph: collapsed, warnings } = collapseDuplicateProducerEdges(graph, 'addItem');
  assert.equal(collapsed.edges.length, 2, 'distinct-field fan-in is preserved (no collapse)');
  assert.equal(collapsed.nodes.length, 3, 'all nodes preserved when nothing is collapsed');
  assert.equal(warnings.length, 0, 'no warning when there is nothing pathological to collapse');
}

console.log('ok');
