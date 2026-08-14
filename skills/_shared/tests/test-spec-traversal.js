'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const { typeHasProperty, normalizeSchema, ReferenceNotScrapedError, refDirFor } = require('../common/spec-traversal.js');

// normalizeSchema: AMF array-properties -> OAS object-properties.
{
  const amf = { type: 'object', properties: [{ name: 'number', required: true, range: {} }] };
  const out = normalizeSchema(amf);
  assert.ok('number' in out.properties, 'AMF property lifted into OAS properties object');
  assert.deepEqual(out.required, ['number']);
}
{
  const amf = { type: 'object', properties: [{ name: '__proto__', required: false, range: { type: 'string' } }] };
  const out = normalizeSchema(amf);
  assert.equal(Object.getPrototypeOf(out.properties), Object.prototype);
  assert.equal(Object.hasOwn(out.properties, '__proto__'), true);
  assert.equal(out.properties.__proto__.type, 'string');
}
// normalizeSchema: OAS passthrough (properties already an object) is unchanged.
{
  const oas = { type: 'object', required: ['x'], properties: { x: {} } };
  assert.deepEqual(normalizeSchema(oas), oas);
}
// refDirFor throws the typed error when the reference is uncached.
{
  assert.throws(() => refDirFor(`${os.tmpdir()}/dsc-nonexistent-cache`, 'no-such-ref', 'no_area'),
    (e) => e instanceof ReferenceNotScrapedError, 'uncached reference -> ReferenceNotScrapedError');
}
// typeHasProperty against a real cached leaf type (grounds the masked_number anchor).
// Requires the ocapi-shop-baskets reference in the local cache; skip cleanly if absent.
{
  const cacheRoot = `${os.homedir()}/.cache/dsc-scrape`;
  // The OCAPI providers (and thus compose) key OCAPI on the commerce_b2c-commerce
  // area; use the same copy the live flow reads. Both cached copies carry the same
  // leaf type, but stay consistent with the routing area.
  const area = 'commerce_b2c-commerce';
  try {
    const hasNumber = typeHasProperty(cacheRoot, 'ocapi-shop-baskets', 'order_payment_card_request', 'number', area);
    const hasMasked = typeHasProperty(cacheRoot, 'ocapi-shop-baskets', 'order_payment_card_request', 'masked_number', area);
    if (hasNumber === true) {
      assert.equal(hasMasked, false, 'leaf create-body card type declares raw number, not masked_number');
    } else {
      console.log('  (skipped ocapi cache assertion: reference not cached)');
    }
  } catch (e) {
    if (e instanceof ReferenceNotScrapedError) console.log('  (skipped ocapi cache assertion: not scraped)');
    else throw e;
  }
}
console.log('ok');
