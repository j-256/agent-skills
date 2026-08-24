'use strict';

const assert = require('node:assert/strict');
const { scanFillInVars } = require('../scripts/curl-block.js');

// ACCESS_TOKEN assigned by the preamble -> excluded; CLIENT_ID referenced-only -> included.
{
  const body = [
    'ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)',
    'curl "${BASE_URL}/x?client_id=${CLIENT_ID}" -H "Authorization: Bearer ${ACCESS_TOKEN}"',
  ].join('\n');
  const vars = scanFillInVars(body);
  assert.ok(vars.includes('BASE_URL'), 'BASE_URL referenced-only -> fill-in');
  assert.ok(vars.includes('CLIENT_ID'), 'CLIENT_ID referenced-only -> fill-in');
  assert.ok(!vars.includes('ACCESS_TOKEN'), 'ACCESS_TOKEN assigned -> excluded');
  assert.ok(!vars.includes('TOKEN_RESPONSE'), 'TOKEN_RESPONSE assigned -> excluded');
}

// PKCE internals + producer captures excluded.
{
  const body = [
    "CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\\n' | tr '+/' '-_')",
    'BASKET_ID=$(echo "$POST_BASKETS_RESPONSE" | jq -r .basket_id)',
    'curl "${BASE_URL}/orders" -d "{\\"basketId\\":\\"${BASKET_ID}\\"}" -d "cv=${CODE_VERIFIER}"',
  ].join('\n');
  const vars = scanFillInVars(body);
  assert.ok(!vars.includes('CODE_VERIFIER'), 'CODE_VERIFIER script-assigned -> excluded');
  assert.ok(!vars.includes('BASKET_ID'), 'BASKET_ID producer-assigned -> excluded');
  assert.deepEqual(vars, ['BASE_URL'], 'only the genuinely-external var remains');
}

// Federated AUTH_CODE: referenced but NOT assigned -> included (the fill-in seam).
{
  const body = [
    'echo "paste the code into AUTH_CODE below"',
    'curl "${BASE_URL}/token" --data-urlencode "code=${AUTH_CODE}"',
  ].join('\n');
  const vars = scanFillInVars(body);
  assert.ok(vars.includes('AUTH_CODE'), 'unassigned AUTH_CODE -> fill-in (federated seam)');
}

// First-appearance order, deduped.
{
  const body = 'a "${ONE}" b "${TWO}" c "${ONE}" d "${THREE}"';
  assert.deepEqual(scanFillInVars(body), ['ONE', 'TWO', 'THREE']);
}

console.log('ok');
