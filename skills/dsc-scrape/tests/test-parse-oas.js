'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require('../lib/scrape/load-yaml.js');
const { parseOas } = require('../lib/scrape/parse-oas.js');

const spec = yaml.load(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'orders.yaml'), 'utf8')
);
const slugs = parseOas(spec);

const by = (k) => slugs.filter((s) => s.kind === k);
assert.equal(by('summary').length, 1, 'exactly one summary');
assert.ok(by('endpoint').length >= 10, `expected many endpoints, got ${by('endpoint').length}`);
assert.ok(by('type').length >= 20, `expected many types, got ${by('type').length}`);

const summary = by('summary')[0];
assert.equal(summary.slug, 'Summary');
assert.equal(summary.summary.title, 'Orders');
assert.ok(summary.summary.baseUrl.includes('commercecloud.salesforce.com'));

const createOrders = slugs.find((s) => s.slug === 'createOrders');
assert.ok(createOrders, 'createOrders endpoint missing');
assert.equal(createOrders.endpoint.method, 'POST');
assert.ok(createOrders.endpoint.path.endsWith('/orders'));
assert.ok(Array.isArray(createOrders.endpoint.parameters));
assert.ok(createOrders.endpoint.body, 'createOrders should have a body');
assert.ok(createOrders.endpoint.responses.length > 0);

// Regression: curl field should be gone
assert.equal(
  createOrders.endpoint.curl,
  undefined,
  'curl field should not be emitted'
);

// Type slugs should be prefixed with `type:`
const firstType = by('type')[0];
assert.ok(firstType.slug.startsWith('type:'));
assert.ok(firstType.type.schema);

// Fallback slug format for specs missing operationId: `<method>-<path>` with
// braces stripped and slashes replaced. Synthetic mini-spec to exercise it –
// the live fixtures all have real operationIds, so only this test protects
// the fallback against regressions.
const syntheticSpec = {
  openapi: '3.0.0',
  info: { title: 'Synth', version: '1.0.0' },
  servers: [{ url: 'https://example.com/v1' }],
  paths: {
    '/ssot/activation-targets': {
      get: { summary: 'List activation targets', responses: {} },
    },
    '/ssot/activations/{activationId}/actions/publish': {
      post: { summary: 'Publish activation', responses: {} },
    },
  },
};
const synthSlugs = parseOas(syntheticSpec).filter((s) => s.kind === 'endpoint').map((s) => s.slug);
assert.deepEqual(synthSlugs, [
  'get-ssot-activation-targets',
  'post-ssot-activations-activationId-actions-publish',
], `fallback slugs wrong: ${JSON.stringify(synthSlugs)}`);

console.log(
  `  parse-oas ok (${by('summary').length} summary + ${by('endpoint').length} endpoints + ${by('type').length} types, fallback slugs ok)`
);
