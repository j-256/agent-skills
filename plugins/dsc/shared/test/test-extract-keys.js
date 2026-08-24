'use strict';

const assert = require('node:assert/strict');
const { extractKeys } = require('../scrape/extract-keys.js');

// --- Parens-acronym pass: extracts uppercase parens content
{
  const landing = {
    references: [
      { id: 'inventory-availability', title: 'Inventory Availability (OCI)' },
      { id: 'impex',                  title: 'Inventory Impex (OCI)' },
      { id: 'auth',                   title: 'Shopper Login (SLAS)' },
    ],
  };
  const keys = extractKeys(landing);
  assert.deepEqual(
    keys.sort(),
    ['OCI', 'SLAS'].sort(),
    'parens-acronym pass should extract OCI and SLAS once each',
  );
}

// --- Parens noise filter: multi-word parens (e.g. "(REST API)") dropped
{
  const landing = {
    references: [
      { id: 'mc-rest-briefs',  title: 'Briefs (REST API)' },
      { id: 'mc-rest-leads',   title: 'Leads (REST API)' },
    ],
  };
  const keys = extractKeys(landing);
  assert.deepEqual(keys, [], '(REST API) is multi-word and must be dropped from parens-acronym pass');
}

// --- Bare ALL-CAPS pass: extracts product-anchor tokens
{
  const landing = {
    references: [
      { id: 'fsc',  title: 'FSC Integrations' },
      { id: 'mrt',  title: 'MRT Admin' },
    ],
  };
  const keys = extractKeys(landing);
  assert.deepEqual(
    keys.sort(),
    ['FSC', 'MRT'].sort(),
    'bare-ALL-CAPS pass should extract FSC and MRT',
  );
}

// --- Bare ALL-CAPS noise blocklist: common technical/protocol terms dropped
{
  const landing = {
    references: [
      { id: 'cdn-zones', title: 'CDN Zones' },
      { id: 'agentforce-dx', title: 'Agentforce DX' },
      { id: 'einstein-gdpr', title: 'Einstein GDPR' },
      { id: 'pubsub-rpc', title: 'Pub/Sub API RPC Method Reference' },
      { id: 'shopper-seo', title: 'Shopper SEO' },
    ],
  };
  const keys = extractKeys(landing);
  assert.deepEqual(keys, [],
    'CDN, DX, GDPR, RPC, SEO must be in the noise blocklist (general/protocol terms, not product anchors)');
}

// --- Mixed pass: parens + bare-tokens dedup, preserves first-seen order
{
  const landing = {
    references: [
      { id: 'inventory-availability', title: 'Inventory Availability (OCI)' },
      { id: 'fsc',                    title: 'FSC Integrations' },
      { id: 'auth',                   title: 'Shopper Login (SLAS)' },
      { id: 'inventory-reservation',  title: 'Inventory Reservation (OCI)' },  // dup OCI
    ],
  };
  const keys = extractKeys(landing);
  assert.deepEqual(keys, ['OCI', 'FSC', 'SLAS'],
    'should dedup OCI and preserve first-seen order across passes');
}

// --- Empty / malformed landing handled gracefully
{
  assert.deepEqual(extractKeys({ references: [] }), [], 'empty references array yields []');
  assert.deepEqual(extractKeys({}), [], 'missing references key yields []');
  assert.deepEqual(extractKeys(null), [], 'null landing yields []');
  assert.deepEqual(extractKeys(undefined), [], 'undefined landing yields []');
}

// --- Reference entries with non-string titles are skipped, not thrown
{
  const landing = {
    references: [
      { id: 'no-title' },
      { id: 'null-title', title: null },
      { id: 'real',       title: 'Inventory Availability (OCI)' },
    ],
  };
  assert.deepEqual(extractKeys(landing), ['OCI']);
}

console.log('ok');
