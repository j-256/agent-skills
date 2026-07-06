'use strict';
// Live premise probe for anchored corrections. A correction OVERRIDES the spec,
// so if the spec it was authored against has drifted, the override may be stale.
// This asserts each anchor still HOLDS against the live spec; a failure here is
// the intended "re-verify this correction" alarm, not a flaky test. Skipped by
// default -- opt in with DSC_LIVE_TESTS=1.
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

if (!process.env.DSC_LIVE_TESTS) {
  console.log('ok (skipped: set DSC_LIVE_TESTS=1 to probe live correction anchors)');
  process.exit(0);
}

const { B2C_CORRECTIONS } = require('../lib/b2c-corrections.js');
const { checkSpecAnchor } = require('../lib/auth-providers.js');
const { getReference } = require('../lib/scrape/cache-access.js');
const { resolveReferenceDir } = require('../lib/scrape/resolve-cache.js');

// Map each anchored correction to the reference URL + a representative target op
// whose identity its match() accepts. Kept explicit (not derived) so the probe is
// legible and a new correction forces a conscious entry here.
const PROBES = {
  'auth-admin-sandbox-api-user': {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/auth-admin',
    slug: 'retrieveTenant', area: 'commerce_commerce-api', reference: 'auth-admin',
  },
  'ocapi-create-body-masked-number': {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets',
    slug: 'post-baskets', area: 'commerce_b2c-commerce', reference: 'ocapi-shop-baskets',
  },
};

async function main() {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-corrections-live-'));
  for (const c of B2C_CORRECTIONS.filter((x) => x.specAnchor)) {
    const probe = PROBES[c.id];
    assert.ok(probe, `no live PROBE entry for anchored correction '${c.id}' -- add one`);
    await getReference({ referenceUrl: probe.referenceUrl, cacheRoot });
    const { dir } = resolveReferenceDir(cacheRoot, probe.reference, { area: probe.area });
    const opDoc = JSON.parse(fs.readFileSync(path.join(dir, `${probe.slug}.json`), 'utf8'));
    const { state, now } = checkSpecAnchor(c.specAnchor, {
      opDoc, cacheRoot, area: probe.area, reference: probe.reference,
    });
    assert.equal(state, 'holds',
      `correction '${c.id}' anchor no longer holds against the LIVE spec -- re-verify. saw="${c.specAnchor.saw}", now=${JSON.stringify(now)}`);
  }
  console.log(`ok (probed ${Object.keys(PROBES).length} live correction anchors)`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
