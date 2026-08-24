'use strict';

// Anti-drift guard. The walker fixtures (tiny-ref, ver-area) are hand-authored
// JSON that MUST match the shape the scrapers actually emit -- otherwise the
// walker tests pass against a layout the real cache never produces (the exact
// "green test, broken on real data" failure this guard exists to prevent; see
// evals/dsc-scenario/iteration-walk-types-responses-layout.md).
//
// Two halves:
//   1. Pin the contract: run parseOas on a minimal spec and assert the emitted
//      endpoint shape (array responses with {code, schemaRef}; body.schemaRef
//      for a named-type body; params carrying type under p.schema).
//   2. Enforce it on the fixtures: every committed endpoint fixture must use
//      that same shape -- responses is an array (never an object), each entry
//      keyed by `code` (never an OAS status-code key), and refs live in
//      `schemaRef` (never a nested `schema.$ref`).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseOas } = require('../shared/scrape/parse-oas.js');

// 1. Contract: parseOas emits the real layout for a named-type body + response.
{
  const spec = {
    openapi: '3.0.0',
    servers: [{ url: 'https://example.com/api' }],
    paths: {
      '/things/{thingId}': {
        get: {
          operationId: 'getThing',
          parameters: [
            { name: 'thingId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
          },
        },
        post: {
          operationId: 'createThing',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
          responses: {
            201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
          },
        },
      },
    },
    components: { schemas: { Thing: { type: 'object', required: ['thingId'], properties: { thingId: { type: 'string' } } } } },
  };

  const slugs = parseOas(spec);
  const getThing = slugs.find((s) => s.slug === 'getThing').endpoint;
  const createThing = slugs.find((s) => s.slug === 'createThing').endpoint;

  // Responses are an array, each entry keyed by `code` with the ref in schemaRef.
  assert.ok(Array.isArray(getThing.responses), 'parseOas emits responses as an array');
  assert.equal(getThing.responses[0].code, '200', 'response entry carries the status in `code`');
  assert.equal(getThing.responses[0].schemaRef, '#/components/schemas/Thing', 'response ref lives in `schemaRef`');
  assert.equal(getThing.responses[0].schema, undefined, 'no nested `schema.$ref` on the response entry');

  // A named-type body is emitted as body.schemaRef (no inline body.schema).
  assert.equal(createThing.body.schemaRef, '#/components/schemas/Thing', 'named-type body emitted as body.schemaRef');
  assert.equal(createThing.body.schema, undefined, 'named-type body has no inline body.schema');

  // Path params carry their type under p.schema, not a bare p.type.
  assert.equal(getThing.parameters[0].schema.type, 'string', 'param type lives under p.schema.type');
}

// 2. Every committed endpoint fixture matches that contract.
const FIXTURE_ROOT = path.join(__dirname, 'fixtures');

function endpointFixtureFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip _landing and types/ dirs -- only endpoint docs carry responses.
      if (entry.name === 'types' || entry.name === '_landing') continue;
      out.push(...endpointFixtureFiles(full));
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
      out.push(full);
    }
  }
  return out;
}

let checked = 0;
for (const file of endpointFixtureFiles(FIXTURE_ROOT)) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    assert.fail(`fixture ${file} is not valid JSON: ${e.message}`);
  }
  if (doc.kind !== 'endpoint') continue;
  const ep = doc.endpoint || {};
  const rel = path.relative(FIXTURE_ROOT, file);

  if (ep.responses !== undefined) {
    assert.ok(Array.isArray(ep.responses),
      `${rel}: responses must be an array (the scraper layout), not an object`);
    for (const r of ep.responses) {
      assert.ok(r && typeof r.code === 'string',
        `${rel}: each response entry must carry a string \`code\` (got ${JSON.stringify(r && r.code)})`);
      assert.equal(r.schema && r.schema.$ref, undefined,
        `${rel}: response refs must be in \`schemaRef\`, not a nested \`schema.$ref\``);
    }
  }
  // A body ref must be in body.schemaRef, never a nested body.schema.$ref.
  if (ep.body && ep.body.schema && ep.body.schema.$ref) {
    assert.fail(`${rel}: body ref must be in body.schemaRef, not body.schema.$ref`);
  }
  checked += 1;
}

assert.ok(checked >= 6, `expected to validate the walker endpoint fixtures; only saw ${checked}`);

console.log('ok');
