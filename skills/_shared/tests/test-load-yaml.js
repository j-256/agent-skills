'use strict';

const assert = require('node:assert/strict');
const { load, MissingDependencyError } = require('../scrape/load-yaml.js');

// --- happy path: parses YAML with the real js-yaml.
{
  const doc = load('a: 1\nb: [x, y]\n');
  assert.deepEqual(doc, { a: 1, b: ['x', 'y'] });
}

// --- missing dependency: when js-yaml can't be required, callers get a clear,
// actionable MissingDependencyError that names the install command -- not a raw
// MODULE_NOT_FOUND from deep in the scrape path. The require is injected so the
// branch is exercisable without uninstalling js-yaml.
{
  const missingRequire = () => {
    const e = new Error("Cannot find module 'js-yaml'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  };
  assert.throws(
    () => load('a: 1', missingRequire),
    (e) => e instanceof MissingDependencyError
        && /js-yaml/.test(e.message)
        && /npm install --prefix/.test(e.message),
    'a missing js-yaml must surface as an actionable MissingDependencyError',
  );
}

// --- an unexpected (non-MODULE_NOT_FOUND) require failure propagates unchanged.
{
  const boomRequire = () => { throw new Error('unexpected boom'); };
  assert.throws(() => load('a: 1', boomRequire), /unexpected boom/);
}

console.log('ok');
