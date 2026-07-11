'use strict';

// Live grounding for the rendered nested body: build the submittable body from the
// REAL registry (buildSkeleton over each entry's leaves), substitute the two
// instance-ref placeholders (a real RefArch catalog productId + a configured
// shippingMethod id), EXECUTE the createBasket -> createOrder flow, and assert an
// ORDER IS PLACED with zero edits to the emitted body structure. Opt-in
// (DSC_LIVE_TESTS=1). This is the empirical gate the spec sets: the emitted body
// must place an order verbatim. Reddens on drift by design -- the maintainer
// re-verify alarm, not a flake. Never prints secret values (masks to lengths /
// non-secret order numbers only).
//
// It also encodes the Task-8 drop-one FINDING as a live, self-invalidating pair:
//   POSITIVE  the finalized minimal body (card = cardType only; no holder/expiry)
//             places an order -> proves holder/expiry are ABOVE the minimum.
//   NEGATIVE  the same body with the card-type field removed does NOT place an
//             order (400 Invalid Payment Method Id) -> proves cardType is REQUIRED.
// Together they assert the shipped card sub-shape is both sufficient and minimal at
// the card boundary. Drop-one verified on realm abcd_001, site RefArch, v25_6
// (RefArch v25_6) on 2026-07-11.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// GATE FIRST -- before any require of skill code or any credential read, so the
// offline suite stays green with only this message.
if (!process.env.DSC_LIVE_TESTS) {
  console.log('ok (skipped: set DSC_LIVE_TESTS=1 to execute the rendered body against the sandbox)');
  process.exit(0);
}

const { SUBMITTABILITY } = require('../scripts/submittability-registry.js');
const { buildSkeleton } = require('../scripts/build-body.js');
const { resolveLeafValue } = require('../lib/body-values.js');

// Non-secret RefArch catalog inputs, discovered live on abcd_001 (product_search +
// the shipment shipping-methods lookup) and safe to commit as test inputs:
//   PRODUCT_ID         an orderable variant of "Button Down Shirt" (master 25518647M)
//   SHIPPING_METHOD_ID "001" == Ground, an applicable method on shipment "me"
// Overridable via env for a different realm/catalog.
const PRODUCT_ID = process.env.PRODUCT_ID || '701642864455M';
const SHIPPING_METHOD_ID = process.env.SHIPPING_METHOD_ID || '001';

// Substitute the two instance-ref placeholders the renderer leaves as ${...} --
// exactly the fill-in a user pasting the runnable would perform.
function fillPlaceholders(json) {
  return json
    .replace(/\$\{PRODUCT_ID\}/g, PRODUCT_ID)
    .replace(/\$\{SHIPPING_METHOD_ID\}/g, SHIPPING_METHOD_ID);
}

