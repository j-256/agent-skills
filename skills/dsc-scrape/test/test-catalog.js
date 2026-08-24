'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseCatalog } = require('../shared/scrape/parse-catalog.js');

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

{
  const refs = parseCatalog(fixture('marketing-cloud-growth-landing.html'));
  assert.equal(refs.length, 10);
  const restRefs = refs.filter((r) => r.referenceType === 'rest-oa3');
  assert.equal(restRefs.length, 8, 'MCG: expected 8 rest-oa3 refs');
  const markdownRefs = refs.filter((r) => r.referenceType === 'markdown');
  assert.equal(markdownRefs.length, 2, 'MCG: expected 2 markdown refs (skip cleanly)');
  const briefs = refs.find((r) => r.id === 'mc-rest-briefs');
  assert.ok(briefs, 'MCG: mc-rest-briefs entry missing');
  assert.ok(briefs.source.endsWith('.yml'), `MCG briefs source: ${briefs.source}`);
  assert.ok(briefs.amf.endsWith('.amf.json'), 'MCG: rest-oa3 entries carry an amf sidecar');
}

{
  const refs = parseCatalog(fixture('b2b-d2c-commerce-landing.html'));
  assert.equal(refs.length, 10);
  const cart = refs.find((r) => r.id === 'comm-cart-ref');
  assert.ok(cart, 'B2B/D2C: comm-cart-ref entry missing');
  assert.equal(cart.referenceType, 'rest-oa3');
  assert.ok(cart.source.endsWith('commerce-cart-api.yaml'), `B2B/D2C cart source: ${cart.source}`);
  const apex = refs.find((r) => r.id === 'comm-apex-reference');
  assert.ok(apex, 'B2B/D2C: comm-apex-reference entry missing');
  assert.equal(apex.referenceType, 'markdown', 'B2B/D2C: Apex doc is a markdown wrapper, skip cleanly');
  assert.equal(apex.source, null);
}

{
  const refs = parseCatalog(fixture('composable-storefront-landing.html'));
  assert.equal(refs.length, 3);
  const mrt = refs.find((r) => r.id === 'mrt-admin');
  assert.ok(mrt, 'Composable Storefront: mrt-admin entry missing');
  assert.equal(mrt.referenceType, 'rest-oa3');
  assert.ok(mrt.source.endsWith('managed-runtime-api.json'), `Composable Storefront mrt source: ${mrt.source}`);
}

{
  const refs = parseCatalog(fixture('healthcare-landing.html'));
  assert.equal(refs.length, 10);
  const restRamlRefs = refs.filter((r) => r.referenceType === 'rest-raml');
  assert.equal(restRamlRefs.length, 10, 'Healthcare: every ref is rest-raml');
  const care = refs.find((r) => r.id === 'care_management');
  assert.ok(care, 'Healthcare: care_management entry missing');
  assert.ok(care.source.endsWith('fhir-r4-care-management-api.raml'), `Healthcare care_management source: ${care.source}`);
  assert.ok(care.amf.endsWith('.raml.amf.json'), 'Healthcare: rest-raml entries carry an amf sidecar');
}

{
  const refs = parseCatalog(fixture('energy-utilities-landing.html'));
  assert.equal(refs.length, 1, 'Energy & Utilities: single-ref family');
  assert.equal(refs[0].id, 'energyapi');
  assert.equal(refs[0].referenceType, 'rest-raml');
  assert.ok(refs[0].source.endsWith('energy-integrations.raml'), `Energy source: ${refs[0].source}`);
}

{
  const refs = parseCatalog(fixture('fsc-landing.html'));
  assert.equal(refs.length, 11);
  const allRaml = refs.every((r) => r.referenceType === 'rest-raml');
  assert.ok(allRaml, 'FSC: every ref is rest-raml');
  const insurance = refs.find((r) => r.id === 'insurance');
  assert.ok(insurance, 'FSC: insurance entry missing');
  assert.ok(insurance.source.endsWith('fsc-insurance-api.raml'), `FSC insurance source: ${insurance.source}`);
}

