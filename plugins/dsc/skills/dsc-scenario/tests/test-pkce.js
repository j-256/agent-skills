'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pkceShellSnippet } = require('../lib/common/pkce.js');

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// Snippet shape: 96 bytes of entropy, no `cut` truncation, base64url substitution
// (not stripping). 96 -> 128-char verifier (RFC 7636 max). The 32-byte form
// produces a 43-char verifier (the spec's min) and was the historical default;
// pin against regression to that.
{
  const snippet = pkceShellSnippet();

  assert.match(snippet, /openssl rand -base64 96\b/,
    '96 bytes of entropy yields a 128-char verifier (RFC 7636 max)');
  assert.doesNotMatch(snippet, /openssl rand -base64 32\b/,
    'must not regress to 32-byte form (43-char verifier, RFC 7636 min)');
  assert.doesNotMatch(snippet, /\bcut -c/,
    'truncating with cut is the 43-char form; 96 bytes does not need it');
  assert.match(snippet, /tr '\+\/' '-_'/,
    `must base64url-substitute '+/' -> '-_', not strip them`);

  // Verifier and challenge both bound; consumer scripts reference these names.
  assert.match(snippet, /^CODE_VERIFIER=/m);
  assert.match(snippet, /^CODE_CHALLENGE=/m);

  // Challenge derived from verifier via SHA-256 (S256), per RFC 7636 §4.2.
  assert.match(snippet, /openssl dgst -binary -sha256/);
}

// Execute the snippet end-to-end and check the bound vars satisfy RFC 7636.
{
  const snippet = pkceShellSnippet();
  const out = execFileSync('bash', ['-c', `${snippet}\nprintf '%s\\n%s\\n' "$CODE_VERIFIER" "$CODE_CHALLENGE"`], {
    encoding: 'utf8',
  });
  const [verifier, challenge] = out.split('\n');

  // RFC 7636 §4.1: verifier is 43-128 chars from the unreserved set.
  // 96 raw bytes base64-encoded is 128 chars unpadded.
  assert.equal(verifier.length, 128, 'verifier should be 128 chars (96 bytes base64-encoded)');
  assert.match(verifier, BASE64URL, 'verifier is base64url alphabet only');

  // RFC 7636 §4.2: S256 challenge is base64url(SHA256(verifier)) -> always 43 chars.
  assert.equal(challenge.length, 43);
  assert.match(challenge, BASE64URL);
}

// pkce-snippet.js prints the snippet verbatim to stdout.
{
  const scriptPath = path.join(__dirname, '..', 'scripts', 'pkce-snippet.js');
  const stdout = execFileSync('node', [scriptPath], { encoding: 'utf8' });
  assert.equal(stdout, `${pkceShellSnippet()}\n`);
}

console.log('ok');
