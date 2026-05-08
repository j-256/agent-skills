'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseCatalog } = require('../scripts/parse-catalog.js');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

{
  const refs = parseCatalog(fixture('scapi-landing.html'));
  assert.ok(refs.length > 40, `SCAPI: expected many refs, got ${refs.length}`);
  const orders = refs.find((r) => r.id === 'orders');
  assert.ok(orders, 'SCAPI: orders reference missing');
  assert.equal(orders.referenceType, 'rest-oa3');
  assert.ok(orders.source.endsWith('.yaml'), `SCAPI orders source: ${orders.source}`);
}

{
  const refs = parseCatalog(fixture('einstein-landing.html'));
  assert.equal(refs.length, 4);
  const rec = refs.find((r) => r.id === 'einstein-recommendations');
  assert.ok(rec);
  assert.equal(rec.referenceType, 'rest-raml');
  assert.ok(rec.source.endsWith('.raml'));
  assert.ok(rec.amf.endsWith('.raml.amf.json'));
}

{
  const refs = parseCatalog(fixture('data-connectapi-landing.html'));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, 'spec');
  assert.equal(refs[0].referenceType, 'rest-oa3');
  assert.equal(refs[0].amf, null, 'ReDoc entry has empty amf -> null');
}

{
  // Regression: OCAPI refList entries embed HTML in docPhase.body. Backslashes
  // inside that HTML serialize as &#92; in the attribute. Without that entity
  // in the decoder, JSON.parse fails on the resulting \" sequence.
  const refs = parseCatalog(fixture('ocapi-landing.html'));
  assert.equal(refs.length, 3);
  const sp = refs.find((r) => r.id === 'ocapi-shop-products');
  assert.ok(sp, 'OCAPI: ocapi-shop-products entry missing');
  assert.equal(sp.referenceType, 'rest-oa2');
  assert.ok(sp.source.endsWith('.json'));
  const wrapper = refs.find((r) => r.id === 'b2c-commerce-ocapi');
  assert.ok(wrapper, 'OCAPI: wrapper entry missing');
  assert.equal(wrapper.referenceType, 'markdown');
  assert.equal(wrapper.source, null);
}

console.log('  catalog parser ok (4 fixtures)');
