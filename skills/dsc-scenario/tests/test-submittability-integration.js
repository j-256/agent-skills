'use strict';

// Integration: the curated submittability registry, folded into a real
// scenario.js run at the bridge seam. Uses the bridge-area fixtures, whose
// submitWidget target takes a Widget body produced by createWidget -- the exact
// structural analog of createOrder/Basket/createBasket. A test registry is passed
// on stdin (submittabilityRegistry) so this doesn't depend on the shipped Basket
// data; the shipped data is asserted in test-submittability.js.
//
// What this pins end to end:
//   - the chosen producer step's runnable body is POPULATED from the curated
//     bodyContents (not the empty `{}` / stub the structural walk alone emits);
//   - the output carries a `submittability` advisory with provenance + curated
//     framing, so the model can render it as a business-rule, not as spec;
//   - a target whose body type is NOT in the registry is byte-for-byte unchanged.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCENARIO = path.join(__dirname, '..', 'scripts', 'scenario.js');
const FAKE_SCRAPE = path.join(__dirname, '..', '..', '_shared', 'tests', 'fixtures', 'fake-scrape.js');
const CACHE = path.join(__dirname, 'fixtures');

function runScenario(input) {
  const res = spawnSync('node', [SCENARIO], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: 'ok-fresh' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const TEST_REGISTRY = {
  Widget: {
    note: 'A Widget must be assembled before submitWidget will accept it.',
    submittableVia: 'producer-body',
    needed: [],
    bodyContents: [
      { field: 'parts', why: 'a widget with no parts is rejected at submit (400 No Parts)' },
      { field: 'label', why: 'submitWidget returns 400 Missing Label without a label' },
    ],
    provenance:
      'Empirically verified; spec states no required-set. '
      + 'https://developer.salesforce.com/docs/example/references/widgets?meta=submitWidget',
    confidence: 'curated',
  },
};

// --- registry entry present: producer body populated + advisory surfaced -----
{
  const base = {
    target: 'submitWidget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    submittabilityRegistry: TEST_REGISTRY,
  };
  // Pass 2 (producer chosen) is where the full plan composes.
  const p2 = runScenario({ ...base, bridgeProducer: 'createWidget' });
  assert.equal(p2.code, 0, `pass2 exit 0; stderr: ${p2.stderr}`);
  const out = JSON.parse(p2.stdout);

  // The advisory must be present, name the producer, and carry curated provenance.
  assert.ok(out.submittability, 'output carries a submittability advisory');
  assert.equal(out.submittability.typeName, 'Widget');
  assert.equal(out.submittability.producerSlug, 'createWidget',
    'advisory names the producer step whose body must be populated');
  assert.equal(out.submittability.confidence, 'curated', 'advisory is framed as curated, not spec');
  assert.ok(/developer\.salesforce\.com/.test(out.submittability.provenance),
    'advisory provenance cites a public DSC URL');
  assert.ok(!/~\/\.cache/.test(JSON.stringify(out.submittability)),
    'no local cache path leaks into the advisory');

  // The runnable must populate the producer's body with the curated fields, and
  // it must be visibly framed as a curated business-rule (not spec). The empty
  // `{}` / structural stub is no longer acceptable for a registry-backed producer.
  assert.match(out.runnable, /parts/, 'runnable populates the curated `parts` field on the producer body');
  assert.match(out.runnable, /label/, 'runnable populates the curated `label` field on the producer body');
  assert.match(out.runnable, /curated|business rule|business-rule/i,
    'the curated framing is present in the runnable so the necessity is not passed off as spec');
}

// --- registry entry absent: plan unchanged (no advisory, no annotation) ------
// submitGadget's body type is Gadget; the test registry has only Widget. The
// run must be a pure structural plan with no submittability advisory.
{
  const base = {
    target: 'submitGadget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    submittabilityRegistry: TEST_REGISTRY,
  };
  const p2 = runScenario({ ...base, bridgeProducer: 'createGadget' });
  assert.equal(p2.code, 0, `pass2 exit 0; stderr: ${p2.stderr}`);
  const out = JSON.parse(p2.stdout);
  assert.ok(!out.submittability, 'no advisory when the body type is absent from the registry');
  assert.ok(!/curated|business-rule/i.test(out.runnable),
    'no curated framing leaks into a structural-only plan');

  // Byte-for-byte regression guard for the emitPlan() refactor: the same target,
  // run with NO registry at all (empty {}), must produce an identical plan +
  // runnable. This is the assertion that proves the registry is a pure no-op for
  // a body type it doesn't cover -- the common case the refactor must not perturb.
  const pNoReg = runScenario({ ...base, bridgeProducer: 'createGadget', submittabilityRegistry: {} });
  assert.equal(pNoReg.code, 0, `no-registry pass2 exit 0; stderr: ${pNoReg.stderr}`);
  const outNoReg = JSON.parse(pNoReg.stdout);
  assert.equal(outNoReg.runnable, out.runnable,
    'absent-entry runnable is byte-for-byte identical with vs without a registry');
  assert.deepEqual(outNoReg.plan, out.plan,
    'absent-entry plan is structurally identical with vs without a registry');
  assert.ok(!('submittability' in outNoReg), 'empty registry surfaces no advisory key');
}

console.log('ok');
