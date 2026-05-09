'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCENARIO = path.join(__dirname, '..', 'scripts', 'scenario.js');
const FAKE_SCRAPE = path.join(__dirname, '..', '..', '_shared', 'tests', 'fixtures', 'fake-scrape.js');
const CACHE = path.join(__dirname, 'fixtures');

function runScenario(input, extraEnv = {}) {
  const res = spawnSync('node', [SCENARIO], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'ok-fresh', ...extraEnv },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Scenario: getItem target, structural walk locally, emits full plan + cURL
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/tiny-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runScenario(input);
  assert.equal(code, 0, `scenario should exit 0; stderr was: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.equal(out.plan.targetSlug, 'getItem');
  assert.equal(out.plan.steps[out.plan.steps.length - 1].slug, 'getItem');
  assert.ok(out.plan.combinedScopes.length > 0);
  assert.ok(out.runnable.startsWith('#!/usr/bin/env bash'));
  assert.ok(out.sources.length > 0);
  assert.ok(out.sources.every((u) => /^https:\/\/developer\.salesforce\.com\//.test(u)));
}

// Scenario: graph provided in input – different edge structure than local walk would produce,
// proving scenario.js honors the provided graph rather than silently falling back.
{
  // Local walkTypes for target 'addItem' yields: createContainer -> addItem via containerId.
  // This provided graph claims addItem requires TWO fields (containerId AND itemFingerprint),
  // and adds a getItem producer for itemFingerprint. If scenario.js ran walkTypes locally,
  // getItem would NOT be in the plan (it's not a producer for addItem in the real fixtures).
  const providedGraph = {
    nodes: [
      { slug: 'createContainer', method: 'POST', path: '/containers',
        producedTypes: [{ name: 'Container', ref: '#/types/Container' }],
        requiredInputs: [] },
      { slug: 'getItem', method: 'GET', path: '/containers/{containerId}/items/{itemId}',
        producedTypes: [{ name: 'Item', ref: '#/types/Item' }],
        requiredInputs: [] },
      { slug: 'addItem', method: 'POST', path: '/containers/{containerId}/items',
        producedTypes: [{ name: 'Item', ref: '#/types/Item' }],
        requiredInputs: [
          { name: 'containerId', in: 'path', typeRef: null, typeName: 'string' },
        ] },
    ],
    edges: [
      { from: 'createContainer', to: 'addItem', viaField: 'containerId' },
      { from: 'getItem', to: 'addItem', viaField: 'containerId' },  // contrived but diagnostic
    ],
  };
  const input = {
    target: 'addItem',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/tiny-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    graph: providedGraph,
  };
  const { code, stdout } = runScenario(input);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  const slugs = out.plan.steps.map((s) => s.slug);
  // Local walkTypes would NOT include getItem for target=addItem.
  // Its presence here proves the provided graph was honored.
  assert.ok(slugs.includes('getItem'), `expected getItem in plan (provided graph honored); got ${slugs.join(',')}`);
  assert.equal(slugs[slugs.length - 1], 'addItem');  // target still sink
}

// Scenario: missing target resolves to error
{
  const input = {
    target: 'nonexistent',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/tiny-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
  };
  const { code, stderr } = runScenario(input);
  assert.equal(code, 2);
  assert.match(stderr, /target|not found/i);
}

// Invalid JSON on stdin -> exit 2
{
  const res = spawnSync('node', [SCENARIO], {
    input: 'this is not json',
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'ok-fresh' },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /expected JSON on stdin/i);
}

// Scrape failure (fake-scrape exits 1) -> exit 3
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/tiny-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
  };
  const { code, stderr } = runScenario(input, { FAKE_MODE: 'not-found' });
  assert.equal(code, 3);
  assert.match(stderr, /scrape failed/i);
}

console.log('ok');
