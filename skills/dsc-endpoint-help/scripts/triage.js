#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseRequest, RequestParseError } = require('../lib/parse-request.js');
const { resolveSlug } = require('../lib/resolve-slug.js');
const { scrapeRefresh, ScrapeInvocationError } = require('../lib/scrape-refresh.js');
const { citeEnvelope } = require('../lib/cite.js');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../lib/scrape/resolve-cache.js');
const { classify, ErrorClass } = require('./classify.js');
const { diffRequestAgainstSpec } = require('./diff.js');
const { resolveSchemaRef } = require('./query.js');
const { decodeJwtScopes, DecodeError } = require('./decode-token.js');

function die(code, obj) {
  const msg = obj && obj.error ? obj.error : JSON.stringify(obj);
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function readStdinJson() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = await readStdinJson().catch((e) => {
    die(2, { error: `triage: expected JSON on stdin: ${e.message}` });
  });

  const {
    request,
    errorResponse,
    providedScopes: providedScopesIn,
    cacheRoot,
    scrapeScript,
    referenceUrl,
  } = input || {};

  if (!request) die(2, { error: 'triage: missing `request`' });
  if (!errorResponse) die(2, { error: 'triage: missing `errorResponse`' });
  if (!referenceUrl) die(2, { error: 'triage: missing `referenceUrl` – cannot determine which reference to scrape' });

  let req;
  try {
    req = parseRequest(request);
  } catch (e) {
    if (e instanceof RequestParseError) die(2, { error: `triage: ${e.message}` });
    throw e;
  }

  // Provided scopes: prefer explicit input; else try to decode the token.
  let providedScopes = providedScopesIn || null;
  if (!providedScopes && req.token) {
    try {
      const scopes = decodeJwtScopes(req.token);
      providedScopes = { source: 'token', scopes };
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      providedScopes = null;
    }
  }

  // Refresh cache (honors TTL). scrapeRefresh returns area in its rawSummary.
  let scrapeResult;
  try {
    scrapeResult = await scrapeRefresh({ scrapeScript, referenceUrl, cacheRoot });
  } catch (e) {
    if (e instanceof ScrapeInvocationError) {
      die(3, { error: `triage: scrape failed: ${e.message}`, exitCode: e.exitCode, stderr: e.stderr });
    }
    throw e;
  }

  // Resolve <cacheRoot>/<area>/<reference>/. The scrape we just did supplies
  // the area unambiguously; if it's missing for some reason, fall back to
  // landing-scan + the same ambiguity guard the read-only callers use.
  const reference = referenceUrl.split('/').filter(Boolean).pop();
  let refDir;
  try {
    const r = resolveReferenceDir(scrapeResult.cacheRoot, reference, scrapeResult.area ? { area: scrapeResult.area } : {});
    refDir = r.dir;
  } catch (e) {
    if (e instanceof AmbiguousReferenceError || e instanceof ReferenceNotCachedError) {
      die(3, { error: `triage: ${e.message}` });
    }
    throw e;
  }
  const indexPath = path.join(refDir, '_index.json');
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
  catch (e) { die(3, { error: `triage: cannot read _index.json at ${indexPath}: ${e.message}` }); }

  const resolved = resolveSlug({ method: req.method, livePath: req.path, index });
  if (!resolved) die(2, { error: `triage: could not resolve slug – no matching endpoint in _index.json for ${req.method} ${req.path}` });

  const specPath = path.join(refDir, `${resolved.slug}.json`);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { die(3, { error: `triage: cannot read slug file at ${specPath}: ${e.message}` }); }

  const errorClass = classify(errorResponse);
  // Resolve a named-type body (body.schemaRef) to its type schema so diff.js can
  // validate the request body against it. Most real-cache SCAPI POST/PUT bodies
  // are this shape (an inline body.schema is the exception). resolveSchemaRef
  // returns the type envelope ({name, schema}) on success, or {error} / null when
  // the type file is missing -- in which case bodySchema stays undefined and diff
  // skips body validation gracefully rather than fabricating findings.
  let bodySchema;
  const bodyRef = spec.endpoint && spec.endpoint.body && spec.endpoint.body.schemaRef;
  if (bodyRef && !(spec.endpoint.body && spec.endpoint.body.schema)) {
    const resolvedType = resolveSchemaRef(refDir, bodyRef);
    if (resolvedType && resolvedType.schema) bodySchema = resolvedType.schema;
  }
  const diff = diffRequestAgainstSpec({ request: req, spec, providedScopes, bodySchema });
  const handsOff = errorClass === ErrorClass.UNKNOWN;

  // OCAPI references encode an API version literal (e.g. v25_6) in basePath.
  // When the live request hits a different version, resolveSlug still routes
  // to the matching slug but surfaces the drift via `versionMismatch`. Carry
  // that into shapeDiff so the customer-facing answer cites both versions
  // instead of silently treating drift as a clean match.
  if (resolved.versionMismatch) {
    diff.shapeDiff.push({
      kind: 'version-mismatch',
      liveVersion: resolved.versionMismatch.live,
      specVersion: resolved.versionMismatch.spec,
    });
  }

  const sources = [];
  try {
    sources.push(citeEnvelope(spec));
  } catch (e) {
    process.stderr.write(`triage: warning: ${e.message}\n`);
  }

  const out = {
    errorClass,
    handsOff,
    confidence: diff.confidence,
    scopeDiff: diff.scopeDiff,
    shapeDiff: diff.shapeDiff,
    resolved: { reference: resolved.reference || reference, slug: resolved.slug, pathParams: resolved.pathParams },
    sources,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((e) => die(1, { error: `triage: unexpected: ${e.stack || e.message}` }));
