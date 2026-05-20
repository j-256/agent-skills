---
name: iteration-decline-list-tightening
description: dsc-endpoint-lookup 40/40 hold under decline-list edit; companion run for the (reverted) phase 2 attempt 1
type: project
---

# iteration-decline-list-tightening

**Date:** 2026-05-20
**Skill:** dsc-endpoint-lookup
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 40/40, runs=3, ~40 min wall clock (2391s).

## Hypothesis

This iteration tested phase 2 option 2 of brief 10: a new decline clause appended to dsc-endpoint-lookup's description pushing back on cURL+error-body queries. Goal: verify the edit doesn't break dsc-endpoint-lookup's own 40/40 trigger surface while (separately) measuring whether it recovers dsc-triage routing.

## Result

40/40 (120/120 individual runs). The edit didn't break this skill's positive or negative routing.

The companion dsc-triage run (see `evals/dsc-triage/iteration-decline-list-tightening.md`) regressed to 16/23 -- the decline clause didn't accomplish its goal, so the edit was reverted in `iteration-triage-positive-surface`.

## Files

- `evals/dsc-endpoint-lookup/runs/iteration-decline-list-tightening/results.json` (gitignored)

## Cross-reference

- `evals/dsc-triage/iteration-decline-list-tightening.md` -- the failed companion eval that motivated the revert.
- `iteration-triage-positive-surface.md` -- the successful follow-up.
