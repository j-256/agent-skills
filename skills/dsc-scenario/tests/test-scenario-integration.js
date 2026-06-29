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

// Cross-reference bridge, two-pass. Pass 1: submitWidget (body=Widget, produced
// by refB) returns bridgeCandidates including createWidget. Pass 2 with
// bridgeProducer=createWidget composes a 2-reference plan.
{
  const base = {
    target: 'submitWidget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const p1 = runScenario(base);
  assert.equal(p1.code, 0, `pass1 exit 0; stderr: ${p1.stderr}`);
  const o1 = JSON.parse(p1.stdout);
  assert.ok(Array.isArray(o1.bridgeCandidates) && o1.bridgeCandidates.some((c) => c.slug === 'createWidget'),
    'pass 1 surfaces createWidget as a bridge candidate');
  assert.deepEqual(o1.plan.steps.map((s) => s.slug), ['submitWidget'],
    'pass 1 plan is target-only; the bridge step is not composed until the model picks a producer');

  const p2 = runScenario({ ...base, bridgeProducer: 'createWidget' });
  assert.equal(p2.code, 0, `pass2 exit 0; stderr: ${p2.stderr}`);
  const o2 = JSON.parse(p2.stdout);
  const slugs = o2.plan.steps.map((s) => s.slug);
  assert.ok(slugs.includes('createWidget') && slugs.includes('submitWidget'), 'pass 2 composes both ops');
  assert.equal(o2.plan.steps[o2.plan.steps.length - 1].slug, 'submitWidget', 'target last');
  const createStep = o2.plan.steps.find((s) => s.slug === 'createWidget');
  // bridge-area now carries a versioned producer family (refB + refB-v2; see
  // _landing/bridge-area.json). Prefer-latest must collapse the producer set to
  // the latest version, so the grafted producer step carries refB-v2, not refB.
  assert.equal(createStep.reference, 'refB-v2', 'producer step carries the latest producer version (refB-v2)');
  // The runnable must actually thread the produced id into the consumer: refB-v2
  // has a dominant path id (widgetId), so the producer response is captured and
  // jq-extracted. This locks the end-to-end id-threading the bridge exists to
  // produce -- and is the assertion that would have caught the null-dominant-id
  // crash (a regression there yields no WIDGETID line at all, or a `jq -r .null`).
  assert.match(o2.runnable, /WIDGETID=.*jq -r \.widgetId/,
    'runnable threads the produced widgetId from createWidget into submitWidget');
  // The non-null path threads structurally, so it must NOT gain the
  // missing-id-field degrade note that only fires when no id is derivable.
  assert.doesNotMatch(o2.runnable, /no dominant id field|supply .*id.*manually|no .* id field to thread/i,
    'a structurally-threaded bridge (widgetId) must not emit the missing-id-field note');
  assert.ok(!('bridgeCandidates' in o2),
    'pass 2 (producer chosen) must not re-emit bridgeCandidates');
}

// Cross-reference bridge, MULTI-VERSION producer family. bridge-area carries a
// versioned Widget producer: createWidget exists in BOTH refB (v1) and refB-v2
// (latest; see _landing/bridge-area.json). With no pinVersion, pass-1 bridge
// discovery must apply prefer-latest to the PRODUCER family the same way the
// primary target gets bumped -- so it surfaces createWidget@refB-v2 and drops
// the superseded createWidget@refB. Before the fix, both were surfaced (the v1
// duplicate), which is what this asserts against. The single-version bridge test
// above can't catch this: it asserts only on slug membership and .find() order,
// never on the absence of the superseded version.
{
  const input = {
    target: 'submitWidget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const { code, stdout, stderr } = runScenario(input);
  assert.equal(code, 0, `pass1 exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.ok(Array.isArray(out.bridgeCandidates), 'pass 1 surfaces bridgeCandidates');
  const widgetProducers = out.bridgeCandidates.filter((c) => c.slug === 'createWidget');
  assert.ok(widgetProducers.some((c) => c.reference === 'refB-v2'),
    `pass 1 must surface createWidget@refB-v2 (latest); got ${JSON.stringify(out.bridgeCandidates)}`);
  assert.ok(!widgetProducers.some((c) => c.reference === 'refB'),
    `pass 1 must NOT surface createWidget@refB (v1 superseded by refB-v2); got ${JSON.stringify(out.bridgeCandidates)}`);
}

// pinVersion honored in bridge discovery: when the caller pins, the producer
// family must NOT be collapsed to latest -- the superseded version is kept so a
// caller who deliberately pinned a version can still bridge through it. With
// pinVersion:true, both createWidget@refB and createWidget@refB-v2 are surfaced.
{
  const input = {
    target: 'submitWidget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
    pinVersion: true,
  };
  const { code, stdout, stderr } = runScenario(input);
  assert.equal(code, 0, `pass1 (pinVersion) exit 0; stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  const widgetProducers = out.bridgeCandidates.filter((c) => c.slug === 'createWidget');
  assert.ok(widgetProducers.some((c) => c.reference === 'refB-v2'),
    `pinVersion: createWidget@refB-v2 still surfaced; got ${JSON.stringify(out.bridgeCandidates)}`);
  assert.ok(widgetProducers.some((c) => c.reference === 'refB'),
    `pinVersion must NOT collapse the producer family -- createWidget@refB kept; got ${JSON.stringify(out.bridgeCandidates)}`);
}

// Cross-reference bridge, SINGLE-VERSION producer family (survival path). The
// prefer-latest filter in scenario.js keeps only producer refs equal to their
// version-family's resolveVersions(...).latest. For a producer reference with NO
// versioned sibling, resolveVersions returns a no-op shape where latest === the
// ref itself, so it must survive the filter untouched. bridge-area carries refC,
// a single-version producer of the Gadget type (no refC-v2 in
// _landing/bridge-area.json), consumed by refA's submitGadget op. With no
// pinVersion, pass-1 discovery must surface createGadget@refC -- and pass 2 must
// compose that EXACT ref (not dropped, not version-bumped). This is the
// single-version-survival regression guard the multi-version test above can't
// give: that one asserts the latest of a MULTI-version family wins; this one
// asserts a family of ONE passes the same filter intact.
{
  const base = {
    target: 'submitGadget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  const p1 = runScenario(base);
  assert.equal(p1.code, 0, `pass1 exit 0; stderr: ${p1.stderr}`);
  const o1 = JSON.parse(p1.stdout);
  // A filter that wrongly drops single-version refs leaves siblingRefs empty, so
  // the walk surfaces no candidates and pass 1 omits bridgeCandidates entirely --
  // assert its presence first so that regression reads as a clean failure here.
  assert.ok(Array.isArray(o1.bridgeCandidates) && o1.bridgeCandidates.length > 0,
    `pass 1 must surface bridgeCandidates for a single-version producer; got ${JSON.stringify(o1.bridgeCandidates)}`);
  const gadgetProducers = o1.bridgeCandidates.filter((c) => c.slug === 'createGadget');
  assert.ok(gadgetProducers.some((c) => c.reference === 'refC'),
    `pass 1 must surface createGadget@refC (single-version producer survives the filter); got ${JSON.stringify(o1.bridgeCandidates)}`);
  assert.deepEqual(o1.plan.steps.map((s) => s.slug), ['submitGadget'],
    'pass 1 plan is target-only until the model picks a producer');

  const p2 = runScenario({ ...base, bridgeProducer: 'createGadget' });
  assert.equal(p2.code, 0, `pass2 exit 0; stderr: ${p2.stderr}`);
  const o2 = JSON.parse(p2.stdout);
  const slugs = o2.plan.steps.map((s) => s.slug);
  assert.ok(slugs.includes('createGadget') && slugs.includes('submitGadget'), 'pass 2 composes both ops');
  assert.equal(o2.plan.steps[o2.plan.steps.length - 1].slug, 'submitGadget', 'target last');
  const createStep = o2.plan.steps.find((s) => s.slug === 'createGadget');
  // The single-version producer must compose against its EXACT reference. A
  // regression that dropped single-version refs from the filter would surface no
  // candidate at all (pass 1 assertion fails); one that wrongly bumped it would
  // carry a refC-v2 here. Neither exists, so the ref stays refC.
  assert.equal(createStep.reference, 'refC', 'single-version producer step carries its exact reference (refC), not dropped or version-bumped');
}

// Cross-reference bridge, NO-DOMINANT-PATH-ID producer family (graceful degrade).
// refD produces the Doohickey body type from nothing via createDoohickey, but
// refD has NO operation with a required by-id path param -- so
// dominantPathId('refD') is null. The walker marks the target's from-bridge input
// needsNaming. Before the fix, pass 2 grafted an edge with viaField=null, compose
// built an idPassing input {field:null}, and curl-block did null.toUpperCase() ->
// TypeError -> the whole run exited 1 (the model got NO plan). The fix degrades
// gracefully: the producer step still appears (so the user knows to call it and
// supply the id), but no jq-threading line is emitted for the unnamed field.
{
  const base = {
    target: 'submitDoohickey',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE, scrapeScript: FAKE_SCRAPE,
  };
  // Pass 1: createDoohickey surfaces as a candidate even though its family has no
  // dominant path id (the from-bridge input's needsNaming:true is fine here).
  const p1 = runScenario(base);
  assert.equal(p1.code, 0, `pass1 exit 0; stderr: ${p1.stderr}`);
  const o1 = JSON.parse(p1.stdout);
  assert.ok(Array.isArray(o1.bridgeCandidates) && o1.bridgeCandidates.some((c) => c.slug === 'createDoohickey'),
    `pass 1 surfaces createDoohickey as a bridge candidate; got ${JSON.stringify(o1.bridgeCandidates)}`);
  assert.deepEqual(o1.plan.steps.map((s) => s.slug), ['submitDoohickey'],
    'pass 1 plan is target-only until the model picks a producer');

  // Pass 2: must EXIT 0 (the crash this fix repairs), compose the createDoohickey
  // step, and emit a runnable with no `jq -r .null` / `NULL=` line.
  const p2 = runScenario({ ...base, bridgeProducer: 'createDoohickey' });
  assert.equal(p2.code, 0, `pass2 must exit 0 (null dominant path id degrades, not crashes); stderr: ${p2.stderr}`);
  const o2 = JSON.parse(p2.stdout);
  const slugs = o2.plan.steps.map((s) => s.slug);
  assert.ok(slugs.includes('createDoohickey') && slugs.includes('submitDoohickey'),
    `pass 2 composes both ops (producer step present); got ${slugs.join(',')}`);
  assert.equal(o2.plan.steps[o2.plan.steps.length - 1].slug, 'submitDoohickey', 'target last');
  // The graceful-degrade end state: NO structurally-threaded id line. The model
  // names the id from the producer's response prose instead.
  assert.doesNotMatch(o2.runnable, /jq -r \.null/, 'no bogus `jq -r .null` extraction');
  assert.doesNotMatch(o2.runnable, /^NULL=/m, 'no `NULL=` variable assignment for the unnamed field');
  // ...but the user MUST get a human-readable note explaining why no id threads
  // and that they have to supply it from the producer response manually. On the
  // real degraded flow this fires off the surviving from-bridge needsNaming input
  // on the consumer step (compose strips the null viaField from idPassing before
  // curl-block runs, so an idPassing-keyed note would never reach this path).
  assert.match(o2.runnable, /no dominant id field on createDoohickey.*supply .*createDoohickey response above manually/i,
    'degraded bridge runnable explains the missing id field and to supply it manually from the producer response');
  // No bogus `{"null":...}` body for the unnamed from-bridge field on the consumer.
  assert.doesNotMatch(o2.runnable, /"null"/, 'no bogus null-named body field in the degraded bridge runnable');
}

console.log('ok');
