'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LOAD_YAML = path.join(__dirname, '..', 'scrape', 'load-yaml.js');

// load-yaml parses YAML from a VENDORED js-yaml, with no dependency on the js-yaml
// npm package -- so a fresh clone that never ran `npm install` still works. Prove it
// by making the 'js-yaml' package unresolvable in a subprocess and asserting parsing
// still succeeds (the vendored bundle is required by a relative path, not the package).
{
  const probe = [
    "const Module = require('module');",
    "const orig = Module._load;",
    "Module._load = function (request) {",
    "  if (request === 'js-yaml') { const e = new Error('stub: js-yaml npm package not installed'); e.code = 'MODULE_NOT_FOUND'; throw e; }",
    "  return orig.apply(this, arguments);",
    "};",
    `const { load } = require(${JSON.stringify(LOAD_YAML)});`,
    "const doc = load('grant_type:\\n  enum: [client_credentials, refresh_token]\\nchannel_id: RefArch\\n');",
    "const expected = JSON.stringify({ grant_type: { enum: ['client_credentials', 'refresh_token'] }, channel_id: 'RefArch' });",
    "if (JSON.stringify(doc) !== expected) { console.error('PARSE MISMATCH: ' + JSON.stringify(doc)); process.exit(1); }",
    "console.log('parsed-without-npm-js-yaml');",
  ].join('\n');
  const res = spawnSync('node', ['-e', probe], { encoding: 'utf8' });
  assert.equal(res.status, 0,
    `load-yaml must parse YAML with the js-yaml npm package unresolvable (vendored); stderr=${res.stderr}`);
  assert.match(res.stdout, /parsed-without-npm-js-yaml/);
}

// In-process sanity: load() parses ordinary YAML.
{
  const { load } = require('../scrape/load-yaml.js');
  assert.deepEqual(load('a: 1\nb: [x, y]\n'), { a: 1, b: ['x', 'y'] });
}

console.log('ok');
