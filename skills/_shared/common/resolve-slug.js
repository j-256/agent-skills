'use strict';

const VERSION_LITERAL = /^v\d+_\d+$/;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

function escapeRegex(value) {
  return value.replace(REGEX_SPECIAL, '\\$&');
}

function templatePattern(templatePath, paramNames) {
  const tokenPattern = /\{([^}/]+)\}/g;
  let cursor = 0;
  let pattern = '';
  for (const match of templatePath.matchAll(tokenPattern)) {
    pattern += escapeRegex(templatePath.slice(cursor, match.index));
    pattern += '([^/]+)';
    paramNames.push(match[1]);
    cursor = match.index + match[0].length;
  }
  return pattern + escapeRegex(templatePath.slice(cursor));
}

function setOwn(record, key, value) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

// Convert a templated path like '/orgs/{id}/items/{itemId}' into a regex
// and an ordered list of parameter names. `anchor` chooses between matching
// the whole path ('full') or just a prefix ('prefix') -- the latter is used
// for stripping the basePath off a live request path.
function compileTemplate(templatePath, anchor = 'full') {
  const paramNames = [];
  const pattern = templatePattern(templatePath, paramNames);
  const tail = anchor === 'prefix' ? '(?=/|$)' : '/?$';
  const regex = new RegExp('^' + pattern + tail);
  return { regex, paramNames };
}

// Compile a basePath into a prefix regex where any literal version segment
// (vN_M) is wildcarded. Used only as a second pass when the strict basePath
// regex doesn't match -- we want to detect "live path differs only in the
// version literal" without quietly accepting it as a clean match.
// Returns null if the basePath has no version-literal segment to relax.
function compileVersionTolerantBase(basePath) {
  const segments = basePath.split('/');
  let specVersionIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (VERSION_LITERAL.test(segments[i])) {
      specVersionIdx = i;
      break;
    }
  }
  if (specVersionIdx === -1) return null;

  const paramNames = [];
  const patternParts = segments.map((seg, i) => {
    if (i === specVersionIdx) {
      paramNames.push('__liveVersion');
      return '(v\\d+_\\d+)';
    }
    return templatePattern(seg, paramNames);
  });
  const regex = new RegExp('^' + patternParts.join('/') + '(?=/|$)');
  return { regex, paramNames, specVersion: segments[specVersionIdx] };
}

function resolveSlug({ method, livePath, index }) {
  if (!index || !index.endpoints || typeof index.endpoints !== 'object') return null;
  if (typeof method !== 'string' || typeof livePath !== 'string') return null;

  const methodU = method.toUpperCase();
  // Ignore a trailing slash on the live path by stripping it once.
  let path = livePath.length > 1 && livePath.endsWith('/')
    ? livePath.slice(0, -1)
    : livePath;

  // _index.json's endpoint.path is the spec's relative path
  // (e.g. /organizations/{organizationId}/orders/{orderNo}); a real request's
  // pathname carries the reference's base prefix (e.g. /checkout/<reference>/v1).
  // The scraper writes that prefix to index.basePath; strip it before matching.
  // basePath absent on legacy/no-server references; strip nothing in that case.
  // basePath may itself contain {...} template tokens (OCAPI: /s/{siteId}/dw/shop/v25_6),
  // so match it as a regex anchored at the start, not a literal startsWith.
  const basePath = typeof index.basePath === 'string' && index.basePath.length > 0
    ? index.basePath.replace(/\/$/, '')
    : '';
  let versionMismatch = null;
  if (basePath) {
    const { regex: baseRegex } = compileTemplate(basePath, 'prefix');
    const m = baseRegex.exec(path);
    if (m) {
      path = path.slice(m[0].length) || '/';
    } else {
      // Strict prefix didn't match. Try the version-tolerant variant: maybe
      // the live URL conforms to the spec's basePath shape EXCEPT for the
      // version literal (e.g. the request hits v23_2 against a v25_6 spec).
      // Surface this as a structured signal so triage.js can name both
      // versions in its diff -- not a silent wildcard match.
      const tolerant = compileVersionTolerantBase(basePath);
      if (!tolerant) return null;
      const tm = tolerant.regex.exec(path);
      if (!tm) return null;
      const liveVersion = tm[tolerant.paramNames.indexOf('__liveVersion') + 1];
      versionMismatch = { live: liveVersion, spec: tolerant.specVersion };
      path = path.slice(tm[0].length) || '/';
    }
  }

  const candidates = [];
  for (const [slug, ep] of Object.entries(index.endpoints)) {
    if (!ep || ep.method !== methodU) continue;
    const { regex, paramNames } = compileTemplate(ep.path);
    const match = regex.exec(path);
    if (!match) continue;
    const pathParams = {};
    paramNames.forEach((name, idx) => { setOwn(pathParams, name, match[idx + 1]); });
    candidates.push({ slug, ep, pathParams, specificity: ep.path.length });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.specificity - a.specificity);
  const winner = candidates[0];
  const out = {
    reference: index.reference || null,
    slug: winner.slug,
    pathParams: winner.pathParams,
  };
  if (versionMismatch) out.versionMismatch = versionMismatch;
  return out;
}

// Match a RESOURCE-RELATIVE path (no basePath prefix) against a reference's
// endpoints. resolveSlug() is for a full live request path (from a pasted cURL)
// and strips the reference basePath first; the landing-scan target-discovery use
// has the opposite input -- the user gives the resource-relative path ("POST
// /orders", "GET /products/{id}"), never the /s/{siteId}/dw/shop/... prefix. This
// matches ep.path directly, so it doesn't fight the basePath-stripping contract.
// Returns {slug, pathParams} for the most-specific match, or null. Shares
// compileTemplate with resolveSlug so the param-matching semantics can't drift.
function matchRelativePath({ method, relPath, index }) {
  if (!index || !index.endpoints || typeof index.endpoints !== 'object') return null;
  if (typeof method !== 'string' || typeof relPath !== 'string') return null;
  const methodU = method.toUpperCase();
  let path = relPath.length > 1 && relPath.endsWith('/') ? relPath.slice(0, -1) : relPath;
  if (!path.startsWith('/')) path = `/${path}`;

  const candidates = [];
  for (const [slug, ep] of Object.entries(index.endpoints)) {
    if (!ep || ep.method !== methodU) continue;
    const { regex, paramNames } = compileTemplate(ep.path);
    const match = regex.exec(path);
    if (!match) continue;
    const pathParams = {};
    paramNames.forEach((name, idx) => { setOwn(pathParams, name, match[idx + 1]); });
    candidates.push({ slug, pathParams, specificity: ep.path.length });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.specificity - a.specificity);
  const winner = candidates[0];
  return { reference: index.reference || null, slug: winner.slug, pathParams: winner.pathParams };
}

module.exports = { resolveSlug, matchRelativePath };
