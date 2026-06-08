# iteration-hook-fabrication-tighten

Status: PARTIAL. The original failure mode from [`iteration-no-match-baseline.md`](iteration-no-match-baseline.md)'s `case-471466355` over-fire – fabricated runtime-consumer claims dressed as spec-grounded prose – is **fixed**. Three runs against the strengthened SKILL.md all produce clean wholesale-decline output with no spec lookup, no `required`-field list, and no per-field "CSC depends on X" claims. However the harness's binary trigger metric still scores the case 3/3 fire (Skill tool invoked first), because the model launches the skill before composing the decline output. Whether to ship is a judgment call: the eval-plan criterion was "skill declines correctly," and by composition behavior it does, but by trigger metric it does not.

## Hypothesis tested

`case-471466355`'s fabrication was a description gap, not a model-judgment gap. SKILL.md's existing decline language gated on "no endpoint field is in scope at all" – which fails for questions that name an endpoint (`product_search`) but whose load-bearing question is what a separate downstream runtime (Customer Service Center) requires of the response. Adding "questions about what a separate runtime consumer of the response requires" as an explicit decline shape should drive the case from fire → decline.

The hypothesis was framed as binary against the harness's majority-decline threshold (≤1/3 fires for a `should_trigger=false` fixture). Three runs of the case at ≤1/3 fires would mean the prose change worked. **Three runs at 3/3 fires meant the binary signal said the change failed** – but reading the actual transcripts told a different story.

## What was changed in SKILL.md

Three additions to `skills/dsc-endpoint-help/SKILL.md`, all targeting the same shape:

1. **Frontmatter `description` decline list.** Appended a sentence explicitly naming the shape – "questions about what a separate runtime consumer of the response requires – Customer Service Center field dependencies, SFRA hook semantics, 'which response fields can my custom hook null out without breaking X'" – and the reasoning ("the spec describes the endpoint's own input/output, not what other runtimes downstream of the response do with it, so any spec-framed answer would be fabrication").
2. **"What this skill doesn't do" section.** Added a parallel bullet ("No runtime-consumer field dependencies") with the same shape examples and a concrete redirect ("instrument the consumer, ask the team that owns it").
3. **The "carving trap" explanation.** A second paragraph under bullet 2 naming the exact failure mode the model was reaching for: looking up a `required` field list and stitching it into a runtime-consumer answer. This paragraph names *why* the carving feels helpful and *why* it's the failure ("The spec saying a field is `required` means the API guarantees emitting it; it does not mean any specific consumer requires it"). Added in the second prose-strengthening pass after the first pass left composition behavior unimproved across 3 runs.

The third addition was load-bearing. Without it, the model reads the rule, acknowledges it in chain-of-thought, and then still proceeds to run a spec lookup and compose a "here's what we can say from the spec" preamble next to the customer's runtime observations – producing exactly the fabrication shape the rule exists to prevent. With it, the model declines the lookup and goes straight to a wholesale-decline output.

An earlier draft directed the user at `dsc-runtime-triage` "(when it exists)" as a redirect target. That skill is Phase 2 and explicitly deferred per [CLAUDE.md](../../CLAUDE.md). Pointing at a non-existent skill in the decline language would itself be the fabrication-shaped failure this iteration exists to fix. The final prose redirects to concrete runtime-debugging steps the user can take instead.

## Methodology

**Eval set.** `evals/dsc-endpoint-help/trigger-eval.json`. Initial 33-fixture baseline run uses the file as it stood at iteration start. Subsequent runs use the 34-fixture set including `decline-hook-fabrication-csc-field-deps`, derived from the no-match dataset's `case-471466355` query.

The customer's original ticket was in Japanese; the v2 trigger-eval and v2 synthesis-eval runs reported here used that original-language fixture. After those runs completed, the fixture was translated to English (this skill family is English-only by scope; carrying a JP fixture into the tracked regression set would create maintenance load future contributors couldn't reasonably triage). The English fixture preserves the load-bearing signal: a hook-implementation question with a runtime-consumer dependency, asked about a named SCAPI endpoint. The decline shape under test is the same in either language.

**Eval config.** `runs=3 workers=4 timeout=300`, `--profile isolated` (default). Pass criterion is the harness's majority threshold (≥2/3 fires for `should_trigger=true`, ≤1/3 for `should_trigger=false`).

