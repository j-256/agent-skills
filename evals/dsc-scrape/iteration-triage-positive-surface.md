---
name: iteration-triage-positive-surface
description: dsc-scrape hold at 19/20 confirms dsc-triage's positive-surface change did not cause cross-skill regression
type: project
---

# iteration-triage-positive-surface

**Date:** 2026-05-20
**Skill:** dsc-scrape (companion to dsc-triage edit)
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 19/20, runs=3, ~18 min wall clock (1077s). Same total as `iteration-4-6-baseline` (19/20).

## Hypothesis

`evals/dsc-triage/iteration-triage-positive-surface.md` tightened dsc-triage's description with a "failure-context spec-field" clause. That broadens dsc-triage's positive surface; the question for dsc-scrape is whether 4.6 might pull scrape-shaped queries (e.g. "fetch the einstein-recommendations reference") into dsc-triage when the user phrases them with a hint of failure ("scrape this so I can check why my request fails"). Tested by running the full eval set unchanged.

## Edits applied

None to dsc-scrape. The change was on dsc-triage; this iteration is purely a cross-skill confirmation.

## Result

19/20 (hold vs. baseline 19/20). The single failing query is the same as baseline:

| Query | Baseline | Tonight |
|---|---|---|
| `scrape the Salesforce Platform REST API guide at developer.salesforce.com/docs/a...` (NEGATIVE – atlas-format guide, out of scope per the skill's decline list) | 3/3 over-trigger ❌ | 2/3 over-trigger ❌ |

Marginal improvement (3/3 → 2/3 over-trigger) on the same query. The ❌ status doesn't change because the threshold for negative pass is `<50%` and 2/3 (67%) is still over that. Net 19/20.

## Verdict

**No cross-skill regression from the dsc-triage prose change.** dsc-scrape's coverage stays at 19/20.

The lingering atlas-decline failure is a known weakness documented in `iteration-4-6-baseline.md` (filed as not prose-tractable on 4.6 without altering query phrasing). It's the only red cell on dsc-scrape's eval set and has been since the model swap. The slight improvement to 2/3 over-trigger is encouraging but not load-bearing.

## Throttle and elapsed observations

- Per-call elapsed: avg 59.4s, p50 36.0s, p95 209.6s, max 508.6s.
- The max (508.6s) is an outlier on a query that picked `ToolSearch` instead of `Skill` as its first tool – the scrape decided to search for a relevant skill rather than dispatching directly. Worth noting but not actionable here (and not a throttle artifact – retries=0 on that run).
- Retries: 0 across all 60 runs. 0% any-retry. 0 timeouts, 0 budget-exhausted.

## Files in this iteration

- `evals/dsc-scrape/runs/iteration-triage-positive-surface/results.json` – probe-eval output (gitignored).

## Cross-reference

- `evals/dsc-triage/iteration-triage-positive-surface.md` – the dsc-triage prose change being checked.
- `evals/dsc-scenario/iteration-triage-positive-surface.md` – companion cross-skill confirmation (also a hold).
- `evals/dsc-endpoint-lookup/iteration-triage-positive-surface.md` – the original 40/40 hold on the receiving-end skill.
- `evals/dsc-endpoint-lookup/iteration-single-worker-baseline.md` – single-worker baseline run that followed this iteration.
- `evals/dsc-scrape/iteration-4-6-baseline.md` – the 19/20 baseline this confirms.
