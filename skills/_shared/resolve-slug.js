'use strict';

// Convert a templated path like '/orgs/{id}/items/{itemId}' into a regex
// and an ordered list of parameter names.
function compileTemplate(templatePath) {
  const paramNames = [];
  const pattern = templatePath.replace(/\{([^}]+)\}/g, (_m, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  const regex = new RegExp('^' + pattern + '/?$');
  return { regex, paramNames };
}

function resolveSlug({ method, livePath, index }) {
  if (!index || !index.endpoints || typeof index.endpoints !== 'object') return null;
  if (typeof method !== 'string' || typeof livePath !== 'string') return null;

  const methodU = method.toUpperCase();
  // Ignore a trailing slash on the live path by stripping it once.
  const path = livePath.length > 1 && livePath.endsWith('/')
    ? livePath.slice(0, -1)
    : livePath;

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
