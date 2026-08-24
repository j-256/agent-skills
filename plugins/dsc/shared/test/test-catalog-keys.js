'use strict';

const assert = require('node:assert/strict');
const { CATALOG_KEYS } = require('../scrape/catalog-keys.js');

// --- Shape: object with string keys -> string values, non-empty
{
  assert.equal(typeof CATALOG_KEYS, 'object', 'export must be an object');
  assert.notEqual(CATALOG_KEYS, null, 'export must not be null');
  const entries = Object.entries(CATALOG_KEYS);
  assert.ok(entries.length > 0, 'catalog-keys map must have at least one entry');
  for (const [key, value] of entries) {
    assert.equal(typeof key, 'string', `key must be string: ${key}`);
    assert.equal(typeof value, 'string', `value must be string for key ${key}`);
    assert.ok(key.length > 0, 'key must not be empty');
    assert.ok(value.length > 0, `value must not be empty for key ${key}`);
  }
}

// --- Key invariant: lowercase (matching contract is lowercase substring match)
{
  for (const key of Object.keys(CATALOG_KEYS)) {
    assert.equal(key, key.toLowerCase(), `catalog-keys key must be lowercase: ${key}`);
  }
}

// --- Value invariant: looks like a catalog product title (not a URL).
// aliases.js owns the URL shape; catalog-keys.js owns the productTitle shape.
{
  for (const [key, value] of Object.entries(CATALOG_KEYS)) {
    assert.ok(
      !/^https?:\/\//.test(value),
      `catalog-keys value must be a productTitle, not a URL (key=${key}, value=${value}); ` +
      `URL-shaped entries belong in aliases.js`,
    );
  }
}

// --- No collision with aliases.js: catalog-keys is for catalog-PRESENT products,
// aliases is for catalog-MISSING. A key appearing in both signals confused intent.
{
  const { CATALOG_MISSING_ALIASES } = require('../scrape/aliases.js');
  for (const key of Object.keys(CATALOG_KEYS)) {
    assert.ok(
      !(key in CATALOG_MISSING_ALIASES),
      `key "${key}" exists in both catalog-keys.js and aliases.js -- pick one. ` +
      `aliases.js = catalog-missing (URL fallback); catalog-keys.js = catalog-present (productTitle match).`,
    );
  }
}

console.log('ok');
