'use strict';

// Standing guard: every docs/examples/scenario-*.md trophy's bash block must be
// syntactically valid (offline `bash -n`, always) and -- opt-in -- must RUN to its
// honest signal against the sandbox (DSC_LIVE_TESTS=1). A trophy whose runnable
// can't run cannot ship. Never prints secrets (see _shared/live-order.js contract).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { liveGate, envPresent, writeTemp, runScript, cleanup, clearBasketsSnippet } = require('../lib/live-order.js');

const EXAMPLES_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'examples');

// Extract the single ```bash block from a trophy. Assert exactly one.
function extractBashBlock(file) {
  const md = fs.readFileSync(file, 'utf8');
  const blocks = [];
  const re = /```bash\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1]);
  assert.equal(blocks.length, 1, `${path.basename(file)} must have exactly one \`\`\`bash block (found ${blocks.length})`);
  return blocks[0];
}

// Replace empty VAR="" fill-in assignments with the supplied values (the user's
// fill-in act). Vars not in `vals` stay "" and their :? guard would abort -- so a
// live run must supply every fill-in var. Structure (curl/body/heredoc) untouched.
//
// NOTE on the secret-substitution exception: on the registered path `vals` carries
// SHOPPER_PASS, so this DOES interpolate a secret into the temp script text -- in
// tension with live-order.js's "creds via inherited env, never in script text"
// contract. It is the only workable mechanism here: the trophy ships a literal
// `SHOPPER_PASS=""` fill-in line whose empty value would clobber any env-passed
// secret, so the value must be substituted onto that line to make the block run.
// Safe because the secret never reaches stdout/stderr/assertions (drivers echo only
// masked signals) and the temp file is cleaned up. Do NOT "fix" this back to
// env-passing -- it would leave SHOPPER_PASS="" and break every registered trophy.
function fillVars(block, vals) {
  return block.replace(/^([A-Z0-9_]+)=""(.*)$/gm, (line, name, rest) =>
    (name in vals ? `${name}=${JSON.stringify(vals[name])}${rest}` : line));
}

const TROPHIES = ['scenario-createorder-prereqs', 'scenario-ocapi-submit-basket',
  'scenario-add-coupon-checkout', 'scenario-inreference-prereq'];

