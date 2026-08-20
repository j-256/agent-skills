'use strict';

const { normalizeSchema } = require('../lib/common/spec-traversal.js');

function requiredScopes(spec) {
  const sec = spec?.endpoint?.security;
  if (!Array.isArray(sec)) return [];
  const out = new Set();
  for (const s of sec) {
    if (Array.isArray(s.scopes)) {
      for (const sc of s.scopes) out.add(sc);
    }
  }
  return [...out];
}

function scopeDiff(spec, providedScopes) {
  const required = requiredScopes(spec);
  if (!providedScopes || !Array.isArray(providedScopes.scopes)) {
    return { required, provided: [], providedSource: 'unknown', missing: required };
  }
  const providedSet = new Set(providedScopes.scopes);
  const missing = required.filter((r) => !providedSet.has(r));
  return {
    required,
    provided: [...providedScopes.scopes],
    providedSource: providedScopes.source || 'unknown',
    missing,
  };
}

function parseJsonBody(body) {
  if (body == null || body === '') return null;
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch { return undefined; } // undefined means malformed
}

function checkRequiredProps(schema, value, pathPrefix, findings) {
  if (!schema || typeof schema !== 'object') return;
  schema = normalizeSchema(schema);
  if (schema.type === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const props = schema.properties || {};
    for (const key of required) {
      const child = value && typeof value === 'object' ? value[key] : undefined;
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (child === undefined) {
        findings.push({ kind: 'body-missing-required', field: childPath });
      } else {
        checkRequiredProps(props[key], child, childPath, findings);
        checkType(props[key], child, childPath, findings);
      }
    }
    for (const [k, childSchema] of Object.entries(props)) {
      if (required.includes(k)) continue;
      const child = value && typeof value === 'object' ? value[k] : undefined;
      if (child === undefined) continue;
      const childPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      checkRequiredProps(childSchema, child, childPath, findings);
      checkType(childSchema, child, childPath, findings);
    }
  }
}

function checkType(schema, value, pathPrefix, findings) {
  if (!schema || typeof schema !== 'object') return;
  schema = normalizeSchema(schema);
  const expected = schema.type;
  if (!expected) return;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  let matches = false;
  if (expected === 'string') matches = actual === 'string';
  else if (expected === 'integer' || expected === 'number') matches = actual === 'number';
  else if (expected === 'boolean') matches = actual === 'boolean';
  else if (expected === 'array') matches = actual === 'array';
  else if (expected === 'object') matches = actual === 'object' && !Array.isArray(value) && value !== null;
  else matches = true; // unknown type – don't false-positive
  if (!matches) {
    findings.push({ kind: 'body-wrong-type', field: pathPrefix, expected, actual });
  }
}

function collectAcceptedContentTypes(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.contentTypes) && body.contentTypes.length) return body.contentTypes;
  if (typeof body.contentType === 'string' && body.contentType) return [body.contentType];
  if (typeof body.mediaType === 'string' && body.mediaType) return [body.mediaType];
  return [];
}

function shapeDiff(spec, request, bodySchema) {
  const findings = [];
  const ep = spec.endpoint || {};

  // Method
  if (ep.method && request.method !== ep.method.toUpperCase()) {
    findings.push({ kind: 'method-mismatch', expected: ep.method.toUpperCase(), actual: request.method });
  }

  // Parameters: required query and header params present
  for (const p of ep.parameters || []) {
    if (!p.required) continue;
    if (p.in === 'query') {
      if (!(p.name in (request.query || {}))) {
        findings.push({ kind: 'query-missing-required', name: p.name });
      }
    }
    // Header params are handled by the ep.headers loop below (OAS duplicates
    // headers into both ep.parameters and ep.headers). Path params are
    // validated by the resolver before we get here.
  }

  // Required header list from ep.headers (some specs duplicate; both are fine)
  for (const h of ep.headers || []) {
    if (!h.required) continue;
    const hk = (h.name || '').toLowerCase();
    if (!(hk in (request.headers || {}))) {
      findings.push({ kind: 'header-missing-required', name: h.name });
    }
  }

  // Body content-type. Specs may declare multiple media types; the request's
  // Content-Type only has to match one. Normalize the three shapes the parsers
  // emit (oas-3 + swagger-2 -> contentTypes[]; legacy/amf -> contentType
  // string; amf -> mediaType string) into a single accepted-set list.
  const accepted = collectAcceptedContentTypes(ep.body);
  if (accepted.length) {
    const ct = (request.headers || {})['content-type'];
    if (ct) {
      const actualBase = ct.split(';')[0].trim().toLowerCase();
      const matches = accepted.some((a) => a.toLowerCase() === actualBase);
      if (!matches) {
        findings.push({ kind: 'wrong-content-type', expected: accepted, actual: ct });
      }
    }
  }

  // Body required fields + types. The schema is either inline on the spec
  // (ep.body.schema) or a named-type reference (ep.body.schemaRef) the caller
  // resolved to its type schema and passed in as bodySchema. Most real-cache
  // SCAPI POST/PUT bodies are the schemaRef shape; without the resolved schema
  // there is nothing to validate against, so an unresolved schemaRef body simply
  // skips body validation (it does not crash) -- the same graceful degrade as a
  // spec that declares no body schema at all.
  const effectiveBodySchema = ep.body && (ep.body.schema || bodySchema);
  if (ep.body && ep.body.required && effectiveBodySchema) {
    const parsed = parseJsonBody(request.body);
    if (parsed === undefined) {
      findings.push({ kind: 'body-malformed-json' });
    } else if (parsed === null) {
      findings.push({ kind: 'body-missing-required', field: '<root>' });
    } else {
      checkRequiredProps(effectiveBodySchema, parsed, '', findings);
      checkType(effectiveBodySchema, parsed, '<root>', findings);
    }
  }

  return findings;
}

// `bodySchema` (optional): the resolved schema for a named-type body declared as
// ep.body.schemaRef. The caller (triage.js) resolves the ref to its type file and
// passes the schema here; when absent (inline-schema body, or an unresolvable
// ref), body validation falls back to the inline schema or skips gracefully.
function diffRequestAgainstSpec({ request, spec, providedScopes, bodySchema }) {
  const sd = scopeDiff(spec, providedScopes);
  const shape = shapeDiff(spec, request, bodySchema);

  let confidence;
  if (sd.providedSource === 'token') {
    confidence = 'high';
  } else if (sd.providedSource === 'clientList') {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { scopeDiff: sd, shapeDiff: shape, confidence };
}

module.exports = { diffRequestAgainstSpec };
