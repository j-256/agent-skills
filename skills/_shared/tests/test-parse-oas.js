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

// --- non-JSON only (no application/json declared): contentTypes set, no schema
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
              'multipart/form-data': { schema: { type: 'object' } },
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
  assert.equal(ep.body.schema, undefined,
    'spec without application/json should not produce a JSON schema field');
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
