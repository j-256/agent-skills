'use strict';

const ErrorClass = Object.freeze({
  AUTH_MISSING_SCOPE: 'AUTH_MISSING_SCOPE',
  AUTH_INVALID_CLIENT: 'AUTH_INVALID_CLIENT',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  REQUEST_MISSING_REQUIRED: 'REQUEST_MISSING_REQUIRED',
  REQUEST_WRONG_TYPE: 'REQUEST_WRONG_TYPE',
  REQUEST_BAD_SHAPE: 'REQUEST_BAD_SHAPE',
  UNKNOWN: 'UNKNOWN',
});

function normalizeBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { return { _raw: trimmed, _nonJson: true }; }
    }
    return { _raw: trimmed, _nonJson: true };
  }
  if (typeof body === 'object') return body;
  return {};
}

// Top-level keys: SCAPI RFC-7807 (`type`/`title`/`detail`) and OAuth (`error`/`error_description`).
// Nested under `fault`: OCAPI envelopes – `{"fault":{"type":"InvalidClientIdException","message":"..."}}`
function hasText(body, re) {
  for (const k of ['error', 'error_description', 'type', 'title', 'detail', 'message']) {
    const v = body[k];
    if (typeof v === 'string' && re.test(v)) return true;
  }
  const f = body.fault;
  if (f && typeof f === 'object') {
    for (const k of ['type', 'message']) {
      const v = f[k];
      if (typeof v === 'string' && re.test(v)) return true;
    }
  }
  return false;
}

function classify({ status, body }) {
  const b = normalizeBody(body);
  if (b._nonJson) return ErrorClass.UNKNOWN;

  // 401/403 classification
  if (status === 401 || status === 403) {
    if (hasText(b, /insufficient[_\- ]?scope|insufficient[_\- ]?permissions/i)) {
      return ErrorClass.AUTH_MISSING_SCOPE;
    }
    if (hasText(b, /invalid[_\- ]?client/i)) {
      return ErrorClass.AUTH_INVALID_CLIENT;
    }
    if (hasText(b, /invalid[_\- ]?token|expired[_\- ]?token|token[_\- ]?expired/i)) {
      return ErrorClass.AUTH_INVALID_TOKEN;
    }
    // 401 or 403 with no more-specific tag: still auth-class but unknown specific code.
    return ErrorClass.AUTH_UNAUTHORIZED;
  }

  // 415 – content-type / shape
  if (status === 415) return ErrorClass.REQUEST_BAD_SHAPE;

  // 400 classification
  if (status === 400) {
    if (hasText(b, /missing[_\- ]?required|missing[_\- ]?parameter|required[_\- ]?parameter/i)) {
      return ErrorClass.REQUEST_MISSING_REQUIRED;
    }
    if (hasText(b, /invalid[_\- ]?parameter[_\- ]?type|expected\s+['"]?\w+['"]?\s+but\s+got|type[_\- ]?mismatch/i)) {
      return ErrorClass.REQUEST_WRONG_TYPE;
    }
    if (hasText(b, /malformed|unsupported[_\- ]?media|content[_\- ]?type/i)) {
      return ErrorClass.REQUEST_BAD_SHAPE;
    }
  }

  return ErrorClass.UNKNOWN;
}

module.exports = { classify, ErrorClass };
