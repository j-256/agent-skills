'use strict';

const path = require('node:path');

// _shared is the parent of this scrape/ dir; that's where package.json and
// node_modules live, so it's the right --prefix for a reinstall.
const SHARED_DIR = path.join(__dirname, '..');

class MissingDependencyError extends Error {
  constructor(dependency, installDir) {
    super(
      `Missing dependency '${dependency}'. The dsc-* scrape library needs it. ` +
      `Install it with: npm install --prefix ${installDir}`,
    );
    this.name = 'MissingDependencyError';
    this.dependency = dependency;
    this.installDir = installDir;
  }
}

// Resolve js-yaml lazily rather than at module load, so merely requiring the scrape
// library (e.g. for areaKeyFromReferencesPath on a cache-only path) doesn't hard-fail
// when deps aren't installed -- and when a scrape actually parses YAML without the
// dependency present, the caller gets an actionable message instead of a raw
// MODULE_NOT_FOUND. requireFn is injectable so the missing-dependency branch is
// unit-testable without uninstalling js-yaml (Node caches the module, so the real
// require path stays cheap on repeat calls).
function resolveYaml(requireFn = require) {
  try {
    return requireFn('js-yaml');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      throw new MissingDependencyError('js-yaml', SHARED_DIR);
    }
    throw e;
  }
}

function load(str, requireFn) {
  return resolveYaml(requireFn).load(str);
}

module.exports = { load, resolveYaml, MissingDependencyError };