// The two headless order-placement drivers, as linear bash (no functions, so no
// multi-var locals). Credentials are read from the inherited environment at
// runtime by bash (${VAR}); they are never interpolated into the script text and
// never echoed. Each driver prints ONE masked signal on stdout:
//   ORDER_OK no=<orderNo>   (orderNo is a non-secret sequence number)
//   ORDER_FAIL http=<code>  |  BASKET_FAIL  |  TOKEN_EMPTY
// The body is read from $BODY_FILE (-d @file); the order response is dumped to
// $RESP_FILE so the http code + order number can be read without printing the body.
const OCAPI_DRIVER = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  // OCAPI is served from the INSTANCE host, not the SCAPI shortcode edge (verified
  // in the sibling auth live test); guest JWT arrives in the response Authorization
  // header.
  'BASE="https://abcd-001.dx.commercecloud.salesforce.com/s/RefArch/dw/shop/v25_6"',
  'AUTH_HEADERS=$(curl -sS -D - -o /dev/null -X POST \\',
  '  "$BASE/customers/auth?client_id=${CLIENT_ID_OCAPI}" \\',
  '  -H "Content-Type: application/json" -d \'{"type":"guest"}\')',
  "TOKEN=$(printf '%s' \"$AUTH_HEADERS\" | grep -i '^authorization:' | sed 's/^[Aa]uthorization: *[Bb]earer *//' | tr -d '\\r' || true)",
  'if [ -z "$TOKEN" ]; then echo "TOKEN_EMPTY"; exit 0; fi',
  'BID=$(curl -sS -X POST "$BASE/baskets?client_id=${CLIENT_ID_OCAPI}" \\',
  '  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
  "  -d @\"$BODY_FILE\" | jq -r '.basket_id // empty')",
  'if [ -z "$BID" ]; then echo "BASKET_FAIL"; exit 0; fi',
  'ORD=$(curl -sS -o "$RESP_FILE" -w \'%{http_code}\' -X POST "$BASE/orders?client_id=${CLIENT_ID_OCAPI}" \\',
  '  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
  '  -d "{\\"basket_id\\":\\"$BID\\"}")',
  "NO=$(jq -r '.order_no // empty' \"$RESP_FILE\")",
  'if [ -n "$NO" ]; then echo "ORDER_OK no=$NO"; else echo "ORDER_FAIL http=$ORD fault=$(jq -r \'.fault.type // empty\' "$RESP_FILE")"; fi',
].join('\n');

const SCAPI_DRIVER = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  'ORG="f_ecom_abcd_001"',
  'SITE="RefArch"',
  'BASE="https://${SCAPI_SHORTCODE}.api.commercecloud.salesforce.com"',
  // SLAS private client mints a guest shopper token headlessly (client_credentials,
  // HTTP Basic). Prefer a realm-scoped var if present, else the base var.
  'PCID="${SLAS_PRIVATE_CLIENT_ID_abcd_001:-${SLAS_PRIVATE_CLIENT_ID}}"',
  'PSEC="${SLAS_PRIVATE_CLIENT_SECRET_abcd_001:-${SLAS_PRIVATE_CLIENT_SECRET}}"',
  'TOKEN=$(curl -sS -X POST "$BASE/shopper/auth/v1/organizations/$ORG/oauth2/token" \\',
  '  -H "Authorization: Basic $(printf \'%s:%s\' "$PCID" "$PSEC" | base64)" \\',
  '  -H "Content-Type: application/x-www-form-urlencoded" \\',
  '  --data-urlencode "grant_type=client_credentials" \\',
  "  --data-urlencode \"channel_id=$SITE\" | jq -r '.access_token // empty')",
  'if [ -z "$TOKEN" ]; then echo "TOKEN_EMPTY"; exit 0; fi',
  'BID=$(curl -sS -X POST "$BASE/checkout/shopper-baskets/v1/organizations/$ORG/baskets?siteId=$SITE" \\',
  '  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
  "  -d @\"$BODY_FILE\" | jq -r '.basketId // empty')",
  'if [ -z "$BID" ]; then echo "BASKET_FAIL"; exit 0; fi',
  'ORD=$(curl -sS -o "$RESP_FILE" -w \'%{http_code}\' -X POST "$BASE/checkout/shopper-orders/v1/organizations/$ORG/orders?siteId=$SITE" \\',
  '  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
  '  -d "{\\"basketId\\":\\"$BID\\"}")',
  "NO=$(jq -r '.orderNo // empty' \"$RESP_FILE\")",
  'if [ -n "$NO" ]; then echo "ORDER_OK no=$NO"; else echo "ORDER_FAIL http=$ORD"; fi',
].join('\n');

