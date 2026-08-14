'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveSchemaRefDeep } = require('../scripts/query.js');

// Build a throwaway reference dir with a types/ subdir holding cache-envelope
// type files ({kind:'type', type:{name, schema}}) -- the shape query.js reads.
function makeRefDir(types) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-query-refs-'));
  fs.mkdirSync(path.join(dir, 'types'));
  for (const [name, schema] of Object.entries(types)) {
    fs.writeFileSync(
      path.join(dir, 'types', `${name}.json`),
      JSON.stringify({ kind: 'type', type: { name, schema } }),
    );
  }
  return dir;
}

const REF = (name) => `#/components/schemas/${name}`;

// --- nested $ref inlines: TokenRequest.grant_type -> GrantType enum.
// This is the SLAS getAccessToken shape. A shallow resolve leaves grant_type as a
// bare {$ref}, forcing a second hand-read of GrantType.json; --resolve-refs must
// inline the enum so the grant_type values surface in a single lookup.
{
  const dir = makeRefDir({
    TokenRequest: {
      type: 'object',
      required: ['grant_type'],
      properties: {
        grant_type: { $ref: REF('GrantType'), description: 'The OAuth grant type' },
        channel_id: { type: 'string' },
      },
    },
    GrantType: {
      type: 'string',
      enum: ['authorization_code', 'refresh_token', 'client_credentials'],
    },
  });
  try {
    const resolved = resolveSchemaRefDeep(dir, REF('TokenRequest'));
    const gt = resolved.schema.properties.grant_type;
    assert.deepEqual(gt.enum, ['authorization_code', 'refresh_token', 'client_credentials'],
      'nested GrantType enum must be inlined into grant_type');
    assert.equal(gt.type, 'string', 'inlined node carries the target schema fields');
    assert.equal(gt.description, 'The OAuth grant type', 'a description on the $ref node is preserved');
    assert.deepEqual(resolved.schema.required, ['grant_type'], 'top-level required list is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- unresolvable nested ref: leave the {$ref} intact, do not throw.
{
  const dir = makeRefDir({
    Thing: { type: 'object', properties: { other: { $ref: REF('DoesNotExist') } } },
  });
  try {
    const resolved = resolveSchemaRefDeep(dir, REF('Thing'));
    assert.equal(resolved.schema.properties.other.$ref, REF('DoesNotExist'),
      'a ref to a missing type file is left intact rather than crashing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- cyclic refs terminate: A -> B -> A must not infinite-loop.
{
  const dir = makeRefDir({
    A: { type: 'object', properties: { b: { $ref: REF('B') } } },
    B: { type: 'object', properties: { a: { $ref: REF('A') } } },
  });
  try {
    const resolved = resolveSchemaRefDeep(dir, REF('A'));
    assert.ok(resolved && resolved.schema, 'cyclic type graph resolves without hanging');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- prototype-named schema keys remain ordinary own properties
{
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
  const dir = makeRefDir({ Hostile: schema });
  try {
    const resolved = resolveSchemaRefDeep(dir, REF('Hostile'));
    assert.equal(Object.getPrototypeOf(resolved.schema.properties), Object.prototype);
    assert.equal(Object.hasOwn(resolved.schema.properties, '__proto__'), true);
    assert.equal(resolved.schema.properties.__proto__.type, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('ok');
