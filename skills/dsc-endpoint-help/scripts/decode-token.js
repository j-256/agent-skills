'use strict';

class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecodeError';
  }
}

function b64urlDecode(s) {
  let padded = s.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeJwtScopes(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new DecodeError('decodeJwtScopes: input is not a string');
  }
  const parts = token.split('.');
  if (parts.length < 2) throw new DecodeError('decodeJwtScopes: not a JWT (no payload segment)');
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    throw new DecodeError('decodeJwtScopes: payload segment is not valid JSON');
  }
  const raw = payload.scp !== undefined ? payload.scp : payload.scope;
  if (raw === undefined) throw new DecodeError('decodeJwtScopes: no `scp` or `scope` claim');
  if (Array.isArray(raw)) return raw.slice();
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  throw new DecodeError('decodeJwtScopes: unexpected scope claim shape');
}

module.exports = { decodeJwtScopes, DecodeError };
