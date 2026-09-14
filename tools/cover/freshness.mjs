import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const COVER = 'docs/screenshots/cover.png';
const RECORD = 'docs/screenshots/cover-source.json';
const GENERATED = new Set([COVER, RECORD]);
const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: node tools/cover/freshness.mjs <--check|--write> [REF]\n\nCheck the committed cover record, or record a freshly captured cover after\ncommitting its inputs. REF defaults to HEAD. Requires Node and Git.\nExit status: 0 success, 1 stale or invalid cover, 2 usage, 3 missing Git.');
  process.exit(0);
}
if (!['--check', '--write'].includes(args[0]) || args.length > 2 || args.length < 1) {
  console.error('freshness: expected --check or --write; see --help');
  process.exit(2);
}
const [mode, ref = 'HEAD'] = args;
const git = (...arguments_) => execFileSync('git', arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
const digest = data => createHash('sha256').update(data).digest('hex');
try {
  const revision = git('rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
  const entries = git('ls-tree', '-rz', '--full-tree', revision).toString().split('\0').filter(Boolean);
  const inputs = entries.filter(entry => !GENERATED.has(entry.slice(entry.indexOf('\t') + 1)));
  const sourceDigest = digest(inputs.join('\0') + '\0');
  if (mode === '--write') {
    assert.equal(revision, git('rev-parse', 'HEAD').toString().trim(), 'Record only the checked-out revision');
    const changes = git('status', '--porcelain=v1', '-z', '--untracked-files=all').toString().split('\0').filter(Boolean);
    assert.ok(changes.every(entry => GENERATED.has(entry.slice(3))), 'Commit source changes before preparing the cover');
    const png = readFileSync(COVER);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Cover must be a PNG');
    writeFileSync(RECORD, JSON.stringify({ version: 1, inputs_sha256: sourceDigest, image_sha256: digest(png) }, null, 2) + '\n');
    console.log('Recorded the generated cover and its source inputs');
  } else {
    const record = JSON.parse(git('show', `${revision}:${RECORD}`));
    assert.equal(record.version, 1, 'Unknown cover record version');
    assert.equal(record.inputs_sha256, sourceDigest, 'Cover inputs changed; run the publication preparation command');
    assert.equal(record.image_sha256, digest(git('show', `${revision}:${COVER}`)), 'Cover bytes differ from their freshness record');
    console.log('Committed cover matches its recorded source inputs and image bytes');
  }
} catch (error) {
  console.error(`cover freshness: ${error.message}`);
  process.exitCode = error.code === 'ENOENT' ? 3 : 1;
}
