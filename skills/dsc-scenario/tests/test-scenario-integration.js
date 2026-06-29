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
  // The LOCAL walk (no `graph` in the input) must produce the full multi-step
  // chain, not a degraded target-only plan. This is the regression that the
  // responses-layout drift caused: producedTypes() found zero edges on the real
  // layout, so scenario.js's local fallback collapsed to a single step. Assert
  // the producer chain is present and correctly ordered end-to-end.
  const localSlugs = out.plan.steps.map((s) => s.slug);
  assert.deepEqual([...localSlugs].sort(), ['addItem', 'createContainer', 'getItem'],
    `local walk must yield the full chain; got ${localSlugs.join(',')}`);
  assert.ok(localSlugs.indexOf('createContainer') < localSlugs.indexOf('addItem'),
    'createContainer must precede addItem');
  assert.ok(localSlugs.indexOf('addItem') < localSlugs.indexOf('getItem'),
    'addItem must precede getItem');
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

// Scrape failure with NO cached data -> exit 3 (hard fail). Uses an uncached
// reference so the accessor can't serve stale: refresh fails AND nothing on disk.
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/uncached-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
  };
  const { code, stderr } = runScenario(input, { FAKE_MODE: 'not-found' });
  assert.equal(code, 3, `uncached + failed scrape must hard-fail; stderr: ${stderr}`);
  assert.match(stderr, /scrape failed|no cached data/i);
}

// Scrape failure WITH cached data -> serve stale (exit 0) and surface staleness.
// tiny-ref is a committed fixture (already on disk), so a failed refresh must
// fall back to the cached spec rather than erroring -- and the run must report
// which reference was served stale, with its scrapedAt, so the answer can warn.
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/tiny-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runScenario(input, { FAKE_MODE: 'not-found' });
  assert.equal(code, 0, `cached + failed scrape must serve stale (exit 0); stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.ok(Array.isArray(out.staleness), 'output carries a staleness array');
  assert.ok(out.staleness.some((s) => s.reference === 'tiny-ref' && typeof s.scrapedAt === 'string'),
    `staleness must name tiny-ref with its scrapedAt; got ${JSON.stringify(out.staleness)}`);
  // The plan still composes against the stale spec.
  assert.equal(out.plan.steps[out.plan.steps.length - 1].slug, 'getItem');
}

// Scenario: flowSignal in stdin JSON is parsed and threaded into composePlan.
// tiny-ref's getItem uses scheme 'Bearer' which routes to authBranch='unknown'
// in pickAuthBranch -- so authFlow stays null regardless of the flowSignal value.
// The signal here is that the run completes cleanly (exit 0) and emits the
// auth fields composePlan now adds. If scenario.js dropped flowSignal from
// the destructure, this test still passes for tiny-ref -- but adding the
// assertion that plan exposes authBranch/authFlow shape catches regressions
// where someone removes the composePlan arg entirely (authBranch would be
// undefined rather than 'unknown').
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/tiny-area/references/tiny-ref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    flowSignal: 'registered-b2c',
  };
  const { code, stdout, stderr } = runScenario(input);
  assert.equal(code, 0, `scenario should exit 0 with flowSignal; stderr was: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.equal(out.plan.authBranch, 'unknown', 'tiny-ref Bearer routes to unknown branch');
  assert.equal(out.plan.authFlow, null, 'unknown branch leaves authFlow null');
}

// Prefer-latest: a target in a reference that has a newer version must bump,
// so the emitted plan + sources cite the -v2 reference, not the bare one.
// ver-area's _landing/ver-area.json lists verref + verref-v2; scenario.js
// scrapes first (writing the landing on a real cache), calls resolveVersions,
// sees the v2 sibling, re-scrapes verref-v2, and threads it through.
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/ver-area/references/verref',  // bare, unversioned
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runScenario(input);
  assert.equal(code, 0, `scenario should exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.equal(out.plan.reference, 'verref-v2', 'plan reference must be the bumped (-v2) slug');
  // Every cited source must be the -v2 reference after the bump.
  assert.ok(out.sources.length > 0, 'plan must emit sources');
  assert.ok(out.sources.some((u) => /references\/verref-v2/.test(u)),
    'sources must cite the latest (-v2) reference after the bump');
  assert.ok(!out.sources.some((u) => /references\/verref(?![-\w])/.test(u)),
    'no source should cite the bare (v1) reference after the bump');
}

// pinVersion: when the caller pins the version, do NOT bump -- the bare (v1)
// reference is honored even though a -v2 sibling exists in the landing.
{
  const input = {
    target: 'getItem',
    referenceUrl: 'https://developer.salesforce.com/docs/ver-area/references/verref',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    pinVersion: true,
  };
  const { code, stdout, stderr } = runScenario(input);
  assert.equal(code, 0, `scenario should exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.equal(out.plan.reference, 'verref', 'with pinVersion, plan reference must stay the bare (v1) slug');
  assert.ok(out.sources.some((u) => /references\/verref(?![-\w])/.test(u)),
    'with pinVersion, sources must keep the bare (v1) reference');
  assert.ok(!out.sources.some((u) => /references\/verref-v2/.test(u)),
    'with pinVersion, no source should cite the -v2 reference');
}

console.log('ok');
