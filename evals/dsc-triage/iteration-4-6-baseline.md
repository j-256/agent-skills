---
name: iteration-4-6-baseline
description: Re-baseline trigger eval for dsc-triage on Sonnet 4.6 -- 26% regression vs. 4.5
type: project
---

# iteration-4-6-baseline

**Date:** 2026-05-19
**Skill:** dsc-triage
**Tool:** tools/probe-eval.py
**Model:** Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`)
**Result:** 17/23 passed, runs=3, ~68 min wall clock (4087.8s).

## Hypothesis

Same as the other three skills' 4-6-baseline iterations: re-measure 4.6 trigger accuracy directly. Most recent 4.5 baseline was `iteration-ocapi-coverage` at 23/23.

## Result

**17/23 queries pass on Sonnet 4.6 -- a 26% regression vs. 23/23 on Sonnet 4.5.**

This is by far the largest drift across the four DSC skills (dsc-scrape lost 1, dsc-endpoint-lookup 0, dsc-scenario 1, dsc-triage 6).

The six failing queries:

| # | Triggers | Routing on the failing runs | Query (truncated) |
|---|---|---|---|
| 1 | 1/3 | dsc-endpoint-lookup × 2, dsc-triage × 1 | "this createBasket call is returning 400 `missing_parameter` ... can you diff this against the spec and tell me what required field is missing" |
| 2 | 0/3 | dsc-endpoint-lookup × 3 | "customer pasted their access token (jwt) and says getCustomer is returning 403. can you decode the scp claim and compare to what shopper-customers.getCustomer actually requires?" |
| 3 | 1/3 | dsc-endpoint-lookup × 2, dsc-triage × 1 | "what's wrong with this request? POST /checkout/shopper-baskets/v1/baskets/{basketId}/items, body is ..., getting a 400 `invalid_request`" |
| 4 | 1/3 | None × 2, dsc-triage × 1 | "here's the full HTTP request + response pair -- the content-type is `application/x-www-form-urlencoded` and the endpoint expects JSON. can you check the spec and confirm that's the root cause of the 415" |
| 5 | 1/3 | dsc-endpoint-lookup × 2, dsc-triage × 1 | "OCAPI shop-customers `Get or refresh customer JWT` is 401-ing on POST /customers/auth -- response body is `{\"fault\":{\"type\":\"AuthenticationFailedException\"}}`. they're sending the JWT in the Authorization header. what's wrong against the spec?" |
| 6 | 1/3 | dsc-endpoint-lookup × 2, dsc-triage × 1 | "POST /baskets/{basket_id}/items in OCAPI shop-baskets is returning 400 with `{\"fault\":{\"type\":\"MissingRequiredPropertyException\"}}`. body they're sending is ... diff against the spec and tell me which field is bad" |

5 of 6 failing queries route the missing runs to **dsc-endpoint-lookup**. The 6th routes to text-only on 2 runs (no skill fired).

## Verdict

The drift is sharply concentrated at the **dsc-triage ↔ dsc-endpoint-lookup** boundary. The original routing-variance hypothesis (anchored on the 1/10 MCG slip in `iteration-negative-pivot-citation` and the 1/5 cold slip in `iteration-acronym-resolution`) had pointed at dsc-scrape ↔ dsc-endpoint-lookup; the trigger-eval re-baseline shows the dominant drift is one boundary over.

### What the failing queries have in common

All six are queries that **paste a failing request + an error body and ask why it's failing**. They include:

- A specific endpoint name (`createBasket`, `getCustomer`, `Get or refresh customer JWT`, etc.)
- An error code or error body (`400 missing_parameter`, `403`, `401 AuthenticationFailedException`, `400 MissingRequiredPropertyException`, `415`)
- Phrasing like "diff against the spec" / "what's wrong with this request" / "what's wrong against the spec" / "decode the scp claim and compare to what X requires"

These are textbook triage queries. They were 23/23 on Sonnet 4.5. On 4.6, Sonnet reads the *endpoint name + spec word* combination as a spec-field lookup, not a failure diagnosis.

### Mechanism

Both descriptions overlap on "spec" framings:

- dsc-triage description: *"Diagnose a failing Salesforce API request against its public spec on developer.salesforce.com (DSC). Invoke whenever the user pastes a cURL command, raw HTTP request, or error body ... and asks 'why is this failing' / 'what scope is missing' / 'what's wrong with this request.'"*
- dsc-endpoint-lookup description: *"Look up and quote one spec field on one endpoint ... by reading JSON ... Invoke whenever answering the user's ask requires knowing what one specific endpoint's spec says about one of those fields, even if the user's surface ask is broader: ... how-to asks that are really spec-field questions in disguise"*

Sonnet 4.5 read "what's wrong with this request, here's a body, diff against the spec" as a failure diagnosis. Sonnet 4.6 reads it as "to figure out what's wrong, you need the spec field for X -- that's a spec-field lookup." Both are defensible interpretations of the prose; 4.6's stronger lookup-bias surfaces the overlap.

The fact that **dsc-endpoint-lookup's description explicitly courts how-to asks "in disguise"** ("how do I paginate", "what limit does X accept") may be the load-bearing difference. Sonnet 4.6 reads error-body queries as "errors are how-tos that hit a wall," which puts them in dsc-endpoint-lookup's tractor beam.

## Disposition

No prose changes this iteration -- phase 1 is baseline-only.

Phase 2 candidates (filed for future iteration, not done here):

1. **Tighten dsc-triage's description** to lean harder on the diagnosis frame: lead with "you pasted a *failing* request" rather than "you have a request and an error body." Surface the runtime artifact (cURL + error body together) as the dispositive shape, not the spec-field intent.
2. **Tighten dsc-endpoint-lookup's decline list** to push back when the input includes an error body asking why it's failing -- "decline when the question is about why a specific request *is* failing (paste includes error body / status code / 'what's wrong' framing); that's dsc-triage."

Both tightenings together would over-correct; one alone is probably enough. dsc-endpoint-lookup-side tightening (option 2) may be the cleaner choice: dsc-endpoint-lookup is the receiving end of all four skills' drift, so anchoring its decline list pulls back the boundary symmetrically.

## Files in this iteration

- `evals/dsc-triage/runs/iteration-4-6-baseline/results.json` – probe-eval output (gitignored).
