'use strict';

// Bash snippet that generates an RFC 7636 PKCE code verifier and S256 challenge
// 96 bytes of entropy yields a 128-char verifier
// (the spec's max length), then base64url-substitute '+/' -> '-_' rather than
// stripping; produces shell vars CODE_VERIFIER and CODE_CHALLENGE
//
// Reference: https://datatracker.ietf.org/doc/html/rfc7636#section-4.1
function pkceShellSnippet() {
  return [
    `CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\\n' | tr '+/' '-_')`,
    `CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\\n' | tr '+/' '-_')`,
  ].join('\n');
}

module.exports = { pkceShellSnippet };
