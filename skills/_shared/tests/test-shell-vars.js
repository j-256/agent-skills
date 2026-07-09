'use strict';

const assert = require('node:assert/strict');
const { shellVar, interpolatePath } = require('../shell-vars.js');

// camelCase -> SNAKE_UPPER at word boundaries
assert.equal(shellVar('organizationId'), 'ORGANIZATION_ID');
assert.equal(shellVar('siteId'), 'SITE_ID');
assert.equal(shellVar('createContainer'), 'CREATE_CONTAINER');
// already-snake is idempotent (no double underscores)
assert.equal(shellVar('basket_id'), 'BASKET_ID');
assert.equal(shellVar('order_no'), 'ORDER_NO');
// single word
assert.equal(shellVar('id'), 'ID');
// acronym-ish runs stay intact (no split inside all-caps): 'productID' -> PRODUCT_ID
assert.equal(shellVar('productID'), 'PRODUCT_ID');
// non-alphanumerics collapse to underscore (shell-safety), no leading/trailing/double _
assert.equal(shellVar('foo-bar.baz'), 'FOO_BAR_BAZ');

// interpolatePath threads shellVar into ${...}
assert.equal(
  interpolatePath('/containers/{containerId}/items/{itemId}'),
  '/containers/${CONTAINER_ID}/items/${ITEM_ID}',
);
// snake path param stays snake
assert.equal(
  interpolatePath('/baskets/{basket_id}/items'),
  '/baskets/${BASKET_ID}/items',
);
// no params -> unchanged
assert.equal(interpolatePath('/orders'), '/orders');

console.log('ok');
