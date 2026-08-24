'use strict';

const assert = require('node:assert/strict');
const { parseOas } = require('../scrape/parse-oas.js');

function findEndpoint(slugs, slug) {
  return slugs.find((s) => s.kind === 'endpoint' && s.slug === slug);
}

// --- application/json only: contentTypes=['application/json'], schema present
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/foo': {
        post: {
          operationId: 'createFoo',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { x: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const slugs = parseOas(spec);
  const ep = findEndpoint(slugs, 'createFoo').endpoint;
  assert.deepEqual(ep.body.contentTypes, ['application/json']);
  assert.equal(ep.body.required, true);
  assert.ok(ep.body.schema);
  assert.equal(ep.body.schema.type, 'object');
}

// --- multiple declared content-types: contentTypes lists all in declaration order;
// schema/examples come from the JSON entry.
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/foo': {
        post: {
          operationId: 'createFoo',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object' } },
              'application/x-www-form-urlencoded': { schema: { type: 'object' } },
              'text/plain': {},
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const ep = findEndpoint(parseOas(spec), 'createFoo').endpoint;
  assert.deepEqual(ep.body.contentTypes, [
    'application/json',
    'application/x-www-form-urlencoded',
    'text/plain',
  ]);
  assert.ok(ep.body.schema, 'schema should still come from the JSON entry');
}

// --- non-JSON body WITH a declared schema: the schema is captured regardless of
// content-type. A form/multipart endpoint (e.g. SLAS getAccessToken, which uses
// application/x-www-form-urlencoded) must surface its field schema, not just the
// content-type list. (The parser previously read only application/json and dropped
// this, so a form-urlencoded token body arrived as {contentTypes, required} with no
// fields -- the exact gap that forced hand-reading the raw type files.)
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string' } } } },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const ep = findEndpoint(parseOas(spec), 'upload').endpoint;
  assert.deepEqual(ep.body.contentTypes, ['multipart/form-data']);
  assert.equal(ep.body.required, true);
  assert.ok(ep.body.schema, 'a declared non-JSON body schema must be captured');
  assert.equal(ep.body.schema.type, 'object');
}

// --- application/x-www-form-urlencoded body with a $ref schema (the SLAS
// getAccessToken shape): the ref is captured as body.schemaRef so --resolve-refs
// can inline the form fields (grant_type, channel_id, ...). A named-type body uses
// schemaRef, never an inline body.schema.
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/oauth2/token': {
        post: {
          operationId: 'getAccessToken',
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': { schema: { $ref: '#/components/schemas/TokenRequest' } },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const ep = findEndpoint(parseOas(spec), 'getAccessToken').endpoint;
  assert.deepEqual(ep.body.contentTypes, ['application/x-www-form-urlencoded']);
  assert.equal(ep.body.schemaRef, '#/components/schemas/TokenRequest');
  assert.equal(ep.body.schema, undefined, 'a $ref body must use schemaRef, not an inline schema');
}

// --- multiple content-types each carrying a schema: application/json wins, so the
// richer JSON schema surfaces rather than a form variant. Ordered form-first here to
// prove json is chosen by priority, not declaration order.
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/foo': {
        post: {
          operationId: 'createFoo',
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { f: { type: 'string' } } } },
              'application/json': { schema: { type: 'object', properties: { j: { type: 'string' } } } },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const ep = findEndpoint(parseOas(spec), 'createFoo').endpoint;
  assert.ok(ep.body.schema && ep.body.schema.properties.j, 'application/json schema should win when present');
  assert.equal(ep.body.schema.properties.f, undefined, 'should not pick the form-urlencoded schema over json');
}

// --- empty body.content: returns null (preserve prior contract)
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/foo': {
        post: {
          operationId: 'createFoo',
          requestBody: { required: true, content: {} },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const ep = findEndpoint(parseOas(spec), 'createFoo').endpoint;
  assert.equal(ep.body, null,
    'empty content map should produce null body, matching prior contract for "no body"');
}

// --- no requestBody at all: body=null
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/foo': {
        get: {
          operationId: 'getFoo',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const ep = findEndpoint(parseOas(spec), 'getFoo').endpoint;
  assert.equal(ep.body, null);
}

console.log('ok');
