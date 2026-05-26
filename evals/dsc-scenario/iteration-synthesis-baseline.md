# iteration-synthesis-baseline

Status: SHIPPED WITH FINDINGS. 13/15 runs strict (2 of 3 fixtures pass 5/5; OCAPI fixture passes 3/5 with a real output-discipline regression on path-prefix completeness, documented below). First synthesis-eval run captured for dsc-scenario; pairs with the existing trigger-eval iterations and the worked example at `docs/examples/scenario-createorder-prereqs/`.

## Hypothesis tested

The dsc-scenario skill should pass synthesis-eval baselines on three fixture shapes seeded from `trigger-eval.json`:

1. **SCAPI multi-call plan** with a named, real coupon op (verified `addCouponToBasket` in spec at `~/.cache/dsc-scrape/commerce_commerce-api/shopper-baskets/addCouponToBasket.json`).
2. **OCAPI direction guard** -- when the user explicitly asks about an OCAPI target, the skill must answer in OCAPI terms (path notation, reference URL anchored on `ocapi`), not silently translate to SCAPI. Operator memory documents that customers migrate OFF OCAPI to SCAPI, never the reverse.
3. **Cascade-order regression guard** for the existing worked example at `docs/examples/scenario-createorder-prereqs/`. Plan must explicitly link `basketId` to its producer (`createBasket`) and consumer (`createOrder`).

Per `iteration-synthesis-assertion-relaxation` in dsc-endpoint-help: synthesis-eval owns composition-layer outcome correctness only; tool-path assertions (`tool_input_matches`, `tool_sequence_includes`) deliberately omitted -- those belong in unit tests, not the gateway-gated synthesis layer.

## What changed

New file `evals/dsc-scenario/synthesis-eval.json` with 3 fixtures, 13 assertions total. All assertions are `final_text_matches` / `final_text_excludes` only.

No SKILL.md edits, no script edits.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/dsc-scenario/synthesis-eval.json --runs 5 --workers 4 --timeout 360 --out evals/dsc-scenario/runs/iteration-synthesis-baseline/results.json`

Wall-clock 749.9s. Exit code 1 (one fixture under-passes; the harness correctly surfaces this). 0 abort, 1 retry across 15 runs.

| Fixture | Pass count | Mean elapsed | Failure mode |
|---|---|---|---|
| `synthesis-scenario-add-coupon-checkout` | 5/5 | 205.6s | -- |
| `synthesis-scenario-createorder-basketid-threading` | 5/5 | 199.9s | -- |
| `synthesis-scenario-ocapi-submit-basket` | 3/5 | 141.3s | runs 3 + 5 missing `/dw/shop/v\d+` path prefix; see "OCAPI path-prefix regression" below |

13/15 runs strict pass (86.7%). Citation-leak guard (`~/\.cache/`): 0 leaks across 15 runs. Routing correctness (`expected_skill: dsc-scenario` matched): 15/15.

The single retry on `synthesis-scenario-add-coupon-checkout` run 5 was a transient gateway hiccup (run completed and passed; one api_retry event mid-stream).

## OCAPI path-prefix regression (real finding, not fixture noise)

`synthesis-scenario-ocapi-submit-basket` runs 3 and 5 produced answers that:

- **Cite the correct OCAPI reference URLs** (`developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders` etc) -- so URL anchoring passed.
- **Use OCAPI path notation in method+path lines** (`POST /baskets`, `POST /orders`) -- but as the spec lists them, relative to the API base.
- **Do NOT include the canonical full path prefix** (`/s/{siteId}/dw/shop/v\d+/...`) that would let a teammate paste-and-run.

Specifically, run 3 (8.6KB answer) has a fenced bash block with `curl` invocations, but the URLs in the bash block use `/baskets` and `/orders` directly -- skipping the `/s/{siteId}/dw/shop/v25_6/` prefix. Run 5 (4.5KB) is prose-only with no fenced bash block at all -- structured tables describe the call chain but the user is left to construct the runnable cURL themselves.

Comparison: passing run 1 (the 5/5 cohort) emits `POST /s/{siteId}/dw/shop/v25_6/orders` as the target, and the runnable cURL block uses `https://$HOST/s/$SITE/dw/shop/v25_6/baskets` consistently. The `/dw/shop/v` substring appears 15 times in that answer. The shape difference is real and consequential: a paste-and-run answer requires the full path prefix.

This is a genuine output-discipline regression on the skill's "Output composition" section in `SKILL.md`, which prescribes a `## Run it` fenced bash block with `plan.runnable` verbatim. The two failing runs either omit that section (run 5) or elide the canonical path prefix from inside it (run 3).

