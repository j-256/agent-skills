#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseRequest, RequestParseError } = require('../lib/parse-request.js');
const { resolveSlug } = require('../lib/resolve-slug.js');
const { scrapeRefresh, ScrapeInvocationError } = require('../lib/scrape-refresh.js');
const { citeEnvelope } = require('../lib/cite.js');
const { classify, ErrorClass } = require('./classify.js');
const { diffRequestAgainstSpec } = require('./diff.js');
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

  // Refresh cache (honors TTL).
  try {
    await scrapeRefresh({ scrapeScript, referenceUrl, cacheRoot });
  } catch (e) {
    if (e instanceof ScrapeInvocationError) {
      die(3, { error: `triage: scrape failed: ${e.message}`, exitCode: e.exitCode, stderr: e.stderr });
    }
    throw e;
  }

  // Read the reference index.
  const reference = referenceUrl.split('/').filter(Boolean).pop();
  const indexPath = path.join(cacheRoot, reference, '_index.json');
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
  catch (e) { die(3, { error: `triage: cannot read _index.json at ${indexPath}: ${e.message}` }); }

  const resolved = resolveSlug({ method: req.method, livePath: req.path, index });
  if (!resolved) die(2, { error: `triage: could not resolve slug – no matching endpoint in _index.json for ${req.method} ${req.path}` });

  const specPath = path.join(cacheRoot, resolved.reference || reference, `${resolved.slug}.json`);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { die(3, { error: `triage: cannot read slug file at ${specPath}: ${e.message}` }); }

  const errorClass = classify(errorResponse);
  const diff = diffRequestAgainstSpec({ request: req, spec, providedScopes });
  const handsOff = errorClass === ErrorClass.UNKNOWN;

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
