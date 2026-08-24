'use strict';

// Live grounding for the rendered auth preamble: build each branch's preamble
// from the real resolver, substitute sandbox creds, EXECUTE it, assert a token is
// minted. Opt-in (DSC_LIVE_TESTS=1). Reddens on upstream drift by design -- the
// maintainer re-verify alarm, not a flake. Never prints secret values.
const assert = require('node:assert/strict');
const { liveGate, runScript } = require('../shared/common/live-test.js');

if (!liveGate('set DSC_LIVE_TESTS=1 to execute rendered auth preambles against the sandbox')) process.exit(0);

const { renderAuthPreamble } = require('../shared/products/commerce-b2c/auth-render.js');

// Wrap a rendered preamble in a runnable that echoes ONLY a masked success signal
// (never the token). We assert on the signal, not the secret.
function runPreamble(lines, env) {
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...lines,
    // Success = a non-empty ACCESS_TOKEN. Print only its length + a mask.
    'if [ -n "${ACCESS_TOKEN:-}" ] && [ "$ACCESS_TOKEN" != "null" ]; then echo "TOKEN_OK len=${#ACCESS_TOKEN}"; else echo "TOKEN_EMPTY"; fi',
  ].join('\n');
  return runScript(script, env, { timeout: 60000 });
}

async function main() {
  // Instance from the environment (DSC_LIVE_INSTANCE in .env, gitignored) with a placeholder
  // default so committed source carries no real identifier. The SCAPI edge host serves
  // SLAS; OCAPI is served from the instance host (a different origin -- a bare shortcode
  // host 404s the /s/{site}/dw/ path), whose subdomain is the instance with underscores
  // hyphenated.
  const instance = process.env.DSC_LIVE_INSTANCE || 'abcd_001';
  const shortCode = process.env.SCAPI_SHORTCODE;
  const baseUrl = `https://${shortCode}.api.commercecloud.salesforce.com`;
  const instanceBaseUrl = `https://${instance.replace(/_/g, '-')}.dx.commercecloud.salesforce.com`;
  let probed = 0;

  // --- AM app token (client_credentials; groundable with the app client alone) ---
  // The `am` branch renders a SCAPI Admin token: scope=SALESFORCE_COMMERCE_API:<tenant>.
  // That role is held by the SCAPI-registered client (CLIENT_ID_SCAPI), NOT the
  // OCAPI-Data client -- verified live: the OCAPI pair authenticates but 403s the
  // tenant scope (invalid_scope, not invalid_client). The 7-day-old memory
  // conflated the two AM-token clients; this reconciles the probe to the client
  // that actually carries the role.
  // Each probe self-skips when its creds are absent (like the SLAS probe below), so a
  // maintainer with only a partial cred set gets clean skips, not a hard failure.
  if (process.env.CLIENT_ID_SCAPI && process.env.CLIENT_SECRET_SCAPI) {
    const plan = {
      authBranch: 'am',
      authFlow: { tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token', grantType: 'client_credentials' },
      auth: { branch: 'am' }, combinedScopes: [], steps: [],
    };
    const pre = renderAuthPreamble(plan);
    const res = runPreamble(pre.lines, {
      AM_CLIENT_ID: process.env.CLIENT_ID_SCAPI,
      AM_CLIENT_SECRET: process.env.CLIENT_SECRET_SCAPI,
      AM_TENANT: instance,
    });
    assert.match(res.stdout, /TOKEN_OK/, `AM app token should mint; stdout=${res.stdout} stderr=${res.stderr}`);
    probed++;
  } else {
    console.log('  (skipped AM probe: CLIENT_ID_SCAPI / CLIENT_SECRET_SCAPI not in env)');
  }

  // --- OCAPI customers/auth guest (app client + a shop base) ---
  if (process.env.CLIENT_ID_OCAPI) {
    const plan = {
      authBranch: 'ocapi-shop',
      auth: { branch: 'ocapi-shop', tier: 'shopper', token: { flow: 'ocapi-customers-auth', reference: 'ocapi-shop-customers', slug: 'post-customers-auth', body: { type: 'guest' }, tokenIn: 'response-header' } },
      combinedScopes: [], steps: [{ basePath: '/s/{siteId}/dw/shop/v25_6' }],
    };
    const pre = renderAuthPreamble(plan);
    // OCAPI is served from the INSTANCE host, not the SCAPI shortcode edge --
    // verified live: the shortcode host 404s the /s/{site}/dw/shop path, the
    // instance host returns 200 with the JWT in the Authorization header.
    const res = runPreamble(pre.lines, {
      BASE_URL: instanceBaseUrl, SITE_ID: 'RefArch', CLIENT_ID: process.env.CLIENT_ID_OCAPI,
    });
    assert.match(res.stdout, /TOKEN_OK/, `OCAPI guest JWT should mint; stdout=${res.stdout} stderr=${res.stderr}`);
    probed++;
  } else {
    console.log('  (skipped OCAPI-guest probe: CLIENT_ID_OCAPI not in env)');
  }

  // --- SLAS guest (best-effort: needs a public client + redirect URI) ---
  if (process.env.SLAS_PUBLIC_CLIENT_ID && process.env.SLAS_REDIRECT_URI) {
    const plan = {
      authBranch: 'shopper-slas',
      authFlow: { slugs: ['authorizeCustomer', 'getAccessToken'], authorizeHint: 'guest', grantType: 'authorization_code_pkce' },
      auth: { branch: 'shopper-slas' }, combinedScopes: [], steps: [],
    };
    const pre = renderAuthPreamble(plan);
    const res = runPreamble(pre.lines, {
      BASE_URL: baseUrl, ORGANIZATION_ID: `f_ecom_${instance}`,
      CLIENT_ID: process.env.SLAS_PUBLIC_CLIENT_ID, REDIRECT_URI: process.env.SLAS_REDIRECT_URI,
    });
    assert.match(res.stdout, /TOKEN_OK/, `SLAS guest token should mint; stdout=${res.stdout} stderr=${res.stderr}`);
    probed++;
  } else {
    console.log('  (skipped SLAS-guest probe: no public client / redirect URI in env)');
  }

  console.log(`ok (executed ${probed} rendered auth preambles against the sandbox)`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
