'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { liveGate, envPresent, writeTemp, cleanup, runScript } = require('../common/live-test.js');

// envPresent: required + either groups.
{
  const save = { ...process.env };
  try {
    process.env.FOO = '1'; delete process.env.BAR;
    assert.equal(envPresent({ required: ['FOO'] }), true, 'required present');
    assert.equal(envPresent({ required: ['BAR'] }), false, 'required absent');
    process.env.ALT2 = 'x';
    assert.equal(envPresent({ either: [['ALT1', 'ALT2']] }), true, 'either group satisfied by ALT2');
    delete process.env.ALT2;
    assert.equal(envPresent({ either: [['ALT1', 'ALT2']] }), false, 'either group unsatisfied');
  } finally {
    process.env = save;
  }
}

// liveGate: false + skip print when DSC_LIVE_TESTS unset; true when set.
{
  const save = process.env.DSC_LIVE_TESTS;
  try {
    delete process.env.DSC_LIVE_TESTS;
    assert.equal(liveGate('unit skip msg'), false, 'gate closed when env unset');
    process.env.DSC_LIVE_TESTS = '1';
    assert.equal(liveGate('unit skip msg'), true, 'gate open when env set');
  } finally {
    if (save === undefined) delete process.env.DSC_LIVE_TESTS; else process.env.DSC_LIVE_TESTS = save;
  }
}

// runScript: executes bash, captures stdout, passes env through, never leaks a secret
// that is only ever used as a shell var (not echoed).
{
  const save = process.env.DSC_LIVE_TESTS;
  process.env.DSC_LIVE_TESTS = '1'; // runScript itself is gate-agnostic, but keep env clean
  try {
    const res = runScript('set -uo pipefail\necho "SIGNAL len=${#SECRET}"', { SECRET: 'abcd' });
    assert.match(res.stdout, /SIGNAL len=4/, 'runScript ran bash and passed env through');
    assert.doesNotMatch(res.stdout, /abcd/, 'the secret value itself never appears in stdout');
  } finally {
    if (save === undefined) delete process.env.DSC_LIVE_TESTS; else process.env.DSC_LIVE_TESTS = save;
  }
}

// writeTemp: reserves a private directory and cleanup removes the whole allocation
{
  const tempFile = writeTemp('echo ok\n');
  const tempDir = path.dirname(tempFile);
  assert.equal(fs.statSync(tempFile).mode & 0o777, 0o600, 'temporary scripts are owner-only');
  cleanup([tempFile]);
  assert.equal(fs.existsSync(tempFile), false, 'temporary script removed');
  assert.equal(fs.existsSync(tempDir), false, 'private temporary directory removed');
}

console.log('ok');
