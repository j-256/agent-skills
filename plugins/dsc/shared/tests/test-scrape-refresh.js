'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { scrapeRefresh, ScrapeInvocationError } = require('../common/scrape-refresh.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-scrape.js');

async function main() {
  // --- ok-refreshed
  {
    process.env.FAKE_MODE = 'ok-refreshed';
    const r = await scrapeRefresh({
      scrapeScript: FAKE,
      referenceUrl: 'https://developer.salesforce.com/docs/x/references/orders',
      cacheRoot: '/tmp/fake-cache',
    });
    assert.equal(r.refreshed, true);
    assert.equal(r.reference, 'orders');
    assert.equal(r.format, 'oas-3');
    assert.ok(Array.isArray(r.files) && r.files.length > 0);
  }

  // --- ok-fresh (TTL hit)
  {
    process.env.FAKE_MODE = 'ok-fresh';
    const r = await scrapeRefresh({
      scrapeScript: FAKE,
      referenceUrl: 'https://developer.salesforce.com/docs/x/references/orders',
      cacheRoot: '/tmp/fake-cache',
    });
    assert.equal(r.refreshed, false);
    assert.equal(r.reference, 'orders');
  }

  // --- 404 from scrape -> typed error with exitCode
  {
    process.env.FAKE_MODE = 'not-found';
    let caught = null;
    try {
      await scrapeRefresh({
        scrapeScript: FAKE,
        referenceUrl: 'https://developer.salesforce.com/docs/x/references/nope',
        cacheRoot: '/tmp/fake-cache',
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof ScrapeInvocationError);
    assert.equal(caught.exitCode, 1);
    assert.match(caught.stderr, /404/);
  }

  // --- Script file missing -> typed error, exitCode null, message mentions install
  {
    let caught = null;
    try {
      await scrapeRefresh({
        scrapeScript: '/tmp/this/path/does/not/exist.js',
        referenceUrl: 'https://developer.salesforce.com/docs/x/references/orders',
        cacheRoot: '/tmp/fake-cache',
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof ScrapeInvocationError);
    assert.match(caught.message, /install|not found/i);
  }

  // --- Nonzero exit with arbitrary stderr -> typed error, exitCode preserved
  {
    process.env.FAKE_MODE = 'crash';
    let caught = null;
    try {
      await scrapeRefresh({
        scrapeScript: FAKE,
        referenceUrl: 'https://developer.salesforce.com/docs/x/references/orders',
        cacheRoot: '/tmp/fake-cache',
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof ScrapeInvocationError);
    assert.equal(caught.exitCode, 1);
    assert.match(caught.stderr, /unexpected boom/);
  }

  // --- Unexpected stdout (not JSON) -> typed error (exit 0 + garbage stdout)
  {
    process.env.FAKE_MODE = 'ok-nonjson';
    let caught = null;
    try {
      await scrapeRefresh({
        scrapeScript: FAKE,
        referenceUrl: 'https://developer.salesforce.com/docs/x/references/orders',
        cacheRoot: '/tmp/fake-cache',
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof ScrapeInvocationError);
    assert.match(caught.message, /did not print a JSON summary/i);
  }

  // --- force: true adds --force to argv
  {
    process.env.FAKE_MODE = 'ok-refreshed';
    const r = await scrapeRefresh({
      scrapeScript: FAKE,
      referenceUrl: 'https://developer.salesforce.com/docs/x/references/orders',
      cacheRoot: '/tmp/fake-cache',
      force: true,
    });
    assert.ok(Array.isArray(r.rawSummary.argv));
    assert.ok(r.rawSummary.argv.includes('--force'),
      `force=true should add --force to argv, got: ${JSON.stringify(r.rawSummary.argv)}`);
  }

  console.log('ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
