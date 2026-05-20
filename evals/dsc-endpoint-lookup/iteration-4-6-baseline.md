---
name: iteration-4-6-baseline
description: Re-baseline trigger eval for dsc-endpoint-lookup on Sonnet 4.6
type: project
---

# iteration-4-6-baseline

**Date:** 2026-05-19
**Skill:** dsc-endpoint-lookup
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 40/40 passed, runs=3, ~76 min wall clock (4564.5s).

## Hypothesis

No DSC skill had been trigger-eval'd on Sonnet 4.6 since the model swap (`iteration-negative-pivot-citation`, commit `b4a0628`). Two synthesis-iteration data points hinted at routing variance and pointed at the dsc-scrape ↔ dsc-endpoint-lookup boundary -- this iteration measures dsc-endpoint-lookup directly.

Same eval set as the most recent 4.5 baseline (`iteration-catalog-walk-batch-3`, 40/40), no description changes.

## Setup

Same `evals/dsc-endpoint-lookup/trigger-eval.json` (40 queries: 32 positive + 8 negative), runs=3, workers=4, --timeout 1800 (api_retry-aware bail; see harness section).

## Result

**40/40 queries pass on Sonnet 4.6.** No regressions vs. the 40/40 on Sonnet 4.5.

Per-run granularity: 120 of 120 individual runs pass. Zero query had any cross-run flakes.

## Verdict

dsc-endpoint-lookup is the receiving end of the cross-skill drift, not a contributor to it. Other skills' queries occasionally route to dsc-endpoint-lookup on 4.6 where they routed elsewhere on 4.5, but dsc-endpoint-lookup's *own* queries trigger and decline correctly.

The original routing-variance hypothesis (dsc-scrape ↔ dsc-endpoint-lookup) was partially right -- dsc-endpoint-lookup is in tension with another skill -- but the actual sibling is dsc-triage, not dsc-scrape. See `evals/dsc-triage/iteration-4-6-baseline.md` for the cross-skill summary.

## Disposition

No prose changes. dsc-endpoint-lookup's description doesn't need tightening on its trigger surface -- everything within its scope routes correctly. If phase 2 work tightens its decline list (to push back against incoming routes from dsc-triage queries), that's a separate edit driven by the dsc-triage iteration's findings, not a defect in this skill's trigger surface.

## Files in this iteration

- `evals/dsc-endpoint-lookup/runs/iteration-4-6-baseline/results.json` – probe-eval output (gitignored).
