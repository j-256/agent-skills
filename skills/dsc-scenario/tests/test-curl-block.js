'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { walkTypes } = require('../scripts/walk-types.js');
const { composePlan } = require('../scripts/compose.js');
const { renderCurlBlock } = require('../scripts/curl-block.js');

const CACHE = path.join(__dirname, 'fixtures');
const REF = 'tiny-ref';

// Happy path: getItem scenario (createContainer -> addItem -> getItem)
{
  const graph = walkTypes({ targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'getItem', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const block = renderCurlBlock({ plan });

  // One curl invocation per step. Each step opens a `$(curl ...)` subshell
  // assigned to a response variable – detect by the opening pattern.
  const curlLines = block.split('\n').filter((l) => /=\$\(curl /.test(l));
  assert.equal(curlLines.length, 3);

  // Shell variable assignments for producer responses
  assert.match(block, /CREATECONTAINER_RESPONSE=/);
  assert.match(block, /ADDITEM_RESPONSE=/);

  // Consumer uses producer's output via jq extraction
  assert.match(block, /CONTAINERID=\$\(echo "\$CREATECONTAINER_RESPONSE" \| jq -r \.containerId\)/);
  assert.match(block, /ITEMID=\$\(echo "\$ADDITEM_RESPONSE" \| jq -r \.itemId\)/);

  // Final getItem references the extracted IDs in its URL
  assert.match(block, /\/containers\/\$\{CONTAINERID\}\/items\/\$\{ITEMID\}/);

  // Placeholder legend at the bottom
  assert.match(block, /BASE_URL:/);
}

// Single-step plan (target with no producers)
{
  const graph = walkTypes({ targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const plan = composePlan({ graph, targetSlug: 'createContainer', reference: REF, cacheRoot: CACHE, area: 'tiny-area' });
  const block = renderCurlBlock({ plan });
  const curlLines = block.split('\n').filter((l) => /=\$\(curl /.test(l));
  assert.equal(curlLines.length, 1);
  // No ID-extraction lines when there are no consumers.
  assert.ok(!/jq -r/.test(block.split('\n').filter((l) => l.startsWith('CONTAINERID=')).join('\n')));
}

// The runnable uses each step's basePath as the URL prefix (deterministic; was
// model-reconstructed prose before). A cross-reference plan gets each step's
// own prefix.
{
  const plan = {
    targetSlug: 'submitWidget', reference: 'refA', combinedScopes: ['widgets.rw'], idPassing: [],
    steps: [
      { slug: 'createWidget', reference: 'refB', basePath: '/checkout/widgets/v2', method: 'POST',
        path: '/organizations/{organizationId}/widgets', specUrl: 'https://developer.salesforce.com/x/refB?meta=createWidget',
        produces: [], requiredInputs: [], evidence: [{ kind: 'structural', viaField: 'widgetId', consumer: 'submitWidget' }] },
    ],
  };
  const bash = renderCurlBlock({ plan });
  assert.match(bash, /\$\{BASE_URL\}\/checkout\/widgets\/v2\/organizations\/\$\{ORGANIZATIONID\}\/widgets/,
    'curl URL includes the step basePath prefix');
}

// A null threading field (idPassing input {field: null}) must NOT crash. It
// arises when the bridge producer's family has no dominant path id, so the
// walker set needsNaming and the field has no structurally-derived name. The
// renderer must degrade gracefully: emit no jq-extraction line for the null
// field (no `NULL=` var, no `jq -r .null`), rather than throwing on
// `null.toUpperCase()`. The producer step still appears.
{
  const plan = {
    targetSlug: 'submitDoohickey', reference: 'refA', combinedScopes: ['doohickeys.rw'],
    idPassing: [{ consumer: 'submitDoohickey', inputs: [{ field: null, from: 'createDoohickey' }] }],
    steps: [
      { slug: 'createDoohickey', reference: 'refD', basePath: '/test/refD/v1', method: 'POST',
        path: '/organizations/{organizationId}/doohickeys', specUrl: 'https://developer.salesforce.com/x/refD?meta=createDoohickey',
        produces: [], requiredInputs: [], evidence: [{ kind: 'structural', viaField: null, consumer: 'submitDoohickey' }] },
      { slug: 'submitDoohickey', reference: 'refA', basePath: '/test/refA/v1', method: 'POST',
        path: '/organizations/{organizationId}/doohickey-orders', specUrl: 'https://developer.salesforce.com/x/refA?meta=submitDoohickey',
        produces: [], requiredInputs: [], evidence: [{ kind: 'structural', viaField: null, producer: 'createDoohickey' }] },
    ],
  };
  const bash = renderCurlBlock({ plan }); // must not throw
  assert.doesNotMatch(bash, /jq -r \.null/, 'no bogus `jq -r .null` extraction for a null field');
  assert.doesNotMatch(bash, /^NULL=/m, 'no `NULL=` variable assignment for a null field');
  // The producer step still renders (the user must know to call it).
  assert.match(bash, /createDoohickey/, 'producer step still present in the runnable');
}

console.log('ok');
