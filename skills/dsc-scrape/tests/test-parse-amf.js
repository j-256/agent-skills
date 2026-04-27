'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseAmf } = require('../scripts/parse-amf.js');

const amf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'einstein-recommendations.amf.json'),
    'utf8'
  )
);
const slugs = parseAmf(amf);

const by = (k) => slugs.filter((s) => s.kind === k);
assert.equal(by('summary').length, 1);
assert.equal(by('endpoint').length, 7);
assert.equal(by('type').length, 19);

const summary = by('summary')[0];
assert.equal(summary.summary.title, 'Einstein Recommendations');
assert.equal(summary.summary.version, 'v3');
assert.ok(summary.summary.baseUrl);

const getRecs = slugs.find((s) => s.slug === 'getRecommendations');
assert.ok(getRecs);
assert.equal(getRecs.endpoint.method, 'POST');
assert.ok(getRecs.endpoint.url.includes('cquotient.com'));
assert.ok(getRecs.endpoint.path.startsWith('/personalization/recs'));
assert.ok(Array.isArray(getRecs.endpoint.headers));
assert.ok(getRecs.endpoint.body);

// Regression: curl field should be gone
assert.equal(getRecs.endpoint.curl, undefined, 'curl field should not be emitted');

// Regression: path field on properties should be gone
const pv = slugs.find((s) => s.slug === 'type:ProductForView');
assert.ok(pv);
const idProp = pv.type.schema.properties.find((p) => p.name === 'id');
assert.ok(idProp);
assert.equal(idProp.path, undefined, 'AMF property.path should be dropped');
assert.equal(idProp.required, true);

// Enum resolution: altIdType is an enum of strings, not an rdfs:Seq dump
const altIdType = pv.type.schema.properties.find((p) => p.name === 'altIdType');
assert.ok(altIdType);
assert.ok(Array.isArray(altIdType.range.enum), 'enum should be array of scalars');
assert.ok(altIdType.range.enum.includes('vgroup'), 'enum should contain string values');

console.log(
  `  parse-amf ok (${by('summary').length} summary + ${by('endpoint').length} endpoints + ${by('type').length} types)`
);
