'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

let fetchCallCount = 0;
globalThis.fetch = async () => {
  fetchCallCount++;
  throw new Error('fetch should not have been called (fresh cache)');
};

function freshIsoMinusSeconds(secs) {
  return new Date(Date.now() - secs * 1000).toISOString();
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-scrape-test-'));
}

function writeIndex(root, ref, scrapedAt) {
  const dir = path.join(root, ref);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '_index.json'),
    JSON.stringify({
      reference: ref,
      title: 'Stub',
      referencePageUrl: 'https://example.com/refs/stub?meta=Summary',
      scrapedAt,
      source: { format: 'oas-3', specUrl: 'https://example.com/stub.yaml' },
      slugs: ['Summary'],
      siblings: [],
    })
  );
}

(async () => {
  const { handleReference } = require('../lib/scrape/scrape.js');

  const entry = {
    id: 'stub',
    title: 'Stub',
    href: '/docs/.../references/stub',
    source: '/static/stub.yaml',
    referenceType: 'rest-oa3',
    amf: null,
  };

  // Case 1: Fresh cache (scrapedAt = now - 1 min, TTL default 1h) -> skip, refreshed:false, no fetch
  {
    const root = mkTmp();
    writeIndex(root, 'stub', freshIsoMinusSeconds(60));
    fetchCallCount = 0;
    const r = await handleReference(entry, {
      outRoot: root,
      referencePageUrl: 'https://example.com/refs/stub?meta=Summary',
      catalog: [entry],
    });
    assert.equal(r.refreshed, false, 'should skip fetch when fresh');
    assert.equal(r.reference, 'stub');
    assert.equal(fetchCallCount, 0, 'fetch should not be called when fresh');
  }

  // Case 2: Expired cache (scrapedAt = now - 2h, TTL default 1h) -> refresh path attempted
  {
    const root = mkTmp();
    writeIndex(root, 'stub', freshIsoMinusSeconds(7200));
    fetchCallCount = 0;
    await assert.rejects(
      handleReference(entry, {
        outRoot: root,
        referencePageUrl: 'https://example.com/refs/stub?meta=Summary',
        catalog: [entry],
      }),
      /fetch should not have been called/
    );
    assert.equal(fetchCallCount, 1, 'fetch should be attempted when stale');
  }

  // Case 3: No prior _index.json (first scrape) -> refresh path attempted
  {
    const root = mkTmp();
    fetchCallCount = 0;
    await assert.rejects(
      handleReference(entry, {
        outRoot: root,
        referencePageUrl: 'https://example.com/refs/stub?meta=Summary',
        catalog: [entry],
      }),
      /fetch should not have been called/
    );
    assert.equal(fetchCallCount, 1, 'fetch should be attempted on first scrape');
  }

  // Case 4: force flag bypasses fresh cache -> refresh path attempted even when fresh
  {
    const root = mkTmp();
    writeIndex(root, 'stub', freshIsoMinusSeconds(60));
    fetchCallCount = 0;
    await assert.rejects(
      handleReference(entry, {
        outRoot: root,
        referencePageUrl: 'https://example.com/refs/stub?meta=Summary',
        catalog: [entry],
        force: true,
      }),
      /fetch should not have been called/
    );
    assert.equal(fetchCallCount, 1, 'fetch should be attempted with force=true');
  }

  console.log('  freshness ok (4 cases)');
})().catch((err) => { console.error(err); process.exit(1); });
