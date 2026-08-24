'use strict';

// Render-fidelity guard: every SHIPPED curated fact that carries a request body
// must have its content -- each body field, each quoted failure token from `why`,
// its citation, and the "curated, not spec" framing -- actually RENDER into the
// runnable the skill emits. This is test-curl-block.js's subject (does renderCurlBlock
// relay a curatedBody?) fed the REAL registry instead of synthetic `why:'z'` facts,
// closing the one seam the synthetic render tests cannot: shipped content -> render.
//
// Scope boundary (what this does NOT own -- covered elsewhere, do not duplicate):
//   - fact attaches to the right plan step .. test-curated-body-integration.js (real bridge seam)
//   - fact's fields still exist in the live spec .. test-curated-facts-schema.js + -live.js
//   - walk/compose produce the plan shape ......... test-compose.js, test-scenario-integration.js
// The hand-built plan here ASSUMES attach works by constructing the step to match;
// that is legitimate precisely because attach is covered above.
//
// Pure offline: no cache, network, creds, scenario.js, or eval.

const assert = require('node:assert/strict');
const { attachCuratedBodies } = require('../scripts/curated-body.js');
const { renderCurlBlock } = require('../scripts/curl-block.js');
const { CURATED_FACTS } = require('../../../shared/products/commerce-b2c/curated-facts.js');

// The facts under test: every shipped entry carrying a non-empty bodyContents.
// (attach:'note' facts have no body and are out of scope -- owned by the note-channel
// tests.) Derived, never hand-listed, so a new body fact is picked up automatically.
const BODY_FACTS = CURATED_FACTS.filter(
  (f) => Array.isArray(f.bodyContents) && f.bodyContents.length > 0,
);

// A sentinel spec URL for the seed's step.specUrl. Deliberately NOT fact.cite: the
// renderer emits an unconditional `# Spec: ${step.specUrl}` line, so feeding fact.cite
// here would make the cite appear in the runnable regardless of the banner -- rendering
// the cite assertion vacuous. On-domain so it never trips the Task 2 domain check.
const SEED_SPEC_URL = 'https://developer.salesforce.com/docs/__seed_spec_not_a_cite__';

// A minimal plan seed per attach mode -- just enough identity for the fact to attach
// and the renderer to emit its banner. Mirrors how test-curl-block.js hand-builds plans.
function seedFor(fact) {
  const common = { specUrl: SEED_SPEC_URL, basePath: '/x', requiredInputs: [], requestAuth: { bearer: true, query: {} } };
  if (fact.attach === 'producer-body') {
    return {
      targetBodyType: fact.producesType,
      step: { ...common, slug: 'producer', method: 'POST', path: '/p', produces: [{ name: fact.producesType }] },
    };
  }
  if (fact.attach === 'op-body') {
    // Identity the fact's match(ctx) checks. The shipped op-body fact
    // (scapi-add-payment-instrument-body) matches area commerce_commerce-api,
    // reference shopper-baskets(-vN)?, POST, path .../payment-instruments.
    return {
      targetBodyType: null,
      step: {
        ...common, slug: 'op', method: 'POST',
        path: '/baskets/{basketId}/payment-instruments',
        reference: 'shopper-baskets-v2', area: 'commerce_commerce-api', produces: [],
      },
    };
  }
  throw new Error(`seedFor: unhandled attach mode '${fact.attach}' for fact '${fact.id}'`);
}

// Attach the fact to a fresh single-step plan and render. Returns { runnable, advisories }.
function renderFact(fact) {
  const seed = seedFor(fact);
  const plan = {
    targetSlug: 't', reference: 'r', area: seed.step.area || 'commerce_commerce-api',
    combinedScopes: ['x'], authBranch: 'unknown', idPassing: [], steps: [seed.step],
  };
  const advisories = attachCuratedBodies({ plan, targetBodyType: seed.targetBodyType });
  return { runnable: renderCurlBlock({ plan }), advisories };
}

// Double-quoted spans inside a `why` string. Mostly the exact 400 messages
// ("Product Items Required"), occasionally an incidental literal ("me", the default
// shipment id). No length/content filter: a present token is never a false RED, and
// filtering invites a "representative subset" (the rejected fallacy). NB: not all are
// 400 messages -- do not call them that in failure text.
function quotedTokens(str) {
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(str || '')) !== null) out.push(m[1]);
  return out;
}

