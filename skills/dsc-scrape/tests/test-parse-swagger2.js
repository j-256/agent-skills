'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseSwagger2 } = require('../scripts/parse-swagger2.js');

const spec = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ocapi-shop-products.json'), 'utf8')
);
const slugs = parseSwagger2(spec);

const by = (k) => slugs.filter((s) => s.kind === k);
assert.equal(by('summary').length, 1, 'exactly one summary');
assert.equal(by('endpoint').length, 13, `expected 13 endpoints, got ${by('endpoint').length}`);
assert.equal(by('type').length, 23, `expected 23 types, got ${by('type').length}`);

const summary = by('summary')[0];
assert.equal(summary.slug, 'Summary');
assert.equal(summary.summary.title, 'Shop API');
assert.ok(
  summary.summary.baseUrl.includes('/dw/shop/v25_6'),
  `summary baseUrl: ${summary.summary.baseUrl}`,
);

const getMulti = slugs.find((s) => s.slug === 'get-products-ids');
assert.ok(getMulti, 'get-products-ids endpoint missing (slug from fallback)');
assert.equal(getMulti.endpoint.method, 'GET');
assert.equal(getMulti.endpoint.path, '/products/({ids})');
assert.equal(getMulti.endpoint.operationId, 'Get multiple products');

const ids = getMulti.endpoint.parameters.find((p) => p.name === 'ids');
assert.ok(ids, 'ids path param missing');
assert.equal(ids.in, 'path');
assert.equal(ids.required, true);

assert.deepEqual(
  getMulti.endpoint.security.map((s) => s.scheme).sort(),
  ['client_id', 'customers_auth'],
);

assert.equal(getMulti.endpoint.responses.length, 1);
assert.equal(getMulti.endpoint.responses[0].code, 'default');

const productResultRef = slugs
  .flatMap((s) => s.kind === 'endpoint' ? s.endpoint.responses : [])
  .find((r) => r.schemaRef);
assert.ok(productResultRef, 'expected at least one response with a schemaRef');
assert.ok(
  productResultRef.schemaRef.startsWith('#/components/schemas/'),
  `$ref normalized to OAS-3 form, got ${productResultRef.schemaRef}`,
);

const baskets = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ocapi-shop-baskets.json'), 'utf8'),
);
const basketSlugs = parseSwagger2(baskets);
const createBasket = basketSlugs.find((s) => s.slug === 'post-baskets');
assert.ok(createBasket, 'post-baskets endpoint missing');
assert.equal(createBasket.endpoint.method, 'POST');
assert.ok(createBasket.endpoint.body, 'POST /baskets should have a body');
assert.ok(
  createBasket.endpoint.body.schemaRef?.startsWith('#/components/schemas/'),
  `body $ref normalized, got ${createBasket.endpoint.body.schemaRef}`,
);
assert.equal(
  createBasket.endpoint.parameters.find((p) => p.in === 'body'),
  undefined,
  'body parameter should be lifted out of parameters[]',
);

const productType = slugs.find((s) => s.slug === 'type:product');
assert.ok(productType, 'type:product missing');
assert.equal(productType.kind, 'type');
assert.equal(productType.type.name, 'product');
const productTypeRefs = JSON.stringify(productType.type.schema).match(/"\$ref":\s*"[^"]+"/g) || [];
for (const r of productTypeRefs) {
  assert.ok(
    r.includes('#/components/schemas/'),
    `type schema $ref still uses #/definitions/: ${r}`,
  );
}

console.log(
  `  parse-swagger2 ok (${by('summary').length} summary + ${by('endpoint').length} endpoints + ${by('type').length} types, refs normalized)`,
);
