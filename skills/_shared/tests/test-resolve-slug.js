'use strict';

const assert = require('node:assert/strict');
const { resolveSlug } = require('../resolve-slug.js');

const index = {
  reference: 'shopper-baskets',
  title: 'Shopper Baskets',
  slugs: ['Summary', 'createBasket', 'getBasket', 'addItemToBasket'],
  endpoints: {
    createBasket: {
      method: 'POST',
      path: '/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets',
    },
    getBasket: {
      method: 'GET',
      path: '/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}',
    },
    addItemToBasket: {
      method: 'POST',
      path: '/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/items',
    },
  },
};

// --- Exact match on templated path
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/checkout/shopper-baskets/v1/organizations/abc/baskets',
    index,
  });
  assert.equal(r.reference, 'shopper-baskets');
  assert.equal(r.slug, 'createBasket');
  assert.deepEqual(r.pathParams, { organizationId: 'abc' });
}

// --- Multiple path params
{
  const r = resolveSlug({
    method: 'GET',
    livePath: '/checkout/shopper-baskets/v1/organizations/abc/baskets/bk_123',
    index,
  });
  assert.equal(r.slug, 'getBasket');
  assert.deepEqual(r.pathParams, { organizationId: 'abc', basketId: 'bk_123' });
}

// --- Prefer longer (more specific) match
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/checkout/shopper-baskets/v1/organizations/abc/baskets/bk_1/items',
    index,
  });
  assert.equal(r.slug, 'addItemToBasket');
}

// --- Method mismatch: return null
{
  const r = resolveSlug({
    method: 'DELETE',
    livePath: '/checkout/shopper-baskets/v1/organizations/abc/baskets',
    index,
  });
  assert.equal(r, null);
}

// --- Path mismatch: return null
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/unrelated/path',
    index,
  });
  assert.equal(r, null);
}

// --- Trailing slash tolerance
{
  const r = resolveSlug({
    method: 'POST',
    livePath: '/checkout/shopper-baskets/v1/organizations/abc/baskets/',
    index,
  });
  assert.equal(r.slug, 'createBasket');
}

// --- Case-insensitive method
{
  const r = resolveSlug({
    method: 'post',
    livePath: '/checkout/shopper-baskets/v1/organizations/abc/baskets',
    index,
  });
  assert.equal(r.slug, 'createBasket');
}

// --- index without endpoints map: returns null (caller should refresh)
{
  const legacyIndex = { slugs: ['x', 'y'] };
  const r = resolveSlug({
    method: 'GET',
    livePath: '/x',
    index: legacyIndex,
  });
  assert.equal(r, null);
}

console.log('ok');