// Per-registry-key config: how to reach the family, and where the payment-card
// type field lives in the built body (for the drop-cardType negative case).
const FAMILIES = {
  Basket: {
    label: 'SCAPI',
    driver: SCAPI_DRIVER,
    requiredEnv: ['SCAPI_SHORTCODE'],
    // Either a realm-scoped OR a base SLAS private client pair must be present.
    requiredEnvEither: [
      ['SLAS_PRIVATE_CLIENT_ID_abcd_001', 'SLAS_PRIVATE_CLIENT_ID'],
      ['SLAS_PRIVATE_CLIENT_SECRET_abcd_001', 'SLAS_PRIVATE_CLIENT_SECRET'],
    ],
    piKey: 'paymentInstruments',
    cardKey: 'paymentCard',
    typeKey: 'cardType',
  },
  basket: {
    label: 'OCAPI',
    driver: OCAPI_DRIVER,
    requiredEnv: ['CLIENT_ID_OCAPI'],
    requiredEnvEither: [],
    piKey: 'payment_instruments',
    cardKey: 'payment_card',
    typeKey: 'card_type',
  },
};

function envPresent(cfg) {
  for (const v of cfg.requiredEnv) {
    if (!process.env[v]) return false;
  }
  for (const alts of cfg.requiredEnvEither) {
    if (!alts.some((v) => process.env[v])) return false;
  }
  return true;
}

// Run a driver against a body object; returns the driver's single masked signal.
function placeOrder(cfg, bodyObj) {
  const bodyFile = path.join(os.tmpdir(), `dsc-body-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const respFile = path.join(os.tmpdir(), `dsc-resp-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const scriptFile = path.join(os.tmpdir(), `dsc-body-live-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(bodyFile, JSON.stringify(bodyObj));
  fs.writeFileSync(scriptFile, cfg.driver);
  const res = spawnSync('bash', [scriptFile], {
    encoding: 'utf8',
    env: { ...process.env, BODY_FILE: bodyFile, RESP_FILE: respFile },
    timeout: 120000,
  });
  for (const f of [bodyFile, respFile, scriptFile]) {
    try { fs.unlinkSync(f); } catch (_e) { /* best-effort cleanup */ }
  }
  return res;
}

function main() {
  let placedFamilies = 0;

  for (const [key, entry] of Object.entries(SUBMITTABILITY)) {
    const cfg = FAMILIES[key];
    assert.ok(cfg, `live-test config exists for registry key '${key}'`);

    if (!envPresent(cfg)) {
      console.log(`  (skipped ${cfg.label}: required creds not in env)`);
      continue;
    }

    // Build the finalized body from the SAME leaves the renderer ships, then fill
    // the two instance-ref placeholders. This is the shipped shape, verbatim.
    const positive = JSON.parse(fillPlaceholders(JSON.stringify(buildSkeleton(entry.leaves, resolveLeafValue))));

    // POSITIVE: the finalized minimal body places an order.
    const pos = placeOrder(cfg, positive);
    assert.match(
      pos.stdout, /ORDER_OK no=\d+/,
      `${cfg.label}: finalized body must place an order verbatim; stdout=${pos.stdout} stderr=${pos.stderr}`,
    );

    // NEGATIVE: drop the card-type field from the built card object; the order must
    // NOT place (encodes "cardType is REQUIRED", the drop-one result). Clone first
    // so the positive body is untouched.
    const negative = JSON.parse(JSON.stringify(positive));
    const pi = negative[cfg.piKey] && negative[cfg.piKey][0];
    assert.ok(pi && pi[cfg.cardKey], `${cfg.label}: built body has ${cfg.piKey}[0].${cfg.cardKey}`);
    delete pi[cfg.cardKey][cfg.typeKey];
    const neg = placeOrder(cfg, negative);
    assert.doesNotMatch(
      neg.stdout, /ORDER_OK/,
      `${cfg.label}: dropping ${cfg.typeKey} must PREVENT order placement (cardType is required); stdout=${neg.stdout} stderr=${neg.stderr}`,
    );

    console.log(`  ${cfg.label}: finalized body placed an order; dropping ${cfg.typeKey} was rejected (${neg.stdout.trim()})`);
    placedFamilies++;
  }

  assert.ok(placedFamilies > 0, 'at least one family must be reachable to verify the card sub-shape live');
  console.log(`ok (verified the finalized card sub-shape against the sandbox in ${placedFamilies} family/families)`);
}

main();
