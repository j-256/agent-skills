import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./freshness.mjs', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cover-freshness-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
  writeFileSync(join(root, 'source.txt'), 'source one\n');
  writeFileSync(join(root, 'docs/screenshots/cover.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const commit = (...files) => { git('add', '--', ...files); git('commit', '-qm', 'Fixture change', '--', ...files); };
  commit('source.txt', 'docs/screenshots/cover.png');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, commit, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the record remains valid after committing only generated files', () => {
  const data = fixture();
  try {
    assert.equal(data.run('--write').status, 0);
    data.commit('docs/screenshots/cover-source.json');
    const check = data.run('--check');
    assert.equal(check.status, 0, check.stderr);
  } finally { data.cleanup(); }
});

for (const filename of ['source.txt', 'docs/screenshots/cover.png']) {
  test(`rejects an unrecorded committed change to ${filename}`, () => {
    const data = fixture();
    try {
      assert.equal(data.run('--write').status, 0);
      data.commit('docs/screenshots/cover-source.json');
      writeFileSync(join(data.root, filename), 'different bytes');
      data.commit(filename);
      assert.equal(data.run('--check').status, 1);
    } finally { data.cleanup(); }
  });
}

test('does not record a cover while source files have uncommitted changes', () => {
  const data = fixture();
  try {
    writeFileSync(join(data.root, 'source.txt'), 'uncommitted input');
    assert.equal(data.run('--write').status, 1);
  } finally { data.cleanup(); }
});
