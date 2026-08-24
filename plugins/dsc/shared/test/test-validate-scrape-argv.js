'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { validateScrapeArgv } = require('../scrape/scrape.js');

// Pure-function unit tests – no subprocess, no fs, no network. The
// rationale for each case is in the comment alongside it; together
// they cover the three failure modes documented in scrape.js.

// 1. Misparsed long-flag-as-out-root. The script has no --cache-root /
// --cache flag, so a caller that wrote `scrape.js <url> --cache-root
// <path>` puts the literal '--cache-root' in argv[3]. Reject.
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '--cache-root', '/tmp/x']);
  assert.equal(r.ok, false, 'should reject --cache-root as out-root');
  assert.equal(r.reason, 'flag-as-outroot');
  assert.equal(r.value, '--cache-root');
}
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '--cache']);
  assert.equal(r.ok, false, 'should reject --cache as out-root');
  assert.equal(r.reason, 'flag-as-outroot');
  assert.equal(r.value, '--cache');
}
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '--list-only']);
  assert.equal(r.ok, false, 'should reject any --foo as out-root');
  assert.equal(r.reason, 'flag-as-outroot');
}

// 2. Literal-tilde out-root. Caused by quoting that disables shell
// tilde expansion or by a subprocess env with empty HOME.
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '~']);
  assert.equal(r.ok, false, 'should reject bare tilde as out-root');
  assert.equal(r.reason, 'literal-tilde-outroot');
  assert.equal(r.value, '~');
}
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '~/.cache/dsc-scrape']);
  assert.equal(r.ok, false, 'should reject literal ~/foo as out-root');
  assert.equal(r.reason, 'literal-tilde-outroot');
  assert.equal(r.value, '~/.cache/dsc-scrape');
}

// 3. Short-flag-as-out-root. Less common but cheap to reject too.
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '-f']);
  assert.equal(r.ok, false, 'should reject -f as out-root');
  assert.equal(r.reason, 'short-flag-as-outroot');
  assert.equal(r.value, '-f');
}

// 4. Missing args. Existing behavior – preserved.
{
  const r = validateScrapeArgv(['node', 'scrape.js']);
  assert.equal(r.ok, false, 'should reject no args');
  assert.equal(r.reason, 'missing-args');
}
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/']);
  assert.equal(r.ok, false, 'should reject single arg');
  assert.equal(r.reason, 'missing-args');
}

// 5. Happy path – an absolute path passes through unchanged.
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '/tmp/dsc-scrape']);
  assert.equal(r.ok, true, 'absolute path should pass');
}
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', '/Users/foo/.cache/dsc-scrape']);
  assert.equal(r.ok, true, 'expanded home path should pass');
}
{
  const r = validateScrapeArgv(['node', 'scrape.js', 'https://example/', './out']);
  assert.equal(r.ok, true, 'relative path should pass (legitimate)');
}

// 6. Integration – spawn the script with bad args and assert exit
// code 2 + stderr contains the offending value and the usage line.
{
  const scriptPath = path.resolve(__dirname, '..', 'scrape', 'scrape.js');
  const r = spawnSync(
    process.execPath,
    [scriptPath, 'https://example/', '--cache-root'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2, 'exit code should be 2 for argv-validation failure');
  assert.match(r.stderr, /--cache-root/, 'stderr should reproduce the offending value');
  assert.match(r.stderr, /Usage: node scripts\/scrape\.js/, 'stderr should print the usage line');
}
{
  const scriptPath = path.resolve(__dirname, '..', 'scrape', 'scrape.js');
  const r = spawnSync(
    process.execPath,
    [scriptPath, 'https://example/', '~/.cache/dsc-scrape'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2, 'exit code should be 2 for tilde-as-outroot');
  assert.match(r.stderr, /literal tilde/, 'stderr should explain the tilde failure mode');
}

console.log('ok');
