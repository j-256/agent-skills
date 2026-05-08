'use strict';

const assert = require('node:assert/strict');
const { classifyUrl } = require('../scripts/classify.js');

const cases = [
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/orders?meta=createOrders',
    expect: { kind: 'slug', reference: 'orders', slug: 'createOrders' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/orders?meta=type%3AOrder',
    expect: { kind: 'slug', reference: 'orders', slug: 'type:Order' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/orders?meta=Summary',
    expect: { kind: 'reference-root', reference: 'orders' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/orders',
    expect: { kind: 'reference-root', reference: 'orders' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references',
    expect: { kind: 'area-landing' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/',
    expect: { kind: 'area-landing' },
  },
  {
    url: 'https://developer.salesforce.com/docs/apis',
    expect: { kind: 'api-catalog' },
  },
  {
    url: 'https://developer.salesforce.com/docs/apis/',
    expect: { kind: 'api-catalog' },
  },
  {
    url: 'https://developer.salesforce.com/docs/apis#browse',
    expect: { kind: 'api-catalog' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/about-commerce-api/scapi-api-doc.html',
    expect: { kind: 'landing' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-products',
    expect: { kind: 'reference-root', reference: 'ocapi-shop-products' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/b2c-commerce-ocapi',
    expect: { kind: 'reference-root', reference: 'b2c-commerce-ocapi' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/b2c-commerce-ocapi/b2c-api-doc.html',
    expect: { kind: 'landing' },
  },
  {
    url: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_what_is_rest_api.htm',
    expect: { kind: 'decline' },
  },
  {
    url: 'https://docs.mulesoft.com/foo',
    expect: { kind: 'decline' },
  },
  {
    url: 'https://developer.salesforce.com/docs/commerce/commerce-api/guide/authorization.html',
    expect: { kind: 'decline' },
  },
  {
    url: 'not a url',
    expect: { kind: 'decline' },
  },
];

for (const c of cases) {
  const got = classifyUrl(c.url);
  for (const [k, v] of Object.entries(c.expect)) {
    assert.equal(got[k], v, `classify ${c.url}: expected ${k}=${v}, got ${got[k]}`);
  }
}

console.log(`  ${cases.length} classify cases ok`);
