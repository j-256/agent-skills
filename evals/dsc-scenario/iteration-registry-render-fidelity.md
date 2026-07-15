# iteration-registry-render-fidelity

Non-eval note (no eval was run -- this is a pure offline unit test). Records the
knowledge the diff cannot carry.

## The reframe: no trophy guard

This work began as "build a trophy knowledge-fidelity guard." That premise was
wrong and was killed. A trophy (`docs/examples/scenario-*.md`) is a FROZEN CAPTURE
of the skill's output -- its accuracy is INHERITED from the generic layers that make
all output accurate, not a property it defends on its own. Guarding a trophy's
content verifies the sample instead of the pipeline (smoke-and-mirrors). A stale
trophy cannot hide a skill defect, because the pipeline is verified independently.
Trophies keep only their two honest artifact checks (already shipped in
`test-examples-runnable.js`): they parse (`bash -n`) and they still run to a real
order (opt-in live gate).

## The real gap this closes

The curated knowledge has one source of record: `B2C_CURATED_FACTS`. Every render
test (`test-curl-block.js`, `test-curated-body-integration.js`) uses SYNTHETIC facts
(`why:'z'`) by design, to stay decoupled from shipped data; the shipped data is
checked only for well-formedness (`test-curated-facts.js`) and spec-existence
(`test-curated-facts-schema.js` + `-live.js`). So NO test rendered the SHIPPED
registry through the real pipeline and asserted its content reaches the output.
`test-registry-render-fidelity.js` is `test-curl-block.js` fed the shipped registry
instead of synthetic facts -- same tool (hand-built plan -> renderer), same subject
(the render seam), new file to preserve test-curl-block's synthetic-decoupling
principle. Value is FORWARD drift protection (a banner reformat that drops the
provenance line, a fact edited into a shape the renderer mishandles, a fabrication
reintroduced), not a present-bug catch: the registry renders clean today.

## Load-bearing findings

- Token source is `bodyContents[].why` ONLY, never `claim`/`provenance`. Those are
  paraphrased prose (an inreference trophy paraphrases the `claim` sentence; no
  trophy carries `provenance` verbatim), so asserting them verbatim would falsely RED.
- The cite assertion needed a seam fix. The renderer prints an unconditional
  `# Spec: ${step.specUrl}` line, so if the test's plan seed feeds `fact.cite` into
  `specUrl` (the first cut did), then `runnable.includes(fact.cite)` is VACUOUS -- it
  passes via the Spec line regardless of whether the curated banner rendered the
  citation. Fix: the seed uses a sentinel `specUrl` (SEED_SPEC_URL, on-domain so it
  does not trip the domain check), and the cite assertion checks (a) the registry
  integrity `fact.provenance.includes(fact.cite)` and (b) the cite renders on a line
  that is NOT the `# Spec:` line -- i.e. in the provenance banner. This bites a fact
  whose provenance loses its citation; the vacuous version could not.
- The field-name assertion is PARTIALLY REDUNDANT for a field that is also a `leaves`
  entry (e.g. `productItems` -> `productItems[].productId`): such a field renders as a
  JSON body key independent of the banner, so dropping only its banner line does not
  make the field-name vanish. The field-name check still bites a banner-only field
  (`shipments[].shippingMethod`) and a field vanishing from BOTH surfaces; the
  why-token, framing, and cite checks are the load-bearing, banner-exclusive signals.
- The domain check is scoped to `/docs/` URLs, so it tolerates the legitimate
  non-docs hosts (`commercecloud.salesforce.com` runtime host, `account.demandware.com`
  AM auth host) while still biting an off-domain docs citation.
- `merchant-configurable` is a known-regression backstop (denylist of one), not a
  complete fabrication check.

## Rejected alternatives

- Trophy banner-substring regenerate guard (the PAUSED approach): byte-coupled to one
  render, cold-cache-skip hole, could not handle the knowledge relocating from banner
  to prose across trophies.
- Reshoot trophies to a verbatim-relaying run: the add-coupon runnable banner strip is
  a systematic long-output model behavior with no reliable convergence -- an unbounded
  sub-problem, and (per the reframe) unnecessary.

## Deferred fast-follow (B)

Harden the synthesis-eval relay contract (customer-outcome/final-text assertions):
add the `merchant-configurable` exclude, field-completeness, and uniform on-domain-cite
checks across the scenario fixtures -- the property only the model can violate
(relay-without-stripping, including the add-coupon banner-strip case). Diagnosing WHY
Sonnet strips that banner on long output is its own sub-project.