**Harness.** Submodule pinned at `160f014` on `stream-eval` `main` – includes split-timeout, worktree-lock, banner timestamps, green-means-correct semantics, and the operator-stop fix.

**Three runs total.** First run is the 33-fixture baseline against the initial prose-tightened SKILL.md – measures whether the prose change regressed already-passing cases. Second run is the 34-fixture set against the same initial prose – measures whether the prose change drives the new case from fire to decline (it didn't). Third run is the 34-fixture set against the second prose-strengthening pass – measures whether the "carving trap" addition fixes the composition behavior.

## Results

| Run | Eval | Fixtures | Pass rate | New-case triggers | Notes |
|---|---|---|---|---|---|
| Baseline (initial prose) | trigger | 33 | 31/33 (94%) | – | OCAPI-401-error-only and createOrder-prereqs already failed pre-iteration |
| 34-fixture (initial prose) | trigger | 34 | 31/34 (91%) | 3/3 | New case fires; original 33 unchanged |
| 34-fixture v2 (strengthened) | trigger | 34 | 31/34 (91%) | 3/3 | New case still fires per binary metric, but composition behavior is now clean decline |
| Hook-fab fixture, English | synthesis | 1 | 5/5 strict | 5/5 | All 5 runs pass all 4 composition assertions; the v2 prose's clean-decline behavior is now a tracked invariant |
| 34-fixture (English fixture) | trigger | 34 | 31/34 (91%) | 3/3 | Translating the JP query to English doesn't change trigger behavior; same shape persists |

**Pre-existing 33-fixture failures (unrelated to this iteration's change):**

- `error-only-no-request-401-OCAPI` (should_trigger=true, fired 0/3 then 1/3) – sparse-signal request: error string + "what does shop API generally require for auth" without a curl. Marginal under-fire; not in this iteration's scope.
- `decline-multi-call-prereqs-createOrder` (should_trigger=false, fired 2/3 then 3/3) – boundary with `dsc-scenario`. The "prereqs for createOrder" framing pulls the model toward firing dsc-endpoint-help on what should be a dsc-scenario question. Pre-existing; the v2 prose did NOT cause this regression (it was 2/3 in the baseline run too, just under the majority threshold).

**Composition behavior across the three new-case runs of v2 (the actual signal the iteration was fixing):**

- Run 1: "This question falls outside this skill's scope... Spec required ≠ consumer requires... If we presented a spec-required-field list next to your debugger findings, it would create the false impression that 'the spec says CSC needs these.' That's the misinformation this skill is built to prevent." Then redirects to CSC source code + debugger + Salesforce support. **No spec lookup performed. No required-field list quoted. No per-field CSC-impact claims.**
- Run 2 (English output): "The spec for product_search describes the endpoint's guaranteed output shape – it does not describe what Customer Service Center reads from that payload. A spec lookup here would produce something like `required: [refinements, ...]`, which would then read as 'the spec says CSC needs `refinements`' – but that's fabrication." Then redirects to instrumenting the response object in the hook. **No spec lookup performed. No required-field list quoted. No per-field CSC-impact claims.**
- Run 3: "The core of your question is which fields CSC depends on, which is a runtime issue not a spec issue. We could look up whether the spec defines `refinements` or `orderable`. But 'the spec defines this field' does not mean 'CSC requires this field' – presenting both side-by-side would create the false impression that the spec mandates these for CSC, which is exactly the misinformation this skill should prevent." Then lists three architectural options for the customer (custom API, caller-identification in hook, don't null fields), confirms the customer's debugger findings as authoritative. **No spec lookup performed. No required-field list quoted. No per-field CSC-impact claims.**

Compare to the original transcript at `runs/iteration-no-match-final-recategorized/transcripts/results/case-471466355-1.jsonl`, which produced a per-field "CSC dependency" table claiming `productResponse.refinements` causes a 500 in CSC, `hit.currency` makes the display show `$`, etc. – all dressed as spec-grounded prose with no DSC URL backing. **That output is gone.** v2's runs are clean wholesale-decline, redirecting to runtime-debugging steps the user can take.

## Conclusions

The original failure mode (fabricated runtime-consumer claims dressed as spec output) is fixed. The v2 prose change drives all 3 runs to clean wholesale-decline output: no spec lookup, no `required`-field list, no per-field "CSC depends on X" claims. The model now explicitly cites the "spec required ≠ consumer required" distinction in its own prose – a sign that the carving-trap explanation is being read and operationalized.

The harness's trigger metric still scores the case 3/3 fire because the `Skill` tool is the first tool invoked. The trigger-time signal is a poor proxy for composition behavior in this case: the model launches the skill, the skill reads its own SKILL.md, the SKILL.md instructs wholesale decline, and the model composes a clean decline output – but `first_tool=Skill` already wrote the trigger metric. This is a measurement gap, not a behavior gap.

What this iteration does *not* settle:

- Whether the binary trigger metric should be amended for cases where wholesale-decline is composed *after* the skill is invoked. A reasonable read is that the harness measures one thing (trigger) and synthesis-eval measures another (composition); both have their place. The synthesis-eval assertion was added in this iteration – it now passes 5/5 strict against the English fixture, converting "the model produces clean decline output" from a transcript-only signal into a tracked invariant.
- Whether the prose tightening generalizes to other runtime-consumer shapes (SFRA hooks, page-designer rendering, BM admin tooling) that may surface in future fixtures. Sample size of one new case isn't enough to characterize the rule's coverage.
- Whether the same carving-trap shape is reproducible *in transcripts* of historic over-fires beyond `case-471466355`. The methodology lesson from `iteration-no-match-baseline` (tag against transcripts, not surface framing) applies: a future iteration might find more cases of the same shape in the no-match dataset by grepping prior transcripts for spec-quote-followed-by-consumer-claim composition patterns.

What this iteration *does* settle:

- The decline shape is now named explicitly in SKILL.md – frontmatter, "What this skill doesn't do," and a paragraph explaining the carving trap. Engineers extending the skill can read the rule and the *why* behind it.
- `case-471466355` is in the tracked regression set as `decline-hook-fabrication-csc-field-deps`. Future iterations that touch the description will see the case run automatically. If the prose ever drifts back to a state where the fabrication composition returns, that drift becomes visible in synthesis-eval transcripts even if it remains invisible to the trigger metric.

## Methodology lesson

**Trigger-eval is a coarse signal for composition fixes.** When a SKILL.md change targets the *shape of the output* rather than the *first-tool decision*, trigger-eval will show a binary "still fires" answer that's blind to the underlying improvement. Reading per-run transcripts is essential to distinguish "the prose change failed" from "the prose change worked but the metric isn't measuring what changed." For composition-shaped fixes, synthesis-eval is the right tool. Trigger-eval should still run as a regression guard (to confirm no fixtures that *previously* passed the trigger metric started failing), but the load-bearing measurement for composition is in the transcripts.

The instruction's binary criterion ("if the skill still fires on it after the SKILL.md tightening, the prose change isn't strong enough") has an unstated assumption: that firing implies composition failure. This iteration falsifies that assumption – the model can both fire AND compose a clean wholesale-decline output. Future iterations targeting composition behavior should pair trigger-eval with synthesis-eval rather than rely on trigger metric alone.

## Follow-ups

1. **Generalize to other runtime-consumer shapes.** Watch future no-match datasets for SFRA-hook-semantics, page-designer-rendering, and BM-admin-tooling questions where the user names an endpoint but asks about a separate downstream consumer. If the carving-trap rule fires correctly on those shapes too, the rule generalized. If it doesn't, the prose may need shape-specific examples.
2. **Pre-existing failures in the 33-fixture set.** `error-only-no-request-401-OCAPI` (under-fire 0–1/3 across runs, sparse-signal request: error string + "what does shop API generally require for auth" without a curl) and `decline-multi-call-prereqs-createOrder` (over-fire 2–3/3, dsc-scenario boundary). Not regressions from this iteration. Triaging belongs in a future iteration that decides whether to (a) tighten SKILL.md to reliably fire on sparse-signal error-only requests, (b) rebalance the dsc-scenario vs. dsc-endpoint-help boundary so "prereqs for X" framings route to dsc-scenario reliably (this is the higher-priority fix – two skills' descriptions are competing and the wrong one is winning), or (c) accept as known boundary cases.
3. **Pre-existing synthesis-eval failure: `synthesis-diff-jwt-scope-decode`.** Failed 0/5 runs in the synthesis-eval pass against the current SKILL.md – `first_tool=Bash` rather than `Skill` (model decoded the JWT manually instead of invoking the skill). Triage: real regression (skill drift), environment shift (toolbelt change), or known-marginal? Document or fix in a separate follow-up iteration.