{
  const refs = parseCatalog(fixture('loyalty-landing.html'));
  assert.equal(refs.length, 3);
  const ramlCount = refs.filter((r) => r.referenceType === 'rest-raml').length;
  const oa3Count = refs.filter((r) => r.referenceType === 'rest-oa3').length;
  assert.equal(ramlCount, 2, 'Loyalty: 2 rest-raml refs');
  assert.equal(oa3Count, 1, 'Loyalty: 1 rest-oa3 ref (loyalty_retail_api)');
  const retail = refs.find((r) => r.id === 'loyalty_retail_api');
  assert.ok(retail, 'Loyalty: loyalty_retail_api entry missing');
  assert.equal(retail.referenceType, 'rest-oa3');
  assert.ok(retail.source.endsWith('lc-retail-cloud-apis.yml'), `Loyalty retail source: ${retail.source}`);
}

{
  const refs = parseCatalog(fixture('tableau-next-landing.html'));
  assert.equal(refs.length, 6);
  const allOa3 = refs.every((r) => r.referenceType === 'rest-oa3');
  assert.ok(allOa3, 'Tableau Next: every ref is rest-oa3');
  const workspaces = refs.find((r) => r.id === 'workspaces-operations');
  assert.ok(workspaces, 'Tableau Next: workspaces-operations entry missing');
  assert.ok(workspaces.source.endsWith('workspaces.yaml'), `Tableau Next workspaces source: ${workspaces.source}`);
}

{
  const refs = parseCatalog(fixture('comms-tmforum-landing.html'));
  assert.equal(refs.length, 26, 'Communications TM Forum: 26 refs (release notes + 25 TMF specs)');
  const allRaml = refs.every((r) => r.referenceType === 'rest-raml');
  assert.ok(allRaml, 'Communications: every ref is rest-raml');
  const tmf620 = refs.find((r) => r.id === 'tmf620');
  assert.ok(tmf620, 'Communications: tmf620 entry missing');
  assert.ok(tmf620.source.endsWith('ProductCatalogApi.raml'), `Communications tmf620 source: ${tmf620.source}`);
  assert.ok(tmf620.amf.endsWith('.raml.amf.json'), 'Communications: rest-raml entries carry an amf sidecar');
}

{
  const refs = parseCatalog(fixture('subscription-management-landing.html'));
  assert.equal(refs.length, 14);
  const allRaml = refs.every((r) => r.referenceType === 'rest-raml');
  assert.ok(allRaml, 'Subscription Management: every ref is rest-raml');
  const quotes = refs.find((r) => r.id === 'quotes');
  assert.ok(quotes, 'Subscription Management: quotes entry missing');
  assert.ok(quotes.source.endsWith('quote-to-order.raml'), `SM quotes source: ${quotes.source}`);
}

{
  const refs = parseCatalog(fixture('einstein-bot-landing.html'));
  assert.equal(refs.length, 2);
  const api = refs.find((r) => r.id === 'bot-api-v5');
  assert.ok(api, 'Einstein Bot: bot-api-v5 entry missing');
  assert.equal(api.referenceType, 'rest-oa3');
  assert.ok(api.source.endsWith('v5_1_0_api_specs.yml'), `Einstein Bot api source: ${api.source}`);
  const about = refs.find((r) => r.id === 'about');
  assert.ok(about, 'Einstein Bot: about entry missing');
  assert.equal(about.referenceType, 'markdown', 'Einstein Bot: about is a markdown wrapper, skip cleanly');
  assert.equal(about.source, null);
}

{
  const refs = parseCatalog(fixture('messaging-miaw-landing.html'));
  assert.equal(refs.length, 2);
  const api = refs.find((r) => r.id === 'miaw-api-reference');
  assert.ok(api, 'MIAW: miaw-api-reference entry missing');
  assert.equal(api.referenceType, 'rest-oa3');
  assert.ok(api.source.endsWith('combined_miaw_ref.yml'), `MIAW api source: ${api.source}`);
  const about = refs.find((r) => r.id === 'about');
  assert.ok(about, 'MIAW: about entry missing');
  assert.equal(about.referenceType, 'markdown', 'MIAW: about is a markdown wrapper, skip cleanly');
}

console.log('  catalog parser ok (16 fixtures)');
