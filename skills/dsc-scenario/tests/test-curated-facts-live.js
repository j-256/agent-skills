'use strict';
// Live premise probe for anchored corrections. A correction OVERRIDES the spec,
// so if the spec it was authored against has drifted, the override may be stale.
// This asserts each anchor still HOLDS against the live spec; a failure here is
// the intended "re-verify this correction" alarm, not a flaky test. The live probe
// is skipped by default -- opt in with DSC_LIVE_TESTS=1 -- but the PROBES-coverage
// guard below runs UNCONDITIONALLY, so a new anchored fact without a probe reddens
// the green suite instead of hiding until someone runs the live gate.
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { B2C_CURATED_FACTS } = require('../lib/b2c-curated-facts.js');

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
  // op-body anchor: reads the BasketPaymentInstrumentRequest request type (via
  // loadType, not opDoc) from the SCAPI shopper-baskets-v2 reference. slug names
  // the op file the loop reads before checkSpecAnchor; addPaymentInstrumentToBasket
  // is that op's own page.
  'scapi-add-payment-instrument-body': {
    referenceUrl: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2',
    slug: 'addPaymentInstrumentToBasket', area: 'commerce_commerce-api', reference: 'shopper-baskets-v2',
  },
};

// OFFLINE coverage guard (runs even without DSC_LIVE_TESTS): every anchored fact
// must have a PROBES entry, or the live gate would HARD-FAIL on the assert.ok(probe)
// below the moment someone opts in. Asserting it here means the drift self-catches
// in the green suite -- a new anchored fact without a probe reddens immediately.
const anchoredIds = B2C_CURATED_FACTS.filter((x) => x.specAnchor).map((x) => x.id);
for (const id of anchoredIds) {
  assert.ok(Object.prototype.hasOwnProperty.call(PROBES, id),
    `add a PROBES entry for '${id}' -- every anchored curated fact needs a live-probe entry`);
}

if (!process.env.DSC_LIVE_TESTS) {
  console.log(`ok (PROBES covers ${anchoredIds.length} anchored facts; set DSC_LIVE_TESTS=1 to probe live correction anchors)`);
  process.exit(0);
}

const { checkSpecAnchor } = require('../lib/auth-providers.js');
const { getReference } = require('../lib/scrape/cache-access.js');
const { resolveReferenceDir } = require('../lib/scrape/resolve-cache.js');

async function main() {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-corrections-live-'));
  for (const c of B2C_CURATED_FACTS.filter((x) => x.specAnchor)) {
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
