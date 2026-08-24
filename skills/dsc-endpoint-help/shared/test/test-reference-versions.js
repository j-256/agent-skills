'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const {
  resolveVersions,
  parseVersionedId,
  VersionResolutionError,
} = require('../scrape/reference-versions.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-versions-'));
  const landingDir = path.join(root, '_landing');
  fs.mkdirSync(landingDir, { recursive: true });

  // commerce-api: a versioned pair + an unversioned ref.
  const scapi = {
    kind: 'area-landing',
    area: 'commerce_commerce-api',
    references: [
      { id: 'shopper-baskets', title: 'Shopper Baskets V1' },
      { id: 'shopper-baskets-v2', title: 'Shopper Baskets V2' },
      { id: 'shopper-orders', title: 'Shopper Orders' },
    ],
  };
  // einstein-bot: a -vN id with NO unsuffixed base sibling.
  const bot = {
    kind: 'area-landing',
    area: 'service_einstein-bot-api',
    references: [{ id: 'bot-api-v5', title: 'Einstein Bots API' }],
  };
  fs.writeFileSync(path.join(landingDir, 'commerce_commerce-api.json'), JSON.stringify(scapi));
  fs.writeFileSync(path.join(landingDir, 'service_einstein-bot-api.json'), JSON.stringify(bot));

  // Ref dirs + _index.json with basePath for the basket pair.
  function mkref(area, id, basePath) {
    const dir = path.join(root, area, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify({ reference: id, basePath }));
  }
  mkref('commerce_commerce-api', 'shopper-baskets', '/checkout/shopper-baskets/v1');
  mkref('commerce_commerce-api', 'shopper-baskets-v2', '/checkout/shopper-baskets/v2');
  mkref('commerce_commerce-api', 'shopper-orders', '/checkout/shopper-orders/v1');
  mkref('service_einstein-bot-api', 'bot-api-v5', '/bots/v5');

  return root;
}

function teardown(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const root = setup();
try {
  // parseVersionedId: suffix vs implicit-v1.
  assert.deepEqual(parseVersionedId('shopper-baskets-v2'), { base: 'shopper-baskets', version: 2 });
  assert.deepEqual(parseVersionedId('shopper-baskets'), { base: 'shopper-baskets', version: 1 });
  assert.deepEqual(parseVersionedId('bot-api-v5'), { base: 'bot-api', version: 5 });

  // Requested the unversioned base -> latest is v2, both siblings listed ascending.
  {
    const r = resolveVersions(root, 'shopper-baskets');
    assert.equal(r.requested, 'shopper-baskets');
    assert.equal(r.requestedIsVersioned, false);
    assert.equal(r.latest, 'shopper-baskets-v2');
    assert.equal(r.hasMultipleVersions, true);
    assert.deepEqual(r.versions.map((v) => v.id), ['shopper-baskets', 'shopper-baskets-v2']);
    assert.equal(r.versions[0].basePath, '/checkout/shopper-baskets/v1');
    assert.equal(r.versions[1].basePath, '/checkout/shopper-baskets/v2');
  }

  // Requested v2 explicitly -> still latest, but flagged as version-pinned.
  {
    const r = resolveVersions(root, 'shopper-baskets-v2');
    assert.equal(r.requestedIsVersioned, true);
    assert.equal(r.latest, 'shopper-baskets-v2');
    assert.equal(r.hasMultipleVersions, true);
  }

  // Unversioned, single-version reference -> no-op.
  {
    const r = resolveVersions(root, 'shopper-orders');
    assert.equal(r.latest, 'shopper-orders');
    assert.equal(r.hasMultipleVersions, false);
    assert.deepEqual(r.versions.map((v) => v.id), ['shopper-orders']);
  }

  // -vN id with no base sibling -> itself, never a fabricated 'bot-api'.
  {
    const r = resolveVersions(root, 'bot-api-v5');
    assert.equal(r.requestedIsVersioned, true);
    assert.equal(r.latest, 'bot-api-v5');
    assert.equal(r.hasMultipleVersions, false);
    assert.deepEqual(r.versions.map((v) => v.id), ['bot-api-v5']);
  }

  // Not-cached id -> no-op shape, no throw.
  {
    const r = resolveVersions(root, 'nonexistent-ref');
    assert.equal(r.latest, 'nonexistent-ref');
    assert.equal(r.hasMultipleVersions, false);
  }

  // Malformed args -> VersionResolutionError.
  assert.throws(() => resolveVersions(root, 42), (e) => e instanceof VersionResolutionError);
  assert.throws(() => resolveVersions(null, 'shopper-baskets'), (e) => e instanceof VersionResolutionError);

  // --- CLI mode: stdin JSON -> stdout JSON ---
  {
    const { execFileSync } = require('node:child_process');
    const cliPath = path.join(__dirname, '..', 'scrape', 'reference-versions.js');
    const out = execFileSync('node', [cliPath], {
      input: JSON.stringify({ reference: 'shopper-baskets', cacheRoot: root }),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.latest, 'shopper-baskets-v2');
    assert.equal(parsed.hasMultipleVersions, true);
  }
} finally {
  teardown(root);
}

console.log('ok');
