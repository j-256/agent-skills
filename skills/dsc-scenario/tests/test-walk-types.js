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

// producedTypes in stored nodes: only {name, ref}, no inlineProperties leak.
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  for (const node of graph.nodes) {
    for (const pt of node.producedTypes) {
      assert.deepEqual(Object.keys(pt).sort(), ['name', 'ref']);
    }
  }
}

console.log('ok');
