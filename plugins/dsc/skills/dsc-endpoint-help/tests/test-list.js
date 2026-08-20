'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIST = path.join(__dirname, '..', 'scripts', 'list.js');

function makeCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-list-'));
  // A real reference dir (has _index.json).
  fs.mkdirSync(path.join(root, 'commerce_commerce-api', 'orders'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'commerce_commerce-api', 'orders', '_index.json'),
    JSON.stringify({ reference: 'orders', slugs: [] }),
  );
  // A foreign archive: snapshots/<name>/<timestamp>/... -- a layout this tool never
  // writes, with no _index.json at the snapshots/<name> level. It must NOT be listed
  // as an area/reference (the real-cache repro that dead-ended a lookup).
  fs.mkdirSync(
    path.join(root, 'snapshots', 'slas-shopper-login', '2026-05-19T20-47-12', 'commerce_commerce-api', 'auth'),
    { recursive: true },
  );
  return root;
}

// --- list <cache> must not surface a foreign snapshots/ tree as a reference.
{
  const cache = makeCache();
  try {
    const res = spawnSync('node', [LIST, cache], { encoding: 'utf8' });
    assert.equal(res.status, 0, `list.js should exit 0; stderr=${res.stderr}`);
    const refs = JSON.parse(res.stdout).references;
    assert.ok(
      refs.some((r) => r.area === 'commerce_commerce-api' && r.reference === 'orders'),
      'the real reference must be listed',
    );
    assert.ok(
      !refs.some((r) => r.area === 'snapshots'),
      `a foreign snapshots/ tree must not be listed as an area; got ${JSON.stringify(refs)}`,
    );
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

console.log('ok');
