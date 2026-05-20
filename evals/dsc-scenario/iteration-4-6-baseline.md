---
name: iteration-4-6-baseline
description: Re-baseline trigger eval for dsc-scenario on Sonnet 4.6
type: project
---

# iteration-4-6-baseline

**Date:** 2026-05-19
**Skill:** dsc-scenario
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 22/23 passed, runs=3, ~77 min wall clock (4627.5s).

## Hypothesis

No DSC skill had 4.6 trigger numbers; this iteration baselines dsc-scenario. The most recent 4.5 baseline was `iteration-ocapi-coverage` at 23/23 (with 13 positive + 10 negative).

## Setup

Same `evals/dsc-scenario/trigger-eval.json` (23 queries), runs=3, workers=4, --timeout 1800.

## Result

22/23 queries pass on Sonnet 4.6. One regression:

| Query | 4.5 | 4.6 | First-tool routing on 4.6 |
|---|---|---|---|
| `compose a multi-call flow to reach createOrder on shopper-orders, including the SLAS token exchange upstream. emit it as a bash-pastable block of curl commands with placeholders for site-id and client-id` | 3/3 dsc-scenario | **1/3 dsc-scenario** | 2 of 3 routed to dsc-endpoint-lookup |

The query is unambiguously a multi-call workflow plan -- "compose a multi-call flow to reach createOrder, including the SLAS token exchange upstream, emit it as a bash-pastable block of curls" lists the exact things dsc-scenario's description names ("compose a linear plan + runnable cURL block"). On 4.5 it routed to dsc-scenario all 3 runs. On 4.6, 2 of 3 read the phrase "compose ... a bash-pastable block" as code-generation against a named endpoint and routed to dsc-endpoint-lookup.

## Verdict

This is the same drift pattern showing across the cross-skill summary: queries that name a specific endpoint (here `createOrder`) are increasingly read as endpoint lookups on 4.6, even when other shape signals (multi-call, ordering, ID threading) point to dsc-scenario. The single-query magnitude here (1/3 = 33% miss rate) is smaller than dsc-triage's pattern but the mechanism is shared.

Of the 13 positive queries, this is the one that names the most specific endpoint (`shopper-orders.createOrder`) and asks for runnable code. Other positives ("repro a registered shopper adding a promo coupon", "guest checkout with coupon fails", "minimum sequence to reach a state where I can call shopper-orders.getOrder and actually get a non-404") all kept routing to dsc-scenario at 3/3.

## Disposition

No prose changes this iteration. Phase 2 may want to clarify dsc-scenario's surface against dsc-endpoint-lookup. Leading candidate: the description already mentions "code-generation asks that reference a named endpoint" routes to dsc-endpoint-lookup, but says nothing about *workflow plans* that include code generation. dsc-scenario's existing decline list ("not for one-off 'what does this endpoint require' lookups") is on the boundary but doesn't push back on the case where the user wants both a plan AND a runnable bash block.

## Files in this iteration

- `evals/dsc-scenario/runs/iteration-4-6-baseline/results.json` – probe-eval output (gitignored).
