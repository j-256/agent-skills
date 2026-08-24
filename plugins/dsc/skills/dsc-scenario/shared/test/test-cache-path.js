'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cachePath, cacheSegment } = require('../scrape/cache-path.js');
const { referenceDir, writeIndex, writeLanding, writeSlug } = require('../scrape/write-slugs.js');
const { resolveReferenceDir } = require('../scrape/resolve-cache.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-cache-path-'));
try {
  writeIndex(root, 'commerce_api', 'orders', { slugs: [] });
  const expectedDir = referenceDir(root, 'commerce_api', 'orders');
  assert.equal(resolveReferenceDir(root, 'orders', { area: 'commerce_api' }).dir, expectedDir);

  const slugPath = writeSlug(root, 'commerce_api', 'orders', '../../outside', { ok: true });
  assert.equal(path.dirname(slugPath), expectedDir, 'slug separators stay inside the reference directory');

  assert.throws(() => cacheSegment('..', 'area'), /invalid area/i);
  assert.throws(() => cachePath(root, '../outside'), /invalid cache path segment/i);
  assert.throws(() => writeIndex(root, '..', 'orders', {}), /invalid cache path segment/i);
  assert.throws(() => writeIndex(root, 'commerce_api', '../orders', {}), /invalid cache path segment/i);
  const landingPath = writeLanding(root, '../outside', {});
  assert.equal(path.dirname(landingPath), cachePath(root, '_landing'));
  assert.throws(
    () => resolveReferenceDir(root, 'orders', { area: '..' }),
    /invalid area/i,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ok');
