'use strict';

const assert = require('node:assert/strict');
const { decodeJwtScopes, DecodeError } = require('../scripts/decode-token.js');

// Build a JWT with `scp` claim. Format: base64url(header).base64url(payload).<sig>
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// --- Happy path: scp is a space-delimited string (SLAS convention)
{
  const tok = [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({ scp: 'sfcc.shopper-products sfcc.shopper-baskets', sub: 'x' }),
    'sig',
  ].join('.');
  const scopes = decodeJwtScopes(tok);
  assert.deepEqual(scopes, ['sfcc.shopper-products', 'sfcc.shopper-baskets']);
}

// --- scp as an array (some IdPs)
{
  const tok = [
    b64url({ alg: 'HS256' }),
    b64url({ scp: ['sfcc.shopper-orders'], sub: 'y' }),
    'sig',
  ].join('.');
  assert.deepEqual(decodeJwtScopes(tok), ['sfcc.shopper-orders']);
}

// --- `scope` (OAuth2 spec) as fallback key
{
  const tok = [
    b64url({ alg: 'RS256' }),
    b64url({ scope: 'a b c' }),
    'sig',
  ].join('.');
  assert.deepEqual(decodeJwtScopes(tok), ['a', 'b', 'c']);
}

// --- Not a JWT
assert.throws(() => decodeJwtScopes('opaque-token-no-dots'), (e) => e instanceof DecodeError);
assert.throws(() => decodeJwtScopes(''), (e) => e instanceof DecodeError);
assert.throws(() => decodeJwtScopes(null), (e) => e instanceof DecodeError);

// --- JWT with no scope claim at all
{
  const tok = [
    b64url({ alg: 'RS256' }),
    b64url({ sub: 'z' }),
    'sig',
  ].join('.');
  assert.throws(() => decodeJwtScopes(tok), (e) => e instanceof DecodeError);
}

console.log('ok');
