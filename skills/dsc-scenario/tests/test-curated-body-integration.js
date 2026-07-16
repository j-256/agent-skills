'use strict';

// Integration: the unified curated-body registry, folded into a real scenario.js
// run at the bridge seam. Uses the bridge-area fixtures, whose submitWidget target
// takes a Widget body produced by createWidget -- the exact structural analog of
// createOrder/Basket/createBasket. A test facts array is passed on stdin
// (curatedFacts) so this doesn't depend on the shipped Basket data; the shipped
// data is asserted in test-curated-facts-schema.js.
//
// What this pins end to end:
//   - the chosen producer step's runnable body is POPULATED from the curated
//     leaves (not the empty `{}` / stub the structural walk alone emits);
//   - the output carries a `curatedBody` advisory array with provenance + curated
//     framing, so the model can render it as a business-rule, not as spec;
//   - a target whose body type is NOT covered is byte-for-byte unchanged.

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

// One producer-body fact for Widget, mirroring the FAKE producer-body entry in
// test-curated-body.js but with a bridge-area DSC url. NB: this entry carries
// bodyContents (parts + label) and NO leaves -- deliberately. The shared
// leaf-VALUE table (_shared/products/commerce-b2c/persona.js) is scoped to exactly the shipped
// Basket/basket fields (widening it would mask a missing-value bug, per its own
// comment), so a Widget fact can't render arbitrary leaves through the real
// pipeline. The leaf-less shape exercises curl-block's flat bodyContents fallback
// -- the same path the retired Task-3 shim fed the renderer -- so `parts`/`label`
// still populate the producer body end to end. Leaf-based (buildSkeleton) body
// rendering is covered against the real persona table in test-body-render-*.
const CURATED_FACTS = [{
  id: 'widget-body', attach: 'producer-body', producesType: 'Widget', family: 'SCAPI',
  bodyContents: [
    { field: 'parts', why: 'a widget with no parts is rejected at submit (400 No Parts)' },
    { field: 'label', why: 'submitWidget returns 400 Missing Label without a label' },
  ],
  provenance: `Empirically verified; spec states no required-set. https://developer.salesforce.com/docs/bridge-area/references/refA?meta=submitWidget`,
  confidence: 'curated', basis: 'runtime-verified', verifiedOn: [{ date: '2026-07-12', coords: {} }],
  scope: 's', cite: 'https://developer.salesforce.com/docs/bridge-area/references/refA?meta=submitWidget',
}];

// --- fact present: producer body populated + advisory surfaced ----------------
{
  const base = {
    target: 'submitWidget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    curatedFacts: CURATED_FACTS,
  };
  // Pass 2 (producer chosen) is where the full plan composes.
  const p2 = runScenario({ ...base, bridgeProducer: 'createWidget' });
  assert.equal(p2.code, 0, `pass2 exit 0; stderr: ${p2.stderr}`);
  const out = JSON.parse(p2.stdout);

  // The advisory must be present as an array, name the producer, and carry curated
  // provenance.
  assert.ok(Array.isArray(out.curatedBody) && out.curatedBody.length === 1, 'one curatedBody advisory');
  assert.equal(out.curatedBody[0].typeName, 'Widget');
  assert.equal(out.curatedBody[0].stepSlug, 'createWidget',
    'advisory names the producer step whose body must be populated');
  assert.equal(out.curatedBody[0].confidence, 'curated', 'advisory is framed as curated, not spec');
  assert.ok(/developer\.salesforce\.com/.test(out.curatedBody[0].provenance),
    'advisory provenance cites a public DSC URL');
  assert.ok(!/~\/\.cache/.test(JSON.stringify(out.curatedBody)),
    'no local cache path leaks into the advisory');

  // The runnable must populate the producer's body with the curated fields, and
  // it must be visibly framed as a curated business-rule (not spec). The empty
  // `{}` / structural stub is no longer acceptable for a covered producer.
  assert.match(out.runnable, /parts/, 'runnable populates the curated `parts` field on the producer body');
  assert.match(out.runnable, /label/, 'runnable populates the curated `label` field on the producer body');
  assert.match(out.runnable, /curated|business rule|business-rule/i,
    'the curated framing is present in the runnable so the necessity is not passed off as spec');
}

// --- fact absent for the body type: plan unchanged (no advisory) --------------
// submitGadget's body type is Gadget; the test facts cover only Widget. The
// run must be a pure structural plan with no curatedBody advisory.
{
  const base = {
    target: 'submitGadget',
    referenceUrl: 'https://developer.salesforce.com/docs/bridge-area/references/refA',
    cacheRoot: CACHE,
    scrapeScript: FAKE_SCRAPE,
    curatedFacts: CURATED_FACTS,
  };
  const p2 = runScenario({ ...base, bridgeProducer: 'createGadget' });
  assert.equal(p2.code, 0, `pass2 exit 0; stderr: ${p2.stderr}`);
  const out = JSON.parse(p2.stdout);
  assert.ok(!('curatedBody' in out), 'no advisory when the body type is absent from the facts');
  assert.ok(!/curated|business-rule/i.test(out.runnable),
    'no curated framing leaks into a structural-only plan');

  // Byte-for-byte regression guard for the emitPlan() refactor: the same target,
  // run with NO facts at all (empty []), must produce an identical plan +
  // runnable. This is the assertion that proves the facts are a pure no-op for
  // a body type they don't cover -- the common case the refactor must not perturb.
  const pNoReg = runScenario({ ...base, bridgeProducer: 'createGadget', curatedFacts: [] });
  assert.equal(pNoReg.code, 0, `no-facts pass2 exit 0; stderr: ${pNoReg.stderr}`);
  const outNoReg = JSON.parse(pNoReg.stdout);
  assert.equal(outNoReg.runnable, out.runnable,
    'absent-entry runnable is byte-for-byte identical with vs without facts');
  assert.deepEqual(outNoReg.plan, out.plan,
    'absent-entry plan is structurally identical with vs without facts');
  assert.ok(!('curatedBody' in outNoReg), 'empty facts surfaces no curatedBody key');
}

console.log('ok');