// --- OFFLINE GATE (always): bash -n each block ---
for (const name of TROPHIES) {
  const file = path.join(EXAMPLES_DIR, `${name}.md`);
  if (!fs.existsSync(file)) { console.log(`  (skip ${name}: file absent)`); continue; }
  const block = extractBashBlock(file);
  const f = writeTemp(block, '.sh');
  try {
    const res = require('node:child_process').spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${name}: bash -n failed: ${res.stderr}`);
  } finally {
    cleanup([f]);
  }
}
console.log('offline: all present trophy bash blocks pass bash -n');

// --- LIVE GATE (opt-in) ---
if (!liveGate('set DSC_LIVE_TESTS=1 to execute the trophies against the sandbox')) process.exit(0);

// Realm from the environment (DSC_LIVE_REALM in .env, gitignored) with a placeholder
// default so committed source carries no real identifier; org id + OCAPI instance host
// derive from it.
const REALM = process.env.DSC_LIVE_REALM || 'abcd_001';
const SHORT = process.env.SCAPI_SHORTCODE;
const SCAPI_BASE = `https://${SHORT}.api.commercecloud.salesforce.com`;
const OCAPI_BASE = `https://${REALM.replace(/_/g, '-')}.dx.commercecloud.salesforce.com`;
const guestSlas = {
  BASE_URL: SCAPI_BASE, ORGANIZATION_ID: `f_ecom_${REALM}`, SITE_ID: 'RefArch', CHANNEL_ID: 'RefArch',
  CLIENT_ID: process.env.SLAS_PUBLIC_CLIENT_ID, REDIRECT_URI: 'http://localhost:3000/callback',
  PRODUCT_ID: '701642864455M', SHIPPING_METHOD_ID: '001',
};
const registeredSlas = { ...guestSlas,
  SHOPPER_USER: process.env.SHOPPER_USER, SHOPPER_PASS: process.env.SHOPPER_PASS,
  // The add-coupon trophy names its fill-in COUPON_CODE; keep PROMO_CODE too so the
  // map tolerates either rendered name (an unused key is simply never substituted).
  COUPON_CODE: '5ties', PROMO_CODE: '5ties' };

// Per-trophy: required env, fill-in var map, and the honest signal regex.
// Signals match a real VALUE, not just the key -- the trophies' display lines print
// the response through jq, so a failure prints `"orderNo": null` / an empty
// `paymentInstruments[]`. Matching the populated value (a numeric order no, a
// paymentInstrumentId) means a 4xx/empty result FAILS the gate instead of false-passing
// on the key alone.
const LIVE = {
  'scenario-createorder-prereqs': {
    required: ['SCAPI_SHORTCODE', 'SLAS_PUBLIC_CLIENT_ID'], vals: guestSlas,
    signal: /"orderNo":\s*"[0-9]+"/, what: 'order placed',
  },
  'scenario-ocapi-submit-basket': {
    required: ['CLIENT_ID_OCAPI'],
    // The OCAPI trophy renders a POPULATED basket (product + shipping method), so
    // it carries PRODUCT_ID/SHIPPING_METHOD_ID fill-ins like the SCAPI one -- not
    // just the 3 connection vars. Same known-good RefArch inputs.
    vals: {
      BASE_URL: OCAPI_BASE, SITE_ID: 'RefArch', CLIENT_ID: process.env.CLIENT_ID_OCAPI,
      PRODUCT_ID: '701642864455M', SHIPPING_METHOD_ID: '001',
    },
    signal: /"order_no":\s*"[0-9]+"/, what: 'order placed',
  },
  'scenario-add-coupon-checkout': {
    required: ['SCAPI_SHORTCODE', 'SLAS_PUBLIC_CLIENT_ID', 'SHOPPER_USER', 'SHOPPER_PASS'],
    vals: registeredSlas, signal: /"orderNo":\s*"[0-9]+"/, what: 'order placed + coupon accepted',
    cleanupRegistered: true,
  },
  'scenario-inreference-prereq': {
    required: ['SCAPI_SHORTCODE', 'SLAS_PUBLIC_CLIENT_ID', 'SHOPPER_USER', 'SHOPPER_PASS'],
    vals: registeredSlas, signal: /"paymentInstrumentId":\s*"[^"]+"/, what: 'payment instrument added',
    cleanupRegistered: true,
  },
};

// The registered trophies run as the SAME shared test shopper, whose per-customer
// basket quota is small -- so back-to-back registered runs exhaust it and the second
// one can't create a basket. Before each registered trophy, clear that shopper's
// baskets (mint a registered token via the SLAS PKCE flow, then clearBasketsSnippet).
// Makes the live suite idempotent + re-runnable. Guest trophies don't need this (a
// fresh guest customer per token). Emits only masked cleanup signals.
function clearRegisteredBaskets() {
  const script = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `BASE="${SCAPI_BASE}"`, `ORG="f_ecom_${REALM}"`, 'SITE="RefArch"', 'CH="RefArch"',
    'CV=$(openssl rand -base64 96 | tr -d \'=\\n\' | tr \'+/\' \'-_\')',
    'CC=$(printf %s "$CV" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d \'=\\n\' | tr \'+/\' \'-_\')',
    'LOC=$(curl -sS -o /dev/null -w \'%{redirect_url}\' -X POST "$BASE/shopper/auth/v1/organizations/$ORG/oauth2/login" \\',
    '  -H "Authorization: Basic $(printf \'%s:%s\' "$SHOPPER_USER" "$SHOPPER_PASS" | base64)" \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  --data-urlencode "code_challenge=$CC" --data-urlencode "channel_id=$CH" \\',
    '  --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "redirect_uri=$REDIRECT_URI")',
    "CODE=$(printf '%s' \"$LOC\" | grep -oE 'code=[^&]+' | cut -d= -f2)",
    "USID=$(printf '%s' \"$LOC\" | grep -oE 'usid=[^&]+' | cut -d= -f2)",
    'TOKEN=$(curl -sS -X POST "$BASE/shopper/auth/v1/organizations/$ORG/oauth2/token" \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  --data-urlencode "grant_type=authorization_code_pkce" --data-urlencode "code=$CODE" \\',
    '  --data-urlencode "code_verifier=$CV" --data-urlencode "client_id=$CLIENT_ID" \\',
    "  --data-urlencode \"redirect_uri=$REDIRECT_URI\" --data-urlencode \"channel_id=$CH\" --data-urlencode \"usid=$USID\" | jq -r '.access_token // empty')",
    'if [ -z "$TOKEN" ]; then echo "basket-cleanup: token mint failed (skip)"; exit 0; fi',
    clearBasketsSnippet({ verBase: 'checkout/shopper-baskets/v2' }),
  ].join('\n');
  const env = {
    SHOPPER_USER: process.env.SHOPPER_USER, SHOPPER_PASS: process.env.SHOPPER_PASS,
    CLIENT_ID: process.env.SLAS_PUBLIC_CLIENT_ID, REDIRECT_URI: 'http://localhost:3000/callback',
  };
  const res = runScript(script, env, { timeout: 90000 });
  const last = (res.stdout || '').trim().split('\n').pop() || '';
  console.log(`  (basket-cleanup before registered trophy: ${last})`);
}

let ran = 0;
for (const name of TROPHIES) {
  const cfg = LIVE[name];
  const file = path.join(EXAMPLES_DIR, `${name}.md`);
  if (!fs.existsSync(file)) { console.log(`  (skip ${name}: file absent)`); continue; }
  // Map required var names present-check via envPresent-compatible shape.
  if (!envPresent({ required: cfg.required })) { console.log(`  (skip ${name}: creds absent)`); continue; }
  // Idempotency: clear the shared registered shopper's baskets before a registered
  // trophy so the per-customer basket quota does not carry over from a prior run.
  if (cfg.cleanupRegistered) { clearRegisteredBaskets(); }
  const block = extractBashBlock(file);
  // Assert on the signal the trophy's runnable already prints -- createorder/coupon
  // echo orderNo, ocapi echoes order_no, inreference dumps the basket
  // (paymentInstruments). Run the FILLED block and scan combined stdout, no edit to
  // the block's structure.
  const filled = fillVars(block, cfg.vals);
  const res = runScript(filled, {}, { timeout: 180000 });
  assert.match(res.stdout + res.stderr, cfg.signal,
    `${name}: expected ${cfg.what}; stdout=${res.stdout.slice(-400)} stderr=${res.stderr.slice(-200)}`);
  if (name === 'scenario-add-coupon-checkout') {
    assert.match(res.stdout, /"valid"\s*:\s*true/, 'coupon accepted (valid:true)');
  }
  console.log(`  ${name}: ${cfg.what}`);
  ran++;
}
assert.ok(ran > 0, 'at least one trophy must be live-verifiable with creds present');
console.log(`ok (offline bash -n all; live-verified ${ran} trophies)`);
