#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const DSC_SKILL_NAMES = Object.freeze([
  'dsc-endpoint-help',
  'dsc-scenario',
  'dsc-scrape',
]);
const SKILL_SOURCES = Object.freeze({
  'dsc-endpoint-help': 'plugins/dsc/skills/dsc-endpoint-help',
  'dsc-scenario': 'plugins/dsc/skills/dsc-scenario',
  'dsc-scrape': 'plugins/dsc/skills/dsc-scrape',
  'fork-and-pr': 'plugins/fork-and-pr/skills/fork-and-pr',
  'stepped-demo-script': 'plugins/stepped-demo-script/skills/stepped-demo-script',
});
const SHARED_SOURCE = 'plugins/dsc/shared';
const OBSOLETE_SHARED_ALIAS = 'skills/_shared';
const EXECUTABLE_MODE_MASK = 0o111;
const HELP = `Usage: node scripts/sync-standalone-skills.mjs (--check | --write)

Synchronize independently installable root skills with their canonical plugin sources.

Options:
  -c, --check  Report generated-tree drift without changing files
  -w, --write  Refresh vendored DSC runtimes and root standalone skills
  -h, --help   Show this help and exit

Exit statuses:
  0  Requested operation succeeded
  1  Generated content is stale or synchronization failed
  2  Arguments are invalid
`;

export class StandaloneSkillSyncError extends Error {
  constructor(message, differences = []) {
    super(message);
    this.name = 'StandaloneSkillSyncError';
    this.differences = differences;
  }
}

function repositoryPath(repositoryRoot, relativePath) {
  return path.join(repositoryRoot, ...relativePath.split('/'));
}

function relativeDisplayPath(relativePath) {
  return relativePath.length === 0 ? '.' : relativePath.split(path.sep).join('/');
}

function entryKind(stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'unsupported entry';
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function differencePath(label, relativePath) {
  const suffix = relativeDisplayPath(relativePath);
  return suffix === '.' ? label : `${label}/${suffix}`;
}

export function compareTrees(sourceRoot, targetRoot, { label = path.basename(targetRoot) } = {}) {
  const differences = [];

  function compare(relativePath) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    const sourceStat = lstatIfPresent(sourcePath);
    const targetStat = lstatIfPresent(targetPath);
    const displayPath = differencePath(label, relativePath);

    if (!sourceStat) {
      differences.push(`${displayPath}: source entry is missing`);
      return;
    }
    if (!targetStat) {
      differences.push(`${displayPath}: generated entry is missing`);
      return;
    }

    const sourceKind = entryKind(sourceStat);
    const targetKind = entryKind(targetStat);
    if (sourceKind === 'symlink') {
      differences.push(`${displayPath}: source symlinks are not supported`);
      return;
    }
    if (targetKind === 'symlink') {
      differences.push(`${displayPath}: generated symlinks are not supported`);
      return;
    }
    if (sourceKind !== targetKind) {
      differences.push(`${displayPath}: expected ${sourceKind}, found ${targetKind}`);
      return;
    }
    if (sourceKind === 'unsupported entry') {
      differences.push(`${displayPath}: unsupported source entry type`);
      return;
    }

    if (sourceKind === 'file') {
      const sourceExecutableMode = sourceStat.mode & EXECUTABLE_MODE_MASK;
      const targetExecutableMode = targetStat.mode & EXECUTABLE_MODE_MASK;
      if (sourceExecutableMode !== targetExecutableMode) {
        differences.push(`${displayPath}: executable mode differs`);
      }
      if (!fs.readFileSync(sourcePath).equals(fs.readFileSync(targetPath))) {
        differences.push(`${displayPath}: file contents differ`);
      }
      return;
    }

    const sourceEntries = new Set(fs.readdirSync(sourcePath));
    const targetEntries = new Set(fs.readdirSync(targetPath));
    const entryNames = [...new Set([...sourceEntries, ...targetEntries])].sort();
    for (const entryName of entryNames) {
      const childRelativePath = path.join(relativePath, entryName);
      if (!sourceEntries.has(entryName)) {
        differences.push(`${differencePath(label, childRelativePath)}: unexpected generated entry`);
        continue;
      }
      if (!targetEntries.has(entryName)) {
        differences.push(`${differencePath(label, childRelativePath)}: generated entry is missing`);
        continue;
      }
      compare(childRelativePath);
    }
  }

  compare('');
  return differences;
}

function copyTree(sourcePath, targetPath) {
  const sourceStat = fs.lstatSync(sourcePath);
  const sourceKind = entryKind(sourceStat);
  if (sourceKind === 'symlink' || sourceKind === 'unsupported entry') {
    throw new StandaloneSkillSyncError(`Cannot copy ${sourcePath}: ${sourceKind} is not supported`);
  }
  if (sourceKind === 'file') {
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, sourceStat.mode & 0o777);
    return;
  }

  fs.mkdirSync(targetPath);
  for (const entryName of fs.readdirSync(sourcePath).sort()) {
    copyTree(path.join(sourcePath, entryName), path.join(targetPath, entryName));
  }
  fs.chmodSync(targetPath, sourceStat.mode & 0o777);
}

