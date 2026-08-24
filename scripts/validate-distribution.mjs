#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStandaloneSkills } from './sync-standalone-skills.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const MARKETPLACE_NAME = 'portable-agent-skills';
const PORTABLE_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const CLAUDE_SCHEMA = 'https://json.schemastore.org/claude-code-plugin-manifest.json';
const REPOSITORY_URL_PLACEHOLDER = '<repo-url>';
const STREAM_EVAL_URL_PLACEHOLDER = '<stream-eval-url>';
const LINK_PLACEHOLDERS = Object.freeze([REPOSITORY_URL_PLACEHOLDER, STREAM_EVAL_URL_PLACEHOLDER]);
const DOCUMENTATION_INDEX_PATH = 'docs/README.md';
const EXAMPLE_CATALOG_PATH = 'docs/examples/README.md';
const TRACKED_INDEX_ENTRIES = Object.freeze(execFileSync('git', ['ls-files', '--stage', '-z'], {
  cwd: REPOSITORY_ROOT,
  encoding: 'utf8',
}).split('\0').filter(Boolean).map((entry) => {
  const [metadata, relativePath] = entry.split('\t');
  return Object.freeze({ mode: metadata.split(' ')[0], relativePath });
}));
const TRACKED_PATHS = new Set(TRACKED_INDEX_ENTRIES.map(({ relativePath }) => relativePath));
const TRACKED_GITLINKS = Object.freeze(TRACKED_INDEX_ENTRIES
  .filter(({ mode }) => mode === '160000')
  .map(({ relativePath }) => relativePath));
const PLUGINS = Object.freeze({
  dsc: Object.freeze(['dsc-endpoint-help', 'dsc-scenario', 'dsc-scrape']),
  'fork-and-pr': Object.freeze(['fork-and-pr']),
  'stepped-demo-script': Object.freeze(['stepped-demo-script']),
});

function repositoryPath(...parts) {
  return path.join(REPOSITORY_ROOT, ...parts);
}

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(repositoryPath(...parts), 'utf8'));
}

function repositoryRelativePath(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join('/');
}

function isTrackedRepositoryDestination(filePath) {
  const relative = repositoryRelativePath(filePath).replace(/\/$/, '');
  if (relative.length === 0 || TRACKED_PATHS.has(relative)) return true;
  if (TRACKED_INDEX_ENTRIES.some(({ relativePath }) => relativePath.startsWith(`${relative}/`))) return true;
  return TRACKED_GITLINKS.some((gitlink) => relative.startsWith(`${gitlink}/`));
}

function assertNoSymlinks(contentRoot, contentLabel) {
  const pending = [contentRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `${entryPath} is a symlink, which ${contentLabel} installs omit`);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

function assertContainedMarkdownLinks(contentRoot, contentLabel) {
  const pending = [contentRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      const source = fs.readFileSync(entryPath, 'utf8');
      const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
      for (const match of links) {
        const link = match[1].replace(/^<|>$/g, '');
        if (/^[a-z][a-z+.-]*:/i.test(link) || link.startsWith('#')) continue;
        const destination = decodeURIComponent(link.split('#')[0]);
        if (destination.length === 0) continue;
        const resolved = path.resolve(path.dirname(entryPath), destination);
        const relative = path.relative(contentRoot, resolved);
        assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${entryPath} links outside its ${contentLabel}: ${link}`);
        assert.equal(fs.existsSync(resolved), true, `${entryPath} has a broken link: ${link}`);
      }
    }
  }
}

function assertMarkdownFileLinks(contentRoot, relativePath) {
  const filePath = path.join(contentRoot, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    if (LINK_PLACEHOLDERS.includes(match[1])) continue;
    const link = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z+.-]*:/i.test(link) || link.startsWith('#')) continue;
    const destination = decodeURIComponent(link.split('#')[0]);
    if (destination.length === 0) continue;
    const resolved = path.resolve(path.dirname(filePath), destination);
    const relative = path.relative(contentRoot, resolved);
    assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${relativePath} links outside the repository: ${link}`);
    assert.equal(fs.existsSync(resolved), true, `${relativePath} has a broken link: ${link}`);
    assert.equal(isTrackedRepositoryDestination(resolved), true, `${relativePath} links to an untracked path: ${link}`);
  }
}

function relativeMarkdownLink(fromPath, toPath) {
  return path.relative(path.dirname(fromPath), toPath).split(path.sep).join('/');
}

function pluginExamplePaths(pluginName) {
  const pluginRoot = repositoryPath('plugins', pluginName);
  const pending = [pluginRoot];
  const examples = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const relativePath = path.relative(pluginRoot, entryPath);
      if (relativePath.split(path.sep).includes('examples')) {
        examples.push(repositoryRelativePath(entryPath));
      }
    }
  }
  return examples.sort();
}

const pluginNames = Object.keys(PLUGINS);
const codexMarketplace = readJson('.agents', 'plugins', 'marketplace.json');
const claudeMarketplace = readJson('.claude-plugin', 'marketplace.json');

checkStandaloneSkills({ repositoryRoot: REPOSITORY_ROOT });

assert.equal(codexMarketplace.name, MARKETPLACE_NAME);
assert.equal(claudeMarketplace.name, MARKETPLACE_NAME);
assert.deepEqual(codexMarketplace.plugins.map(({ name }) => name), pluginNames);
assert.deepEqual(claudeMarketplace.plugins.map(({ name }) => name), pluginNames);

