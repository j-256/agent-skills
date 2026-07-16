'use strict';

// Product-neutral shell-variable naming. Both the curl-block renderer (path
// params, jq-capture vars) and the auth-preamble renderer (customers/auth URL
// interpolation) route names through here so one convention -- snake
// NAMES_LIKE_THIS -- is emitted everywhere. Before this, path-param
// interpolation produced NAMESLIKETHIS while jq-capture produced NAMES_LIKE_THIS,
// so one conceptual id (basketId vs basket_id) could render as two shell vars.
//
// shellVar('organizationId') -> 'ORGANIZATION_ID'; idempotent on snake_case.
function shellVar(name) {
  return String(name)
    // split lower|digit -> Upper boundary: organizationId -> organization_Id
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // split Upper-run -> Upper+lower boundary: productID + s -> keeps ID intact
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_') // non-alphanumerics -> underscore
    .replace(/_+/g, '_') // collapse runs
    .replace(/^_|_$/g, '') // trim edges
    .toUpperCase();
}

// Convert a templated path (/containers/{containerId}) into a shell-interpolating
// string (/containers/${CONTAINER_ID}). Every {name} becomes ${shellVar(name)}.
function interpolatePath(templatePath) {
  return String(templatePath).replace(/\{([^}]+)\}/g, (_m, name) => `\${${shellVar(name)}}`);
}

module.exports = { shellVar, interpolatePath };
