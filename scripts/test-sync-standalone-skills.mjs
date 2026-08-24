#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StandaloneSkillSyncError,
  checkStandaloneSkills,
  compareTrees,
  writeStandaloneSkills,
} from './sync-standalone-skills.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIRECTORY, 'sync-standalone-skills.mjs');
const DSC_SKILL_NAMES = Object.freeze(['dsc-endpoint-help', 'dsc-scenario', 'dsc-scrape']);
const OTHER_SKILLS = Object.freeze({
  'fork-and-pr': 'fork-and-pr',
  'stepped-demo-script': 'stepped-demo-script',
});

function writeFile(filePath, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode });
}

function makeRepository(repositoryRoot) {
  writeFile(
    path.join(repositoryRoot, 'scripts/sync-standalone-skills.mjs'),
    fs.readFileSync(SCRIPT_PATH),
    0o755,
  );
  writeFile(path.join(repositoryRoot, 'plugins/dsc/shared/runtime.js'), 'module.exports = 1;\n');
  writeFile(path.join(repositoryRoot, 'plugins/dsc/shared/run.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  for (const skillName of DSC_SKILL_NAMES) {
    writeFile(path.join(repositoryRoot, `plugins/dsc/skills/${skillName}/SKILL.md`), `---\nname: ${skillName}\n---\n`);
  }
  for (const [skillName, pluginName] of Object.entries(OTHER_SKILLS)) {
    writeFile(path.join(repositoryRoot, `plugins/${pluginName}/skills/${skillName}/SKILL.md`), `---\nname: ${skillName}\n---\n`);
  }
}

function runScript(argumentsList, repositoryRoot) {
  const fixtureScript = path.join(repositoryRoot, 'scripts/sync-standalone-skills.mjs');
  return spawnSync(process.execPath, [fixtureScript, ...argumentsList], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-skills-test-'));
try {
  const sourceRoot = path.join(temporaryRoot, 'source');
  const targetRoot = path.join(temporaryRoot, 'target');
  writeFile(path.join(sourceRoot, 'nested/data.txt'), 'same\n');
  writeFile(path.join(sourceRoot, 'run.sh'), '#!/bin/sh\n', 0o755);
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });
  assert.deepEqual(compareTrees(sourceRoot, targetRoot, { label: 'generated' }), []);

  fs.writeFileSync(path.join(targetRoot, 'nested/data.txt'), 'changed\n');
  assert.match(compareTrees(sourceRoot, targetRoot, { label: 'generated' }).join('\n'), /file contents differ/);
  fs.writeFileSync(path.join(targetRoot, 'nested/data.txt'), 'same\n');

  fs.rmSync(path.join(targetRoot, 'nested/data.txt'));
  assert.match(compareTrees(sourceRoot, targetRoot, { label: 'generated' }).join('\n'), /generated entry is missing/);
  writeFile(path.join(targetRoot, 'nested/data.txt'), 'same\n');

  writeFile(path.join(targetRoot, 'extra.txt'), 'extra\n');
  assert.match(compareTrees(sourceRoot, targetRoot, { label: 'generated' }).join('\n'), /unexpected generated entry/);
  fs.rmSync(path.join(targetRoot, 'extra.txt'));

  fs.chmodSync(path.join(targetRoot, 'run.sh'), 0o644);
  assert.match(compareTrees(sourceRoot, targetRoot, { label: 'generated' }).join('\n'), /executable mode differs/);
  fs.chmodSync(path.join(targetRoot, 'run.sh'), 0o755);

  fs.symlinkSync('data.txt', path.join(targetRoot, 'nested/link.txt'));
  fs.symlinkSync('data.txt', path.join(sourceRoot, 'nested/link.txt'));
  assert.match(compareTrees(sourceRoot, targetRoot, { label: 'generated' }).join('\n'), /source symlinks are not supported/);
  fs.rmSync(path.join(targetRoot, 'nested/link.txt'));
  fs.rmSync(path.join(sourceRoot, 'nested/link.txt'));

  const repositoryRoot = path.join(temporaryRoot, 'repository');
  makeRepository(repositoryRoot);
  assert.throws(
    () => checkStandaloneSkills({ repositoryRoot }),
    (error) => error instanceof StandaloneSkillSyncError && /out of sync/.test(error.message),
  );
  const writeResult = writeStandaloneSkills({ repositoryRoot });
  assert.deepEqual(writeResult, { runtimeCopies: 3, standaloneSkills: 5 });
  assert.deepEqual(checkStandaloneSkills({ repositoryRoot }), writeResult);
  assert.equal(fs.statSync(path.join(repositoryRoot, 'skills/dsc-scrape/shared/run.sh')).mode & 0o111, 0o111);

  writeFile(path.join(repositoryRoot, 'skills/unexpected/SKILL.md'), 'unexpected\n');
  assert.throws(() => checkStandaloneSkills({ repositoryRoot }), StandaloneSkillSyncError);
  fs.rmSync(path.join(repositoryRoot, 'skills/unexpected'), { recursive: true });

  fs.writeFileSync(path.join(repositoryRoot, 'skills/dsc-scrape/SKILL.md'), 'drift\n');
  assert.throws(() => checkStandaloneSkills({ repositoryRoot }), StandaloneSkillSyncError);
  writeStandaloneSkills({ repositoryRoot });

  for (const helpOption of ['-h', '--help', '-ch']) {
    const result = runScript([helpOption], repositoryRoot);
    assert.equal(result.status, 0, helpOption);
    assert.match(result.stdout, /^Usage:/, helpOption);
    assert.equal(result.stderr, '', helpOption);
  }

  for (const invalidArguments of [[], ['--unknown'], ['--check', '--write'], ['--', '--check']]) {
    const result = runScript(invalidArguments, repositoryRoot);
    assert.equal(result.status, 2, invalidArguments.join(' '));
    assert.equal(result.stdout, '', invalidArguments.join(' '));
    assert.match(result.stderr, /^ERROR /, invalidArguments.join(' '));
  }

  fs.writeFileSync(path.join(repositoryRoot, 'skills/fork-and-pr/SKILL.md'), 'drift\n');
  const driftResult = runScript(['--check'], repositoryRoot);
  assert.equal(driftResult.status, 1);
  assert.equal(driftResult.stdout, '');
  assert.match(driftResult.stderr, /file contents differ/);

  const synchronizeResult = runScript(['-w'], repositoryRoot);
  assert.equal(synchronizeResult.status, 0);
  assert.match(synchronizeResult.stdout, /^Synchronized /);
  assert.equal(synchronizeResult.stderr, '');

  const checkResult = runScript(['-c'], repositoryRoot);
  assert.equal(checkResult.status, 0);
  assert.match(checkResult.stdout, /^Verified /);
  assert.equal(checkResult.stderr, '');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Standalone skill synchronization tests passed');