for (const [pluginName, skillNames] of Object.entries(PLUGINS)) {
  const pluginRoot = repositoryPath('plugins', pluginName);
  const pluginReadme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  const portableManifest = readJson('plugins', pluginName, 'plugin.json');
  const codexManifest = readJson('plugins', pluginName, '.codex-plugin', 'plugin.json');
  const claudeManifest = readJson('plugins', pluginName, '.claude-plugin', 'plugin.json');

  assert.equal(portableManifest.$schema, PORTABLE_SCHEMA);
  assert.equal(claudeManifest.$schema, CLAUDE_SCHEMA);
  assert.equal(portableManifest.name, pluginName);
  assert.equal(codexManifest.name, pluginName);
  assert.equal(claudeManifest.name, pluginName);
  assert.equal(portableManifest.version, codexManifest.version);
  assert.equal(portableManifest.version, claudeManifest.version);
  assert.equal(portableManifest.description, codexManifest.description);
  assert.equal(portableManifest.description, claudeManifest.description);
  assert.equal(portableManifest.license, codexManifest.license);
  assert.equal(portableManifest.license, claudeManifest.license);
  assert.deepEqual(portableManifest.extensions['com.openai'].interface, codexManifest.interface);
  assert.equal(codexManifest.skills, './skills/');
  assert.equal(fs.existsSync(path.join(pluginRoot, 'LICENSE')), true, `${pluginName} must bundle its license`);
  for (const heading of ['## Install', '### Codex', '### Claude Code', '### OpenCode']) {
    assert.equal(pluginReadme.includes(heading), true, `${pluginName} README is missing ${heading}`);
  }
  assert.equal(pluginReadme.includes(`codex plugin add ${pluginName}@${MARKETPLACE_NAME}`), true, `${pluginName} README is missing its Codex install command`);
  assert.equal(pluginReadme.includes(`claude plugin install ${pluginName}@${MARKETPLACE_NAME}`), true, `${pluginName} README is missing its Claude Code install command`);
  assert.equal(pluginReadme.includes(`/agent-skills/plugins/${pluginName}/skills`), true, `${pluginName} README is missing its OpenCode skills path`);

  const codexEntry = codexMarketplace.plugins.find(({ name }) => name === pluginName);
  const claudeEntry = claudeMarketplace.plugins.find(({ name }) => name === pluginName);
  assert.deepEqual(codexEntry.source, { source: 'local', path: `./plugins/${pluginName}` });
  assert.equal(claudeEntry.source, `./plugins/${pluginName}`);

  for (const skillName of skillNames) {
    const canonicalSkill = path.join(pluginRoot, 'skills', skillName);
    const standaloneSkill = repositoryPath('skills', skillName);
    assert.equal(fs.existsSync(path.join(canonicalSkill, 'SKILL.md')), true, `${skillName} is missing SKILL.md`);
    assert.equal(fs.lstatSync(standaloneSkill).isDirectory(), true, `${skillName} standalone package must be a directory`);
    assertNoSymlinks(standaloneSkill, 'standalone skill');
    assertContainedMarkdownLinks(standaloneSkill, 'standalone skill');
  }

  assertNoSymlinks(pluginRoot, 'Codex plugin');
  assertContainedMarkdownLinks(pluginRoot, 'plugin');
}

assert.equal(fs.readFileSync(repositoryPath('CLAUDE.md'), 'utf8').startsWith('@AGENTS.md\n'), true, 'CLAUDE.md must import canonical AGENTS.md');
const repositoryReadme = fs.readFileSync(repositoryPath('README.md'), 'utf8');
const exampleCatalog = fs.readFileSync(repositoryPath(EXAMPLE_CATALOG_PATH), 'utf8');
assert.equal(repositoryReadme.includes(REPOSITORY_URL_PLACEHOLDER), true, 'README.md must retain the neutral repository URL placeholder');
assert.equal(repositoryReadme.includes(STREAM_EVAL_URL_PLACEHOLDER), true, 'README.md must retain the neutral stream-eval URL placeholder');
assert.equal(repositoryReadme.includes('](docs/)'), true, 'README.md must link to the documentation index');
assert.equal(repositoryReadme.includes('](docs/examples/)'), true, 'README.md must link to the worked-example catalog');
for (const pluginName of pluginNames) {
  assert.equal(repositoryReadme.includes(`codex plugin add ${pluginName}@${MARKETPLACE_NAME}`), true, `README.md must document Codex installation for ${pluginName}`);
  assert.equal(repositoryReadme.includes(`claude plugin install ${pluginName}@${MARKETPLACE_NAME}`), true, `README.md must document Claude Code installation for ${pluginName}`);
  assert.equal(repositoryReadme.includes(`/agent-skills/plugins/${pluginName}/skills`), true, `README.md must document OpenCode installation for ${pluginName}`);
  for (const examplePath of pluginExamplePaths(pluginName)) {
    const catalogLink = relativeMarkdownLink(EXAMPLE_CATALOG_PATH, examplePath);
    assert.equal(exampleCatalog.includes(`](${catalogLink})`), true, `${EXAMPLE_CATALOG_PATH} must link to ${examplePath}`);
  }
}
assertMarkdownFileLinks(REPOSITORY_ROOT, 'AGENTS.md');
assertMarkdownFileLinks(REPOSITORY_ROOT, 'README.md');
assertMarkdownFileLinks(REPOSITORY_ROOT, DOCUMENTATION_INDEX_PATH);
assertMarkdownFileLinks(REPOSITORY_ROOT, 'docs/distribution.md');
assertMarkdownFileLinks(REPOSITORY_ROOT, EXAMPLE_CATALOG_PATH);
console.log(`Validated ${pluginNames.length} plugins across portable, Codex, Claude, and OpenCode distributions`);