function replaceTree(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.sync-`));
  const stagedTree = path.join(stagingRoot, 'tree');
  try {
    copyTree(sourcePath, stagedTree);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.renameSync(stagedTree, targetPath);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function runtimeMappings(repositoryRoot) {
  const sourcePath = repositoryPath(repositoryRoot, SHARED_SOURCE);
  return DSC_SKILL_NAMES.map((skillName) => {
    const targetRelativePath = `${SKILL_SOURCES[skillName]}/shared`;
    return Object.freeze({
      sourcePath,
      targetPath: repositoryPath(repositoryRoot, targetRelativePath),
      targetRelativePath,
    });
  });
}

function standaloneMappings(repositoryRoot) {
  return Object.entries(SKILL_SOURCES).map(([skillName, sourceRelativePath]) => {
    const targetRelativePath = `skills/${skillName}`;
    return Object.freeze({
      sourcePath: repositoryPath(repositoryRoot, sourceRelativePath),
      targetPath: repositoryPath(repositoryRoot, targetRelativePath),
      targetRelativePath,
    });
  });
}

export function checkStandaloneSkills({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const differences = [];
  const obsoleteAliasPath = repositoryPath(repositoryRoot, OBSOLETE_SHARED_ALIAS);
  if (lstatIfPresent(obsoleteAliasPath)) {
    differences.push(`${OBSOLETE_SHARED_ALIAS}: obsolete shared alias must be absent`);
  }
  const standaloneRoot = repositoryPath(repositoryRoot, 'skills');
  const expectedStandaloneEntries = new Set(Object.keys(SKILL_SOURCES));
  const standaloneRootStat = lstatIfPresent(standaloneRoot);
  if (!standaloneRootStat) {
    differences.push('skills: standalone root is missing');
  } else if (standaloneRootStat.isSymbolicLink()) {
    differences.push('skills: standalone root must not be a symlink');
  } else if (!standaloneRootStat.isDirectory()) {
    differences.push('skills: standalone root must be a directory');
  } else {
    for (const entryName of fs.readdirSync(standaloneRoot).sort()) {
      if (entryName === path.basename(OBSOLETE_SHARED_ALIAS)) continue;
      if (!expectedStandaloneEntries.has(entryName)) {
        differences.push(`skills/${entryName}: unexpected standalone entry`);
      }
    }
  }

  for (const mapping of runtimeMappings(repositoryRoot)) {
    differences.push(...compareTrees(mapping.sourcePath, mapping.targetPath, {
      label: mapping.targetRelativePath,
    }));
  }
  for (const mapping of standaloneMappings(repositoryRoot)) {
    differences.push(...compareTrees(mapping.sourcePath, mapping.targetPath, {
      label: mapping.targetRelativePath,
    }));
  }

  if (differences.length > 0) {
    throw new StandaloneSkillSyncError('Standalone skill copies are out of sync', differences);
  }
  return Object.freeze({
    runtimeCopies: DSC_SKILL_NAMES.length,
    standaloneSkills: Object.keys(SKILL_SOURCES).length,
  });
}

export function writeStandaloneSkills({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  for (const mapping of runtimeMappings(repositoryRoot)) {
    replaceTree(mapping.sourcePath, mapping.targetPath);
  }
  fs.rmSync(repositoryPath(repositoryRoot, OBSOLETE_SHARED_ALIAS), { recursive: true, force: true });
  for (const mapping of standaloneMappings(repositoryRoot)) {
    replaceTree(mapping.sourcePath, mapping.targetPath);
  }
  return checkStandaloneSkills({ repositoryRoot });
}

function expandShortOptions(argumentsList) {
  const expanded = [];
  let passthrough = false;
  for (const argument of argumentsList) {
    if (passthrough) {
      expanded.push(argument);
      continue;
    }
    if (argument === '--') {
      passthrough = true;
      expanded.push(argument);
      continue;
    }
    if (/^-[^-].+/.test(argument)) {
      for (const option of argument.slice(1)) expanded.push(`-${option}`);
      continue;
    }
    expanded.push(argument);
  }
  return expanded;
}

function parseArguments(argumentsList) {
  let mode = null;
  let afterOptions = false;
  for (const argument of expandShortOptions(argumentsList)) {
    if (argument === '--') {
      afterOptions = true;
      continue;
    }
    if (!afterOptions && (argument === '-h' || argument === '--help')) return Object.freeze({ help: true });
    const requestedMode = !afterOptions && (argument === '-c' || argument === '--check')
      ? 'check'
      : !afterOptions && (argument === '-w' || argument === '--write')
        ? 'write'
        : null;
    if (!requestedMode) {
      throw new StandaloneSkillSyncError(`Invalid argument: ${argument}`);
    }
    if (mode && mode !== requestedMode) {
      throw new StandaloneSkillSyncError('--check and --write cannot be combined');
    }
    mode = requestedMode;
  }
  if (!mode) throw new StandaloneSkillSyncError('Choose either --check or --write');
  return Object.freeze({ help: false, mode });
}

export function runCli(argumentsList, {
  repositoryRoot = REPOSITORY_ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let options;
  try {
    options = parseArguments(argumentsList);
  } catch (error) {
    stderr.write(`ERROR ${error.message}\nRun with --help for usage\n`);
    return 2;
  }

  if (options.help) {
    stdout.write(HELP);
    return 0;
  }

  try {
    const result = options.mode === 'write'
      ? writeStandaloneSkills({ repositoryRoot })
      : checkStandaloneSkills({ repositoryRoot });
    const verb = options.mode === 'write' ? 'Synchronized' : 'Verified';
    stdout.write(`${verb} ${result.runtimeCopies} DSC runtime copies and ${result.standaloneSkills} standalone skills\n`);
    return 0;
  } catch (error) {
    stderr.write(`ERROR ${error.message}\n`);
    if (error instanceof StandaloneSkillSyncError) {
      for (const difference of error.differences) stderr.write(`  ${difference}\n`);
    }
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH)) {
  process.exitCode = runCli(process.argv.slice(2));
}
