'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { walkTypes, ReferenceNotScrapedError } = require('../scripts/walk-types.js');

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
// prewarmFamily in _shared/scrape/cache-access.js).
{
  const { producersOfType } = require('../scripts/walk-types.js');
  const found = producersOfType('Widget', ['about-bridge-area', 'refB'], CACHE, 'bridge-area');
  const slugs = found.map((f) => f.slug).sort();
  assert.deepEqual(slugs, ['createWidget'],
    'dir-less concept-page sibling skipped; the real producer in refB still found');
  assert.equal(found[0].reference, 'refB');
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

console.log('ok');
