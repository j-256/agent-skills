'use strict';

const assert = require('node:assert/strict');
const { CATALOG_MISSING_ALIASES } = require('../scrape/aliases.js');

// --- Shape: object with string keys -> string values, non-empty
{
  assert.equal(typeof CATALOG_MISSING_ALIASES, 'object', 'export must be an object');
  assert.notEqual(CATALOG_MISSING_ALIASES, null, 'export must not be null');
  const entries = Object.entries(CATALOG_MISSING_ALIASES);
  assert.ok(entries.length > 0, 'alias map must have at least one entry');
  for (const [key, value] of entries) {
    assert.equal(typeof key, 'string', `key must be string: ${key}`);
    assert.equal(typeof value, 'string', `value must be string for key ${key}`);
    assert.ok(key.length > 0, 'key must not be empty');
    assert.ok(value.length > 0, `value must not be empty for key ${key}`);
  }
}

// --- Key invariant: lowercase (matching contract is lowercase substring match)
{
  for (const key of Object.keys(CATALOG_MISSING_ALIASES)) {
    assert.equal(key, key.toLowerCase(), `alias key must be lowercase: ${key}`);
  }
}

// --- URL invariant: developer.salesforce.com /docs/.../references area-landing
{
  const urlPattern = /^https:\/\/developer\.salesforce\.com\/docs\/[^?#]+\/references$/;
  for (const [key, url] of Object.entries(CATALOG_MISSING_ALIASES)) {
    assert.match(
      url,
      urlPattern,
      `alias "${key}" -> "${url}" must be a /docs/.../references URL on developer.salesforce.com`,
    );
  }
}

console.log('ok');
