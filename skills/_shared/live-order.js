'use strict';

// Shared plumbing for the opt-in live tests (test-auth-render-live, test-body-render-live,
// test-examples-runnable). Factors out the DSC_LIVE_TESTS gate, ephemeral-script
// execution, and the env-presence check so the never-print-secrets contract lives in
// ONE place.
//
// NEVER-PRINT-SECRETS CONTRACT (inherited by every consumer):
//   - Driver scripts use `set -uo pipefail`, NEVER `set -x` (tracing would echo secrets).
//   - Secrets appear ONLY as `Bearer $TOKEN` or base64'd inline (`printf '%s:%s' ... | base64`),
//     never assigned to an echoed variable, never printed.
//   - Stdout carries ONLY masked signals: `TOKEN_OK len=<n>`, `ORDER_OK no=<orderNo>`,
//     `*_FAIL`, and non-secret catalog/order ids. Assert on those, not on secrets.
//   - Credentials reach the child via the inherited environment (spawnSync env), never
//     interpolated into the script text.

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Load repo-root .env into process.env for live-test credentials, gap-fill only: a var
// already set in the environment always wins. JS twin of the harness's own dependency-free
// .env parser (harness/stream_eval/env.py) -- same rule, so keep the two in sync.
function loadDotEnv() {
  // Walk up from this file to find the repo root .env (tests run from varying cwds).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      let text;
      try { text = fs.readFileSync(candidate, 'utf8'); } catch (_e) { return; }
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        if (key in process.env) continue; // real env wins -- gap-fill only
        let val = line.slice(eq + 1).trim();
        if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadDotEnv();

// Opt-in gate. Returns false + prints a skip line when DSC_LIVE_TESTS is unset, so the
// offline suite stays green with only the skip message. Callers: `if (!liveGate(msg)) return;`
// (or `... process.exit(0);` to preserve an existing early-exit shape).
function liveGate(skipMessage) {
  if (!process.env.DSC_LIVE_TESTS) {
    console.log(`ok (skipped: ${skipMessage})`);
    return false;
  }
  return true;
}

// True iff every var in `required` is set AND every alt-group in `either` has >=1 set.
function envPresent({ required = [], either = [] } = {}) {
  for (const v of required) {
    if (!process.env[v]) return false;
  }
  for (const alts of either) {
    if (!alts.some((v) => process.env[v])) return false;
  }
  return true;
}

function writeTemp(contents, ext = '.sh') {
  const p = path.join(os.tmpdir(), `dsc-live-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, contents);
  return p;
}

function cleanup(paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch (_e) { /* best-effort */ }
  }
}

// Write scriptText to a tmp file, run it under bash with env merged onto process.env,
// return {stdout, stderr, status}. Best-effort cleanup.
function runScript(scriptText, env = {}, { timeout = 120000 } = {}) {
  const f = writeTemp(scriptText, '.sh');
  try {
    return spawnSync('bash', [f], { encoding: 'utf8', env: { ...process.env, ...env }, timeout });
  } finally {
    cleanup([f]);
  }
}

// Bash-snippet builder: clear a shopper's existing baskets so a live run does not hit
// the per-customer basket quota (a registered test shopper accumulates baskets across
// runs; guest customers accumulate too, just not shared). Shopper Baskets has no
// list-my-baskets op, so this uses the create->quota-fault->delete loop: attempt a
// createBasket; on the "Customer Baskets Quota Exceeded" fault the detail names the
// blocking basket id in parens, so delete that and retry; once a create succeeds the
// quota has room, so delete that fresh basket too and stop. Expects $TOKEN + $BASE (the
// SCAPI edge base) + $ORG + $SITE already set in the surrounding script. Emits nothing
// secret (only truncated basket-id prefixes). `verBase` is the shopper-baskets version
// path segment (e.g. checkout/shopper-baskets/v2).
function clearBasketsSnippet({ verBase = 'checkout/shopper-baskets/v2' } = {}) {
  return [
    '# --- basket-quota cleanup (idempotent; no list op exists, so create/parse-fault/delete) ---',
    'for _i in $(seq 1 25); do',
    `  _R=$(curl -sS -X POST "$BASE/${verBase}/organizations/$ORG/baskets?siteId=$SITE" \\`,
    '    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")',
    "  _BID=$(printf '%s' \"$_R\" | jq -r '.basketId // empty')",
    '  if [ -n "$_BID" ]; then',
    `    curl -sS -o /dev/null -X DELETE "$BASE/${verBase}/organizations/$ORG/baskets/$_BID?siteId=$SITE" -H "Authorization: Bearer $TOKEN"`,
    '    echo "basket-cleanup: quota clear"; break',
    '  fi',
    "  _DEL=$(printf '%s' \"$_R\" | jq -r '.detail // empty' | grep -oE '\\(([0-9a-f]+)\\)' | tr -d '()' | head -1)",
    '  if [ -z "$_DEL" ]; then echo "basket-cleanup: nothing to clear"; break; fi',
    `  curl -sS -o /dev/null -X DELETE "$BASE/${verBase}/organizations/$ORG/baskets/$_DEL?siteId=$SITE" -H "Authorization: Bearer $TOKEN"`,
    '  echo "basket-cleanup: freed ${_DEL:0:8}"',
    'done',
  ].join('\n');
}

module.exports = { liveGate, envPresent, writeTemp, cleanup, runScript, clearBasketsSnippet };
