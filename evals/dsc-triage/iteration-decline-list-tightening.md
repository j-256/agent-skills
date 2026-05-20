---
name: iteration-decline-list-tightening
description: Phase 2 attempt 1 -- decline-list edit on dsc-endpoint-lookup didn't move dsc-triage routing; superseded by iteration-triage-positive-surface
type: project
---

# iteration-decline-list-tightening

**Date:** 2026-05-20
**Skill:** dsc-triage (companion to dsc-endpoint-lookup edit)
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 16/23 (-1 vs. baseline 17/23). Reverted; superseded by `iteration-triage-positive-surface` (20/23).
**Companion run:** `evals/dsc-endpoint-lookup/iteration-decline-list-tightening.md` (40/40, no regression).

## What this iteration tried

Phase 2 of brief `10-routing-variance-after-model-swap.md` proposed two prose-tightening options. The brief leaned toward **option 2: tighten dsc-endpoint-lookup's decline list to push back when the input includes an error body asking why a request is failing.** This iteration is option 2.

`skills/dsc-endpoint-lookup/SKILL.md` description gained one new clause appended to the existing decline list:

> Also decline when the user pasted a *failing* request -- cURL / HTTP request-response pair / error body / status code -- and is asking why it's failing or what's wrong against the spec; that's `dsc-triage` even when an endpoint is named.

Hypothesis: the new clause would make 4.6 push cURL+error-body queries back to dsc-triage, recovering the +6 dsc-triage drift.

## Result

16/23 -- regression of 1 vs. baseline. Of the 6 baseline failures: 1 recovered (415 content-type), but 2 previously-passing queries newly failed. Net -1.

## Diagnostic that explained the failure

Captured during the same session: 3x runs of `createBasket 400 missing_parameter` query, full stream-json with thinking blocks. All three thinking outputs:

> Run 1: "This is a spec-field lookup question about the Shopper Baskets API ... clearly a job for the dsc-endpoint-lookup skill"
> Run 2: "The user wants to look up the spec for the createBasket endpoint ... clearly a dsc-endpoint-lookup skill task"
> Run 3: "The user is asking me to look up the spec for the createBasket endpoint ... this is exactly what the dsc-endpoint-lookup skill is for"

**Zero mentions of dsc-triage, decline, or alternative-skill consideration.** The model committed to "spec-field lookup" before reading any decline content -- the lookup-courting language earlier in dsc-endpoint-lookup's description ("Look up and quote one spec field... OAuth scopes, query params...") and concrete examples (`getProducts`, `searchOrders`) dominate routing.

A second diagnostic on the *insufficient_scope cURL* query (which had 1/3 triggered triage post-edit, was 3/3 in baseline) showed the model occasionally considers both skills, then lands on dsc-endpoint-lookup because it anchors on "OAuth scopes" being a documented field that skill claims.

## Why option 2 didn't work

dsc-endpoint-lookup's positive identity is too strong on 4.6 to be overridden by appended decline language. Its description leads with multi-clause spec-field-courting prose, lists concrete operation examples, then has a long decline list. The new decline clause landed after all of that and was effectively invisible to early-commitment routing.

The lever for this kind of routing tension is dsc-triage's *positive* surface, not dsc-endpoint-lookup's negative surface. See `iteration-triage-positive-surface.md` for the successful follow-up.

## Disposition

Edit reverted. Filed for archaeology -- the diagnostic data here motivates the option-1 work in the successor iteration.

## Files in this iteration

- `evals/dsc-triage/runs/iteration-decline-list-tightening/results.json` (gitignored)
- `evals/dsc-endpoint-lookup/runs/iteration-decline-list-tightening/results.json` (gitignored)
