'use strict';

const assert = require('node:assert/strict');
const { STANDARD_SHOPPER_SCOPES } = require('../shared/products/commerce-b2c/dedupe-scopes.js');

if (process.env.SKIP_NETWORK_TESTS) {
  console.log('skipped (SKIP_NETWORK_TESTS set)');
  process.exit(0);
}

const URL = 'https://developer.salesforce.com/docs/commerce/commerce-api/guide/standard-shopper-scope.html';

// Network-failure sentinel. The test treats reachability problems
// (DNS, TCP, TLS, 5xx) as "skip, don't fail" so a developer.salesforce.com
// outage doesn't break unrelated CI; only a successful fetch with drifted
// content fails the assertion.
class NetworkUnreachable extends Error {
  constructor(reason) { super(reason); this.name = 'NetworkUnreachable'; }
}

async function fetchHtml(url) {
  // Node 18+ has global fetch.
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new NetworkUnreachable(`fetch ${url} threw: ${e.message}`);
  }
  if (res.status >= 500) {
    throw new NetworkUnreachable(`fetch ${url} returned ${res.status} ${res.statusText}`);
  }
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function extractScopes(html) {
  // Scopes are listed as `sfcc.<segment>` or `sfcc.<segment>.rw`. They appear
  // inside <code> tags, but raw regex over the HTML is more resilient than
  // parsing -- the surrounding markup may change. Match conservatively.
  const matches = html.match(/sfcc\.[a-z0-9_-]+(?:\.[a-z]+)*(?:\.rw)?/g) || [];
  return [...new Set(matches)].sort();
}

(async () => {
  const html = await fetchHtml(URL);
  const found = extractScopes(html);

  // STANDARD_SHOPPER_SCOPES might not be sorted (its order matches the guide's
  // published order); compare as sets.
  const expected = [...STANDARD_SHOPPER_SCOPES].sort();

  // Filter found list to scopes the snapshot includes -- the page may also
  // mention scopes outside the standard-shopper set in passing (e.g. session
  // bridge in counter-examples). The freshness contract is: every scope in
  // our snapshot still appears on the page, and no scope on the page is
  // missing from our snapshot when it's in the meta-scope's expansion.
  // Keep the assertion bidirectional but explicit:
  const expectedSet = new Set(expected);
  const foundSet = new Set(found);

  // (1) Every snapshot scope appears on the page.
  const missing = expected.filter((s) => !foundSet.has(s));
  assert.deepEqual(missing, [],
    `STANDARD_SHOPPER_SCOPES has ${missing.length} scope(s) the page no longer lists: ${missing.join(', ')}`);

  // (2) Page lists no scopes that look meta-scope-shaped (sfcc.shopper-*) and
  // aren't in the snapshot. Non-shopper sfcc.* scopes (sfcc.session_bridge,
  // sfcc.pwdless_login) are excluded by name -- they're discussed on the page
  // as scopes you'd append separately, not as members of the meta-scope.
  // sfcc.shopper-standard is also excluded -- it's the meta-scope's own name,
  // not an expansion member.
  const NON_MEMBER_SCOPES = new Set([
    'sfcc.session_bridge',
    'sfcc.pwdless_login',
    'sfcc.shopper-standard',
  ]);
  const newMembers = found.filter((s) =>
    /^sfcc\.shopper-/.test(s) && !expectedSet.has(s) && !NON_MEMBER_SCOPES.has(s)
  );
  assert.deepEqual(newMembers, [],
    `Page lists ${newMembers.length} sfcc.shopper-* scope(s) not in STANDARD_SHOPPER_SCOPES: ${newMembers.join(', ')}. ` +
    `Update shared/products/commerce-b2c/dedupe-scopes.js and bump the snapshot date.`);

  console.log('ok');
})().catch((e) => {
  if (e instanceof NetworkUnreachable) {
    // Network failure: emit a skip log and exit 0 so a transient
    // developer.salesforce.com outage doesn't break unrelated CI.
    // Real drift (snapshot vs. live page mismatch) still throws as an
    // AssertionError, which keeps the assertion path strict.
    console.log(`skipped (network unreachable: ${e.message})`);
    process.exit(0);
  }
  console.error(e.stack || e.message);
  process.exit(1);
});
