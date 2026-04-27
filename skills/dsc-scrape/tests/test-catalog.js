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

console.log('  catalog parser ok (3 fixtures)');
