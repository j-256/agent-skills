'use strict';

// Convert a templated path like '/orgs/{id}/items/{itemId}' into a regex
// and an ordered list of parameter names. `anchor` chooses between matching
// the whole path ('full') or just a prefix ('prefix') -- the latter is used
// for stripping the basePath off a live request path.
function compileTemplate(templatePath, anchor = 'full') {
  const paramNames = [];
  const pattern = templatePath.replace(/\{([^}]+)\}/g, (_m, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  const tail = anchor === 'prefix' ? '(?=/|$)' : '/?$';
  const regex = new RegExp('^' + pattern + tail);
  return { regex, paramNames };
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
  if (basePath) {
    const { regex: baseRegex } = compileTemplate(basePath, 'prefix');
    const m = baseRegex.exec(path);
    if (!m) return null;
    path = path.slice(m[0].length) || '/';
  }

  const candidates = [];
  for (const [slug, ep] of Object.entries(index.endpoints)) {
    if (!ep || ep.method !== methodU) continue;
    const { regex, paramNames } = compileTemplate(ep.path);
    const match = regex.exec(path);
    if (!match) continue;
    const pathParams = {};
    paramNames.forEach((name, idx) => { pathParams[name] = match[idx + 1]; });
    candidates.push({ slug, ep, pathParams, specificity: ep.path.length });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.specificity - a.specificity);
  const winner = candidates[0];
  return {
    reference: index.reference || null,
    slug: winner.slug,
    pathParams: winner.pathParams,
  };
}

module.exports = { resolveSlug };
