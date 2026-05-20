---
name: iteration-4-6-baseline
description: Re-baseline trigger eval for dsc-scrape on Sonnet 4.6
type: project
---

# iteration-4-6-baseline

**Date:** 2026-05-19
**Skill:** dsc-scrape
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 19/20 passed, runs=3, ~49 min wall clock (2948.2s).

## Hypothesis

Sonnet 4.6 has been the default eval model since the model swap in `iteration-negative-pivot-citation` (commit `b4a0628`). No DSC skill has had its trigger eval re-baselined under 4.6, only synthesis evals have run on it. Two synthesis-iteration data points (1/10 in `iteration-negative-pivot-citation`, 1/5 cold in `iteration-acronym-resolution`) suggest there's routing variance between 4.5 and 4.6 worth measuring directly.

This iteration runs the same `evals/dsc-scrape/trigger-eval.json` (20 queries, 10 positive + 10 negative) that scored 20/20 on Sonnet 4.5 in `iteration-baseline`, on Sonnet 4.6 with no description changes.

## Setup

Same eval set as `iteration-baseline` (no changes). Run with:

```bash
python3 tools/probe-eval.py \
  --eval evals/dsc-scrape/trigger-eval.json \
  --skill-name dsc-scrape \
  --runs 3 --workers 4 --timeout 1800 \
  --out evals/dsc-scrape/runs/iteration-4-6-baseline/results.json
```

Note: `--timeout` was bumped to 1800s as a *backstop*. The actual bail signal is api_retry-aware (CLI's 10-retry budget exhausted on a single call). See "Harness work shipped this session" below.

## Result

19/20 queries pass on Sonnet 4.6 vs. 20/20 on Sonnet 4.5. One regression:

| Query | 4.5 | 4.6 | First-tool routing on 4.6 |
|---|---|---|---|
| `scrape the Salesforce Platform REST API guide at developer.salesforce.com/docs/atlas.en-us.api.meta -- need the SOQL section` | declined | **fired dsc-scrape 3/3** | `Skill=dsc-scrape × 3` |

This query is `should_trigger=False` (the description's "Not for guides, concept pages, atlas-format books" decline language should fire). On Sonnet 4.5 the same query routed to `ToolSearch` once and text-only twice (per `iteration-baseline`'s "Cross-skill observations"). On 4.6 it fires `dsc-scrape` deterministically.

The 18 remaining positive queries all hit 3/3. Negatives all declined correctly except the atlas one.

## Verdict

Drift on dsc-scrape is small (1/20) and confined to a single edge case: the atlas-format decline. The test has been variant since 4.5; on 4.6 it tipped from "mostly declines" to "fires consistently."

This isn't the boundary the original routing-variance hypothesis predicted -- it expected drift at dsc-scrape ↔ dsc-endpoint-lookup. Across all four DSC skills (see `evals/dsc-triage/iteration-4-6-baseline.md` for the cross-skill summary) the drift is overwhelmingly at dsc-triage ↔ dsc-endpoint-lookup, with dsc-scrape only contributing this one atlas-decline regression.

## Disposition

No description changes this iteration. Phase 1 is baseline-gathering only.

The atlas-decline regression is a candidate for phase 2 prose tightening, but it's unrelated to the dominant dsc-triage ↔ dsc-endpoint-lookup drift pattern. Filed as a sub-finding for whoever does phase 2: dsc-scrape's "atlas-format books" decline language could be strengthened, but the priority is the dsc-triage description first since that's where the bulk of the regression sits.

## Harness work shipped this session

The probe-eval harness gained two improvements before the baseline run:

1. **Bail-on-timeout** ported from `tools/synthesis-eval.py` (commit `a916621`). probe-eval previously counted `subprocess.TimeoutExpired` silently as a non-trigger, contaminating baselines under throttle.
2. **api_retry-aware bail signal.** The CLI emits `{"type":"system","subtype":"api_retry","attempt":N,"max_retries":M,"error":"rate_limit"}` events in stream-json while waiting on the gateway. probe-eval now streams the JSONL live and bails only when `attempt == max_retries` (the documented gateway-poisoned signal), instead of treating wall-clock alone as the bail. The wall-clock now acts as a generous backstop (default 1800s) for hung processes. CLI rate-limit retries inside the budget no longer count against the timeout.

Both changes have unit-test coverage in `tools/test_probe_eval.py`.

## Files in this iteration

- `evals/dsc-scrape/runs/iteration-4-6-baseline/results.json` – probe-eval output (gitignored).
