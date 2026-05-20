---
name: iteration-triage-positive-surface
description: dsc-scenario hold at 22/23 confirms dsc-triage's positive-surface change did not cause cross-skill regression
type: project
---

# iteration-triage-positive-surface

**Date:** 2026-05-20
**Skill:** dsc-scenario (companion to dsc-triage edit)
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 22/23, runs=3, ~27 min wall clock (1604s). Same total as `iteration-4-6-baseline` (22/23).

## Hypothesis

`evals/dsc-triage/iteration-triage-positive-surface.md` tightened dsc-triage's description to claim "spec-field questions when the framing is a failure" – e.g. "which scope does this 403 say I'm lacking", "is the 415 because content-type is wrong against the spec." That prose also broadens triage's surface in shapes that dsc-scenario covers (multi-call ticket reproductions where the user pastes a request and asks why the flow is failing).

Risk: 4.6 might reclassify dsc-scenario positives (cURL + chain-of-calls asks) as triage-shaped now that triage explicitly claims failure-context spec-field questions. Tested by running the full eval set unchanged.

## Edits applied

None to dsc-scenario. dsc-triage's description gained two clauses (see that skill's iteration note); dsc-endpoint-lookup's appended decline clause from `iteration-decline-list-tightening` was reverted in the same commit.

## Result

22/23 (hold vs. baseline 22/23). Total trigger pass rate unchanged, BUT the failing query is different:

| Query | Baseline | Tonight |
|---|---|---|
| `compose a multi-call flow to reach createOrder on shopper-orders, including the SLAS handshake to start...` | 1/3 ❌ | 3/3 ✅ |
| `target op is OCAPI shop-orders 'Submit basket' (POST /orders). what are the prerequisites...` | 3/3 ✅ | 1/3 ❌ |

So one previously-failing positive (`compose a multi-call flow`) recovered, and one previously-passing positive (the OCAPI Submit basket prereqs question) fell off. Net hold, with internal churn.

## Verdict

**No cross-skill regression from the dsc-triage prose change.** dsc-scenario's coverage stays at 22/23. The query swap is interesting but not actionable on its own – both queries are dsc-scenario positives, and the new failure is on the OCAPI side (which has historically been the lower-confidence half of dsc-scenario's coverage).

The `compose a multi-call flow` query recovered specifically because the new dsc-triage prose narrowed triage's claim on cURL-shaped inputs that have no error context, leaving the routing slot open for dsc-scenario. The OCAPI Submit basket query slid the other way: 4.6 routed it to dsc-endpoint-lookup as "spec-field question about a named operation" rather than dsc-scenario's "what are the prerequisites" framing.

The OCAPI-shape sensitivity is also visible in `evals/dsc-triage/iteration-triage-positive-surface.md`, which listed the OCAPI shop-baskets 400 query as coin-flippy in the dsc-triage set. Worth flagging in any future walkthrough doc that OCAPI human-prose operationIds (`Submit basket`) carry weaker routing signal than camelCase SCAPI ones (`createOrder`).

## Throttle and elapsed observations

- Per-call elapsed: avg 92.2s, p50 83.7s, p95 204.5s, max 281.9s (one cold-start chain-of-calls query).
- Retries: 2 events across 69 runs (3% of runs hit any retry, total of 2 retry events).
- 0 timeouts, 0 budget-exhausted.

This iteration ran sequentially (not in parallel with another eval, unlike `iteration-decline-list-tightening` which had two evals sharing the gateway). See `evals/dsc-endpoint-lookup/iteration-single-worker-baseline.md` for the per-call elapsed baseline established by the workers=1 run that followed this one.

## Files in this iteration

- `evals/dsc-scenario/runs/iteration-triage-positive-surface/results.json` – probe-eval output (gitignored).

## Cross-reference

- `evals/dsc-triage/iteration-triage-positive-surface.md` – the dsc-triage prose change being checked.
- `evals/dsc-scrape/iteration-triage-positive-surface.md` – companion cross-skill confirmation (also a hold).
- `evals/dsc-endpoint-lookup/iteration-triage-positive-surface.md` – the original 40/40 hold on the receiving-end skill.
- `evals/dsc-endpoint-lookup/iteration-single-worker-baseline.md` – single-worker baseline run that followed this iteration.