**Why this fixture isn't relaxed:** The assertion's `because` says "OCAPI path notation -- proves the answer is an OCAPI plan and not silently translated into SCAPI's `/checkout/...` paths." That intent is partially met by the failing runs (they cite OCAPI URLs and don't translate to SCAPI paths). But the load-bearing customer-outcome property -- a teammate can paste the runnable into their terminal -- *is* violated. The right fix is in the skill, not the fixture: tighten SKILL.md "Output composition" to make `## Run it` mandatory (the current SKILL.md says "Run it" should appear but doesn't anchor on the canonical prefix), and verify the path-prefix discipline through a follow-up iteration. Filing this as a finding here, not addressing it in the same iteration that establishes the baseline.

If a future iteration tightens the skill on this point, re-run synthesis-eval to verify the OCAPI fixture moves to 5/5; the assertion is correctly authored against the customer-outcome intent.

## Coupling with the SLAS cross-reference TODO

The companion TODO at `evals/dsc-scenario/iteration-todo-slas-cross-reference-prose.md` flags a separate skill-prose miss: the worked example at `docs/examples/scenario-createorder-prereqs/` says SLAS is "not part of either reference" when SLAS *is* a DSC reference (`shopper-login`). That's a different layer of regression than the OCAPI path-prefix issue, but they share an underlying cause: the skill's "Output composition" prose is under-specified on cross-reference acknowledgment and on path-prefix completeness. A follow-up iteration could address both in one tightening of SKILL.md (one section: "what your final answer must cite for cross-reference deps" + "your runnable block must use canonical full paths").

## Surprises

- **The OCAPI fixture's failing assertion was the path-prefix regex, not the direction-migration regex.** I expected the most likely failure mode to be the model treating OCAPI as legacy and proposing migration to SCAPI. That assertion (`(?i)(migrate|migration).{0,40}(off |from )?ocapi.{0,40}(to |toward |over to )?scapi`) passed on all 5 runs -- the OCAPI direction guard is solid. The actual regression was a different shape gap.
- **`addCouponToBasket` regex passed 5/5 strict.** I'd considered checking the cache before committing the regex; verifying upfront paid off (one cache-grep saved one fixture iteration).
- **Path-prefix discipline is bimodal.** Three of five OCAPI runs included the full `/s/{siteId}/dw/shop/v25_6/` prefix consistently. Two runs omitted it consistently. There's no partial-coverage state -- a run either has the prefix discipline or it doesn't, suggesting this is a planning-time decision in the skill's composition flow, not a per-step variation.

## Worked example committed

`docs/examples/scenario-add-coupon-checkout.md` -- verbatim final-answer text from the `synthesis-scenario-add-coupon-checkout-3.jsonl` transcript (run 3, the cleanest of the 5/5 cohort: SCAPI paths consistent throughout, no OCAPI/SCAPI mix-up, includes a complete `## Run it` bash block with canonical full paths, names SLAS as the `auth` reference). 12.7KB committed, slightly above the target 1-10KB range but the answer is a complete 10-step plan + runnable cURL + sources -- trimming would defeat the "verbatim final text" provenance the README requires for examples.

This worked example also incidentally addresses the SLAS-shrug regression filed at `evals/dsc-scenario/iteration-todo-slas-cross-reference-prose.md`: this run names `auth` (SLAS) explicitly as one of the references involved, with two named SLAS operations (`authorizeCustomer`, `getAccessToken`) wired into the plan's first two steps. That's a counter-example to the existing `scenario-createorder-prereqs` worked example's "not part of either reference" miss -- demonstrates the skill *can* produce the right SLAS handling, just doesn't do so reliably. Reinforces that the SLAS prose tightening should land as a follow-up iteration; the regression is real but bimodal.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Synthesis-eval (overall) | 15/15 strict | 13/15 strict | partial -- 1 fixture under-passes; finding documented |
| Routing correctness | 15/15 | 15/15 | yes |
| Citation-leak guard | 0 leaks | 0 leaks | yes |
| OCAPI direction guard | 5/5 | 5/5 | yes (the originally-feared failure mode) |
| Coupon-op named correctly | 5/5 | 5/5 | yes |
| Cascade-order link | 5/5 | 5/5 | yes |
| Worked example committed | 1 | 1 (scenario-add-coupon-checkout) | yes |

## Next steps

This iteration ships at 13/15 strict with the OCAPI path-prefix regression as a tracked finding. Two follow-up iterations are queued:

1. **`iteration-todo-slas-cross-reference-prose.md`** (already filed) -- cross-reference prose tightening; addresses the SLAS-shrug in `docs/examples/scenario-createorder-prereqs/`.
2. **A future iteration on OCAPI path-prefix discipline** -- tighten SKILL.md "Output composition" so `## Run it` is mandatory and the runnable uses canonical full paths; re-run this synthesis-eval to verify OCAPI moves to 5/5.

Both can land together in one SKILL.md tightening if a future maintainer prefers; they touch adjacent prose. Either way: don't tune the assertions; tighten the skill.
