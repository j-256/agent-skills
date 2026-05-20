---
name: iteration-single-worker-baseline
description: Single-worker measurement establishes raw per-call elapsed baseline (avg 42s, p50 37s, p95 82s) for future EWMA-based ETA work
type: project
---

# iteration-single-worker-baseline

**Date:** 2026-05-20
**Skill:** dsc-endpoint-lookup
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 40/40, runs=3, ~84 min wall clock (5057s). Hold vs. all prior 4.6 iterations.

## Why this iteration exists

The per-call wall clock on Sonnet 4.6 has never been measured in isolation. All prior iterations ran at `--workers 4`, which made the 4 workers' bursts of activity overlap on the gateway and contaminated any per-call timing measurement with parallelism effects.

This iteration runs the full eval set at `--workers 1` to establish the raw per-call elapsed distribution. Useful as the baseline that future EWMA-based ETA work in `tools/probe-eval-monitor.py` can anchor against.

## Hypothesis

Per-call elapsed at workers=1 should be close to the per-worker elapsed observed at workers=4, assuming gateway throttle isn't a major factor in the 4-worker case. (The 65%+ `api_retry` rate seen in `iteration-decline-list-tightening` came from running two probe-eval processes simultaneously – 4 workers each, 8 total against the gateway. No iteration has ever exercised workers=4 single-eval at high enough scale to suspect it.)

## Result

**40/40 trigger pass rate.** No change from any prior 4.6 iteration of this skill (the matrix has been pinned at 40/40 since `iteration-acronym-resolution`).

### Per-call elapsed at workers=1 (120 calls)

| Stat | Value |
|---|---|
| avg | 42.1s |
| p50 | 37.1s |
| p95 | 82.2s |
| max | 110.1s |

The p95 is striking – at workers=1 with effectively no throttle, p95 is still ~2x the median. That's the model's own response-time variance, not gateway pressure.

### Side observation: throttle and parallelism speedup

This iteration ran sequentially with `evals/dsc-scenario/iteration-triage-positive-surface.md` (workers=4) and `evals/dsc-scrape/iteration-triage-positive-surface.md` (workers=4); the three together produced an aggregate dataset:

- Total runs: 249
- Runs with any retry: 3 (1.2%)
- Total retry events: 3
- 0 timeouts, 0 budget-exhausted

So a sequential workers=4 single-eval pattern has effectively no throttle pressure. Recording the empirical baseline for future comparison.

Per-job parallelism speedup:

- dsc-scenario at workers=4: 69 × 92.2s = 6362s sum / 1604s wall = **3.97x** (essentially perfect).
- dsc-scrape at workers=4: 60 × 59.4s = 3564s sum / 1077s wall = **3.31x**.
- dsc-endpoint-lookup at workers=1: 1.00x (by construction).

Workers=4 single-eval scales near-linearly.

## Implications for future iterations

1. **Per-call elapsed for dsc-endpoint-lookup at workers=1 is now established** (avg 42.1s, p50 37.1s, p95 82.2s). EWMA ETA work in `tools/probe-eval-monitor.py` can anchor against these numbers without re-measuring.
2. **The single-worker baseline doesn't need to be repeated.** Subsequent iterations can compare at-scale numbers against this anchor.

## Files in this iteration

- `evals/dsc-endpoint-lookup/runs/iteration-single-worker-baseline/results.json` – probe-eval output (gitignored).

## Cross-reference

- `evals/dsc-endpoint-lookup/iteration-triage-positive-surface.md` – most recent prior 40/40 at workers=4 on the same 120-call eval set (2572s wall, parallel-eval conditions).
- `evals/dsc-scenario/iteration-triage-positive-surface.md` and `evals/dsc-scrape/iteration-triage-positive-surface.md` – the two cross-skill confirmation runs that completed sequentially before this one.
- `evals/dsc-endpoint-lookup/iteration-decline-list-tightening.md` – the iteration where the 65%+ retry rate was observed under parallel-evals load.

## Note on cross-iteration comparisons

Prior iterations of this eval set don't carry retry data – the per-run instrumentation that records `total_retries` and `elapsed_seconds` was added in the same session as this run (see `tools/probe-eval.py` for the current schema). Wall-clock numbers from those earlier iterations therefore can't be cleanly compared against this baseline, since we can't tell how much of any given iteration's wall was real per-call work vs retry-backoff under gateway pressure. Future iterations carry retry data and can be compared meaningfully.

## Out of scope (deferred)

- **Apparent "ToolSearch instead of Skill" routing** observed once on dsc-scrape during `iteration-triage-positive-surface`. One occurrence on a 60-call run; not actionable here.
