# iteration-inreference-producer-pick

## Hypothesis

The cross-reference type bridge (`iteration-cross-reference-type-bridge`) taught the walk to treat multiple from-nothing producers of a needed resource as *alternatives the model picks among* (`bridgeCandidates`) – but only on the cross-reference path. The in-reference path (`walkTypes`'s `visit()`) was never reconciled: when a target needs a field (e.g. `basketId`) that several ops in its *own* reference produce from nothing (`createBasket`, `transferBasket`, `mergeBasket`), `visit()` added an edge for *each* and chained all of them as mandatory prerequisite steps. The hypothesis: the same producer-choice-point mechanism the cross-reference bridge already uses should fire on the in-reference path too, so a narrow single-op prerequisite query yields `createBasket -> <target>` rather than `createBasket -> transferBasket -> mergeBasket -> <target>`.

## The verified problem

Surfaced from a real demo dry-run (the prompt set in `dsc-scenario-demo-prompts`, prompt #2): `logged-in shopper -- what has to be done before addPaymentInstrumentToBasket will succeed?`. Two failures stacked:

1. `scenario.js` **crashed** before producing any plan – `ReferenceNotCachedError` on `about-commerce-api` during the bridge's widen-prefetch (a markdown concept page the family landing lists but the scraper writes no dir for). Fixed separately in the `fix(_shared,dsc-scenario): tolerate dir-less family siblings in cache scans` commit (no iteration note – mechanical crash fix, covered by `_shared/test/test-cache-access.js` + the `producersOfType` case in `test-walk-types.js`).
2. Once the crash was cleared, the plan that composed was `createBasket -> transferBasket -> mergeBasket -> addPaymentInstrumentToBasket` – three Basket producers chained as mandatory prerequisites. `transferBasket` and `mergeBasket` both presuppose an *existing* basket; instructing a customer to call them to obtain a *fresh* basket is wrong, and they carry real side effects (basket ownership reassignment). This is the plausible-but-wrong output the family exists to prevent: it would ship to a customer and mislead them.

## Root cause

`createBasket`, `transferBasket`, and `mergeBasket` are structurally indistinguishable to the walk: all three POST, all produce a `Basket`, none requires `basketId` as a formal parameter (so the from-nothing filter keeps all three). The reason `createBasket` is the right pick is *semantic* (the others presuppose an existing basket – stated only in prose), so a purely structural planner cannot deterministically choose it without either a heuristic or deferring to the model. The cross-reference bridge already chose "defer to the model" (`bridgeCandidates`, design comment in `producersOfType`: *"selecting the canonical create among them is the model's judgment"*). The in-reference `visit()` predated that concept and treated the producer set as an AND-chain. This was the anomaly.

## What changed

- **`walkTypes` `visit()` surfaces in-reference multi-producers as candidates.** When `findProducers` returns more than one from-nothing producer (deduped by slug) for a single field, `visit()` no longer adds an edge per producer. It pushes them into the same `bridgeCandidates` array the cross-reference bridge uses and skips chaining. A new `chosenProducer` param collapses the set to the one chosen edge on pass 2. `bridgeCandidates` was hoisted to the top of `walkTypes` so both the in-reference choice point and the post-walk cross-reference bridge populate one array (a target hits at most one source in practice).
- **`scenario.js` pass-2 in-reference branch.** When the chosen producer's reference equals the target's, no graft is needed: re-walk with `chosenProducer`, which collapses the alternatives to the single chosen edge and recurses its prerequisites normally. The in-reference twin of the existing cross-reference graft; the two are distinguished by whether the chosen producer's reference matches the target's.
- **SKILL.md contract.** The line-46 "Cross-reference bridge (two-pass)" prose became "Producer choice point (two-pass)" and now documents both structurally-identical situations (cross-reference body type; in-reference id field), handled the same way: pick the canonical create, re-invoke with `bridgeProducer`.
- **`walk-via-agent.md` step 7.** The sub-agent walk contract now specifies the same alternative-handling (list multi-producers in `bridgeCandidates`, emit no producer edge), so a sub-agent-produced graph follows the same rule the local walk does.

## Blast-radius proof (before/after, deterministic)

Ran `scenario.js` directly (no model) for the explicit-target fixtures, fix stashed vs applied:

| target | pre-fix | with fix |
|---|---|---|
| `createOrder` (cross-ref) | `[createOrder]` cands={createBasket,transferBasket,mergeBasket} | identical |
| `getOrder` (am-admin) | `[getOrder]` cands={-} | identical |
| `addPaymentInstrumentToBasket` | CRASH (`about-commerce-api`) | `[addPaymentInstrumentToBasket]` cands={3}, pass 2 -> `createBasket -> addPaymentInstrumentToBasket` |
| `addCouponToBasket` | CRASH | same shape |

The fix's blast radius is exactly "narrow single-op targets needing an in-reference multi-producer field." Cross-reference (`createOrder`) and no-producer (`getOrder`) targets are byte-identical pre/post – their last green eval runs remain valid, so a full suite rerun was not warranted.

## Fixture audit

Audited all 8 synthesis fixtures while scoping the rerun:

- `synthesis-scenario-registered-silent` and `synthesis-scenario-registered-b2c-primed` carry **14/14 identical assertion sets**; the only difference is prompt priming. This is the *intentional* routing-invariance pair the fixtures' own hypotheses document (consistent registered-b2c routing whether or not the prompt says "no SSO"). Kept both.
- `synthesis-scenario-add-coupon-checkout` shares 12 assertions with the auth triangle (auth/runnable-hygiene). Its unique coverage is the multi-reference coupon flow; the shared assertions are cheap to keep. Left as-is (a fixture-dedup refactor, if ever wanted, is its own task – not folded into a fix).
- The real gap was the narrow single-op prerequisite shape (no fixture covered it). `synthesis-scenario-inreference-producer-pick` fills it; its transfer/merge step-exclusion regex is reused verbatim from `synthesis-scenario-createorder-basketid-threading`, where it was tuned across the cross-reference-bridge iterations.

## Eval result

`stream-eval synthesis`, Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`), `--runs 5` strict, the new fixture + `add-coupon-checkout` as a regression spot-check (the one multi-step basket-flow fixture most likely to move under a walk change):

- **10/10 runs pass, 2/2 fixtures, exit 0.** Zero failed assertions, zero contamination, every run fired `dsc-scenario` first.
- New fixture (`synthesis-scenario-inreference-producer-pick`): 5/5 strict. Plan is `authenticateCustomer -> getAccessToken -> createBasket -> addPaymentInstrumentToBasket` – single Basket producer, transfer/merge absent, registered-b2c auth, DSC-only citations.
- `add-coupon-checkout`: 5/5 strict – no regression under the `walk-types.js` change.

Run 1 of the new fixture is captured verbatim as the worked example `docs/examples/scenario-inreference-prereq.md`. The payment-instrument body the model emitted (`{"amount": 0, "paymentMethodId": "CREDIT_CARD"}`) was verified against the `BasketPaymentInstrumentRequest` spec before capture: both fields are real properties, `CREDIT_CARD` is the spec's own example value, and the type has no required fields, so a minimal body is spec-valid (not a fabrication).

## Follow-ups surfaced

- **Provided-graph hardening.** `walkTypes` no longer emits the same-field multi-producer shape, but a *provided* graph (sub-agent path / hand-authored) could still carry it and bypass the local walk's choice point. Closed in the `fix(dsc-scenario): collapse duplicate producer edges in provided graphs` commit (no iteration note – defense-in-depth guard + a drifted-integration-test correction, both carried by the commit body and `test-walk-types.js` / `test-scenario-integration.js`).
- **Fixture dedup (deferred).** `add-coupon-checkout`'s 12 auth/hygiene assertions overlap the auth triangle. Not acted on – a deliberate-redundancy-vs-trim decision worth its own task, not folded into a fix.
