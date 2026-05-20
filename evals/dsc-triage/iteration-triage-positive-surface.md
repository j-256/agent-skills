---
name: iteration-triage-positive-surface
description: Phase 2 of brief 10 -- positive-surface tightening on dsc-triage recovers +3 from 4.6 baseline (17/23 -> 20/23)
type: project
---

# iteration-triage-positive-surface

**Date:** 2026-05-20
**Skill:** dsc-triage
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 20/23 passed, runs=3, ~44 min wall clock (2655s).
**Prior result:** 17/23 (`iteration-4-6-baseline`).
**Companion run:** `evals/dsc-endpoint-lookup/iteration-triage-positive-surface.md` -- 40/40 hold (no regression).

## Phase 2 of brief 10

Phase 1 of brief `10-routing-variance-after-model-swap.md` re-baselined all four DSC skills on 4.6 and identified dsc-triage as the dominant drift (17/23, -6 vs. 4.5). Phase 2 is the prose tightening to recover.

The brief originally proposed two options:
- **Option 1:** lead dsc-triage's description with "you pasted a *failing* request" rather than "you have a request and an error body" framing.
- **Option 2:** extend dsc-endpoint-lookup's decline list to push back when the input includes an error body asking why a request is failing.

The brief leaned toward option 2 since dsc-endpoint-lookup is the receiving end of all four skills' drift. **Option 2 was tried first, in `iteration-decline-list-tightening`, and regressed dsc-triage to 16/23.** Diagnostic transcripts captured the same session showed the model commits to "spec-field lookup" early based on dsc-endpoint-lookup's *positive* identity, never reaching the appended decline clause -- the lookup-courting language ("how-to asks that are really spec-field questions in disguise") and concrete example list dominate routing.

This iteration tries option 1 instead: tighten dsc-triage's *positive* surface to claim spec-field-questions-in-failure-context explicitly.

## Edit applied

`skills/dsc-triage/SKILL.md` description, two clauses added to the existing prose:

1. Expanded the error-body example list with `401 AuthenticationFailedException` and `415 content-type` to mirror the failing-query shapes from baseline.
2. New mid-description clause: *"Also covers spec-field questions when the framing is a failure: 'which required body field is missing from this 400', 'which scope does this 403 say I'm lacking', 'is the 415 because content-type is wrong against the spec' -- the answer cites a spec field, but the *dispositive* signal is the failing-runtime-artifact context (cURL + error body + status code together), which routes here, not to `dsc-endpoint-lookup`."*
3. Closing decline tightened from "what does this endpoint require" to "*unprompted* 'what does this endpoint require' questions without a failing request attached."

Description grew from 133 -> 213 words / 953 -> 1487 chars. Still shorter than dsc-endpoint-lookup's 273 words.

`skills/dsc-endpoint-lookup/SKILL.md` was reverted (the appended decline clause from `iteration-decline-list-tightening` removed) -- diagnostic showed it wasn't being read.

## Result

20/23 (+3 vs. baseline 17/23, +4 vs. iteration-decline-list-tightening 16/23).

Of the 6 baseline failures, 4 recovered to 3/3 + 1 partial:

| Query | Baseline | Iter 1 (decline) | Iter 2 (positive surface) |
|---|---|---|---|
| insufficient_scope cURL | 3/3 | 1/3 | **3/3** ✅ |
| SLAS unauthorized_client | (was passing) | 0/3 | **3/3** ✅ |
| createBasket 400 missing_parameter | 1/3 | 0/3 | 0/3 |
| getCustomer 403 + JWT decode | 0/3 | 0/3 | **3/3** ✅ |
| baskets/items 400 invalid_request | 1/3 | 0/3 | **3/3** ✅ |
| 415 content-type | 1/3 | (passed) | **3/3** ✅ |
| OCAPI shop-customers JWT 401 | 1/3 | 0/3 | **3/3** ✅ |
| OCAPI shop-baskets 400 MissingRequiredProperty | 1/3 | 1/3 | 1/3 |

One new regression on a previously-passing negative case:

| Query | Baseline | Iter 1 | Iter 2 |
|---|---|---|---|
| B2C Commerce job webhook silently dropping events (NEGATIVE) | 3/3 decline | (passed) | **3/3 over-trigger** ❌ |

Net: +5 positives recovered, -1 negative over-triggered, 2 stubborn positives unchanged. **20/23.**

## Verdict

Phase 2 closes brief 10 at 20/23 -- the best 4.6 score across any iteration of dsc-triage. The remaining 3 failures fall into three categories, none of which look prose-tractable:

1. **`createBasket 400 missing_parameter`** -- pure spec-field framing. The diagnostic captured this query specifically; the model thinks "this is a spec-field question about createBasket" before reading anything else in the description. Lacks an error *body* (only a status code), so the failing-runtime-artifact signal is too weak to override the spec-field commitment. Probably untractable without altering query phrasing.

2. **`OCAPI shop-baskets 400 MissingRequiredProperty`** -- coin-flippy. 1/3 in baseline, 1/3 in this iteration. Same shape as the recovered queries but with OCAPI-style operationId (human-prose, not camelCase) which may dilute the failing-request shape signal. Borderline; not worth more prose tightening.

3. **`B2C Commerce job webhook silently dropping events`** -- runtime-behavior question without an API error. The new positive-surface clause pulls this in by accident: "spec-field questions when the framing is a failure" reads broadly enough that "deliveries are silently dropping" is a failure-framing question even though there's no API call to diff. This is the trade-off the brief warned about ("both tightenings together would over-correct"). Not worth a third prose iteration to reclaim a single query.

## Decision

Close brief 10 at 20/23. Document the remaining 3 fails honestly in the iteration notes; flag `createBasket missing_parameter` as a candidate for future query-text tuning (the queries are all fictional, generated during eval authoring; tuning them with realistic customer-ticket phrasing is a separate axis from prose-tightening).

## Files in this iteration

- `evals/dsc-triage/runs/iteration-triage-positive-surface/results.json` -- probe-eval output (gitignored).
- `skills/dsc-triage/SKILL.md` -- description edit.
- `skills/dsc-endpoint-lookup/SKILL.md` -- decline-clause revert.

## Cross-reference

- `iteration-4-6-baseline.md` -- 17/23 phase 1 baseline this builds on.
- `iteration-decline-list-tightening.md` (filed below for archaeology) -- the failed option 2 attempt.
- `evals/dsc-endpoint-lookup/iteration-triage-positive-surface.md` -- companion 40/40 hold.
- `/wd/_TODO-dsc-scrape/10-routing-variance-after-model-swap.md` -- closing this brief.
