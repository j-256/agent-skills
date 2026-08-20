#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const MARKETPLACE_NAME = 'portable-agent-skills';
const PORTABLE_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const CLAUDE_SCHEMA = 'https://json.schemastore.org/claude-code-plugin-manifest.json';
const PLUGINS = Object.freeze({
  dsc: Object.freeze(['dsc-endpoint-help', 'dsc-scenario', 'dsc-scrape']),
  'fork-and-pr': Object.freeze(['fork-and-pr']),
  'stepped-demo-script': Object.freeze(['stepped-demo-script']),
});
const COMPATIBILITY_LINKS = Object.freeze({
  'docs/commerce-auth-matrix.md': 'plugins/dsc/docs/commerce-auth-matrix.md',
  'docs/dsc-skills.md': 'plugins/dsc/docs/dsc-skills.md',
  'docs/examples/demo-find-delete-no-prompt.md': 'plugins/stepped-demo-script/examples/demo-find-delete-no-prompt.md',
  'docs/examples/diff-jwt-scope-decode.md': 'plugins/dsc/examples/diff-jwt-scope-decode.md',
  'docs/examples/fork-and-pr-standard-flow.md': 'plugins/fork-and-pr/examples/fork-and-pr-standard-flow.md',
  'docs/examples/scenario-add-coupon-checkout.md': 'plugins/dsc/examples/scenario-add-coupon-checkout.md',
  'docs/examples/scenario-createorder-prereqs.md': 'plugins/dsc/examples/scenario-createorder-prereqs.md',
  'docs/examples/scenario-inreference-prereq.md': 'plugins/dsc/examples/scenario-inreference-prereq.md',
  'docs/examples/scenario-ocapi-submit-basket.md': 'plugins/dsc/examples/scenario-ocapi-submit-basket.md',
  'docs/examples/scrape-agentforce-references.md': 'plugins/dsc/examples/scrape-agentforce-references.md',
});

function repositoryPath(...parts) {
  return path.join(REPOSITORY_ROOT, ...parts);
}

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(repositoryPath(...parts), 'utf8'));
}

function assertSymlink(aliasPath, expectedPath) {
  assert.equal(fs.lstatSync(aliasPath).isSymbolicLink(), true, `${aliasPath} must be a symlink`);
  assert.equal(fs.realpathSync(aliasPath), fs.realpathSync(expectedPath), `${aliasPath} has the wrong target`);
}

function assertContainedSymlinks(pluginRoot) {
  const resolvedRoot = fs.realpathSync(pluginRoot);
  const pending = [pluginRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(entryPath);
        const relative = path.relative(resolvedRoot, target);
        assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${entryPath} escapes its plugin`);
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

function assertContainedMarkdownLinks(pluginRoot) {
  const pending = [pluginRoot];
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
        const relative = path.relative(pluginRoot, resolved);
        assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${entryPath} links outside its plugin: ${link}`);
        assert.equal(fs.existsSync(resolved), true, `${entryPath} has a broken link: ${link}`);
      }
    }
  }
}

const pluginNames = Object.keys(PLUGINS);
const codexMarketplace = readJson('.agents', 'plugins', 'marketplace.json');
const claudeMarketplace = readJson('.claude-plugin', 'marketplace.json');

assert.equal(codexMarketplace.name, MARKETPLACE_NAME);
assert.equal(claudeMarketplace.name, MARKETPLACE_NAME);
assert.deepEqual(codexMarketplace.plugins.map(({ name }) => name), pluginNames);
assert.deepEqual(claudeMarketplace.plugins.map(({ name }) => name), pluginNames);

for (const [pluginName, skillNames] of Object.entries(PLUGINS)) {
  const pluginRoot = repositoryPath('plugins', pluginName);
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

  const codexEntry = codexMarketplace.plugins.find(({ name }) => name === pluginName);
  const claudeEntry = claudeMarketplace.plugins.find(({ name }) => name === pluginName);
  assert.deepEqual(codexEntry.source, { source: 'local', path: `./plugins/${pluginName}` });
  assert.equal(claudeEntry.source, `./plugins/${pluginName}`);

  for (const skillName of skillNames) {
    const canonicalSkill = path.join(pluginRoot, 'skills', skillName);
    assert.equal(fs.existsSync(path.join(canonicalSkill, 'SKILL.md')), true, `${skillName} is missing SKILL.md`);
    assertSymlink(repositoryPath('skills', skillName), canonicalSkill);
  }

  assertContainedSymlinks(pluginRoot);
  assertContainedMarkdownLinks(pluginRoot);
}

assertSymlink(repositoryPath('skills', '_shared'), repositoryPath('plugins', 'dsc', 'shared'));
for (const [aliasPath, canonicalPath] of Object.entries(COMPATIBILITY_LINKS)) {
  assertSymlink(repositoryPath(aliasPath), repositoryPath(canonicalPath));
}
console.log(`Validated ${pluginNames.length} plugins across portable, Codex, and Claude distributions`);