// Coverage gate: every body-bearing fact must be seedable (known attach mode) so
// none is silently unexercised. seedFor throws on an unknown mode; this turns that
// into an explicit, named failure the moment a new body fact lands without a seed.
for (const fact of BODY_FACTS) {
  assert.doesNotThrow(() => seedFor(fact),
    `${fact.id}: has bodyContents but seedFor has no plan seed for attach mode '${fact.attach}' -- add one so its render is covered`);
}

// --- presence: each fact's content renders into the runnable ------------------
assert.ok(BODY_FACTS.length > 0, 'expected at least one body-bearing curated fact to test');
for (const fact of BODY_FACTS) {
  const { runnable, advisories } = renderFact(fact);
  assert.equal(advisories.length, 1,
    `${fact.id}: expected exactly one advisory from attach, got ${advisories.length} -- the seed did not attach the fact`);

  for (const c of fact.bodyContents) {
    assert.ok(runnable.includes(c.field),
      `${fact.id}: body field ${JSON.stringify(c.field)} is missing from the rendered runnable -- the renderer dropped a curated field, or the registry named a field the renderer cannot emit`);
    for (const tok of quotedTokens(c.why)) {
      assert.ok(runnable.includes(tok),
        `${fact.id}: quoted token ${JSON.stringify(tok)} from a bodyContents.why is missing from the rendered runnable`);
    }
  }

  // Citation. Guard the type FIRST: a fact with cite:null (the schema permits it) would
  // make the includes() checks below coerce to includes("null") -- and some provenance
  // prose literally contains "null" (e.g. "Basket.required is null"), so a null cite
  // would pass VACUOUSLY. Require a non-empty string cite before the substring checks.
  assert.ok(typeof fact.cite === 'string' && fact.cite,
    `${fact.id}: body fact has no string cite to render (cite is ${JSON.stringify(fact.cite)})`);
  // Registry integrity: each fact's provenance MUST embed its cite (that is how the cite
  // reaches the banner -- the renderer prints the provenance line verbatim; there is no
  // separate cite line in the banner).
  assert.ok(fact.provenance.includes(fact.cite),
    `${fact.id}: fact.provenance does not embed fact.cite -- the citation cannot render in the banner`);
  // Then the RENDER check: the cite must appear on a line that is NOT the seed-fed
  // `# Spec:` line -- i.e. in the provenance banner the renderer emits. A plain
  // runnable.includes(cite) is vacuous because the seed controls the `# Spec:` line;
  // scoping to non-Spec lines makes the check test the BANNER, not the seed.
  const citeOnBannerLine = runnable
    .split('\n')
    .some((l) => l.includes(fact.cite) && !/^#\s*Spec:/.test(l.trim()));
  assert.ok(citeOnBannerLine,
    `${fact.id}: cite ${JSON.stringify(fact.cite)} does not render in the provenance banner (only the seed's # Spec: line, or nowhere) -- the provenance line did not carry it`);

  // Framing: the honesty marker that this is curated runtime knowledge, not spec.
  assert.ok(/curated|NOT stated in the spec/.test(runnable),
    `${fact.id}: the curated / "NOT stated in the spec" framing is missing from the rendered banner`);
}

// --- exclude: fabrication token + off-domain docs citations -------------------
// Every /docs/ citation URL in a rendered banner must be on developer.salesforce.com.
// Scoped to /docs/ so it never flags the commercecloud.salesforce.com BASE_URL example
// host or an AM account.demandware.com auth host (both legitimate non-docs hosts).
function docsCitationHosts(str) {
  const hosts = new Set();
  const re = /https?:\/\/([^/\s")]+)(\/[^\s")]*)?/g;
  let m;
  while ((m = re.exec(str || '')) !== null) {
    if ((m[2] || '').includes('/docs/')) hosts.add(m[1]);
  }
  return [...hosts];
}

for (const fact of BODY_FACTS) {
  const { runnable } = renderFact(fact);

  // Known-regression backstop (a denylist of one, NOT a complete fabrication check):
  // re-catches the specific OCAPI "merchant-configurable" invention this arc removed.
  // It cannot catch an unknown invented claim.
  assert.ok(!runnable.includes('merchant-configurable'),
    `${fact.id}: forbidden fabrication token "merchant-configurable" appears in the rendered banner`);

  for (const host of docsCitationHosts(runnable)) {
    assert.equal(host, 'developer.salesforce.com',
      `${fact.id}: a /docs/ citation points at ${JSON.stringify(host)} -- every documentation citation must be on developer.salesforce.com`);
  }
}

console.log(`ok (render-fidelity: ${BODY_FACTS.length} body-bearing facts render their content)`);
