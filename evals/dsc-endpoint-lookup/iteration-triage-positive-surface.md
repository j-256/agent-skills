---
name: iteration-triage-positive-surface
description: dsc-endpoint-lookup hold at 40/40 while dsc-triage's description was tightened to claim spec-field-questions-in-failure-context
type: project
---

# iteration-triage-positive-surface

**Date:** 2026-05-20
**Skill:** dsc-endpoint-lookup (companion to dsc-triage edit)
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 40/40, runs=3, ~43 min wall clock (2572s). No regression vs. all prior 4.6 iterations.

## Hypothesis

This iteration edits dsc-triage's description (see `evals/dsc-triage/iteration-triage-positive-surface.md`); dsc-endpoint-lookup is unedited. Confirming dsc-endpoint-lookup's 40/40 baseline still holds when dsc-triage tightens its spec-field-in-failure-context surface -- specifically that dsc-triage's new prose doesn't pull in dsc-endpoint-lookup's positive queries (e.g. "what scopes does shopper-products getProducts need?").

The risk: dsc-triage now mentions "which scope does this 403 say I'm lacking" as a covered case. Could 4.6 reclassify clean dsc-endpoint-lookup positives that mention scope as triage-shaped? Tested by running the full eval set unchanged.

## Result

40/40 (120/120 individual runs). Zero cross-skill misroutes. No degradation in negative-routing either.

## Verdict

dsc-endpoint-lookup's positive surface and decline list are unaffected by dsc-triage's positive-surface tightening. The new triage prose successfully scopes itself to "failing request artifacts" (cURL + error body + status code) without bleeding into clean spec-field questions.

## Files

- `evals/dsc-endpoint-lookup/runs/iteration-triage-positive-surface/results.json` (gitignored)

## Cross-reference

- `evals/dsc-triage/iteration-triage-positive-surface.md` -- the edit being validated against, 20/23.
- `iteration-4-6-baseline.md` -- prior 40/40 baseline at the start of phase 1.
- `iteration-decline-list-tightening.md` -- the previous failed phase 2 attempt; this companion validated 40/40 hold there too.
