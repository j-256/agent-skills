# iteration-ocapi-coverage

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 23/23 passed, runs=3, ~61 min wall clock (3666s).

## Hypothesis

OCAPI is reachable through dsc-scenario today via the shared scrape library – the data layer landed on 2026-05-08 and was eval-validated against dsc-endpoint-lookup at 26/26 on 2026-05-09. What was untested was whether dsc-scenario's synthesis path (graph walk → plan + cURL block) routes correctly on OCAPI-flavored queries on Sonnet.

This was expected to pass without skill or description changes – OCAPI's `shop-baskets` has the same basket-ID / line-item-ID threading SCAPI does, scenario's resolver matches by method+path (which works the same for OCAPI as for SCAPI), and the existing description ("Build a multi-call repro plan against a Salesforce API reference published on developer.salesforce.com") doesn't lock the skill to SCAPI.

## Setup

Cache-warmed three OCAPI references the queries reference:

| Reference | URL | Slug count |
|---|---|---|
| ocapi-shop-baskets | `/docs/commerce/b2c-commerce/references/ocapi-shop-baskets` | 36 |
| ocapi-shop-orders | `/docs/commerce/b2c-commerce/references/ocapi-shop-orders` | 12 |
| ocapi-shop-customers | `/docs/commerce/b2c-commerce/references/ocapi-shop-customers` | 47 |

Then added 3 OCAPI positives to `evals/dsc-scenario/trigger-eval.json` (now 13 positives + 10 negatives = 23 entries):

1. Prereqs question for OCAPI shop-orders `Submit basket` (POST /orders) with explicit basket → order chain framing.
2. cURL-based scenario hitting OCAPI shop-baskets `POST /baskets/{basket_id}/coupons`, asking what else is needed end-to-end.
3. Multi-step customer-flow scenario: registered shopper logs in via OCAPI customer-auth, adds a product, applies a coupon, checks out.

## Result

| Query | Triggers |
|---|---|
| OCAPI shop-orders `Submit basket` prereqs | 3/3 |
| OCAPI shop-baskets coupons cURL scenario | 3/3 |
| OCAPI customer-flow scenario | 3/3 |

10 SCAPI/SLAS positives at 3/3. 10 negatives at 0/3 (one OCAPI conceptual negative correctly declined). Zero TIMEOUTs across all 69 runs.

## Verdict

Hypothesis confirmed. OCAPI references trigger dsc-scenario correctly on Sonnet via the existing description; zero skill or description changes needed. Promotes OCAPI on the dsc-scenario column from `❌ (decline-only)` to `✅` in `docs/dsc-skills.md`.

## Caveats

- **OCAPI operationIds are human prose** (`"Submit basket"`, `"Update basket with coupon"`, `"Get or refresh customer JWT (JSON Web Token)"`). The on-disk slugs derive from method+path (`post-orders`, `post-baskets-basket_id-coupons`, `post-customers-auth`). Scenario's `resolve-slug.js` matches by method + path regex, not by operationId, so this is transparent to the resolver – queries can name endpoints by either form.
- **OCAPI's `body` schema in the parsed envelope uses `schemaRef`** (`#/components/schemas/<name>`), unlike OAS 3 which inlines `schema`. Scenario's `walk-types.js` reads `ep.body.schema` directly; for OCAPI that's `null`, so the body's required-fields contribution to the type graph is empty. Body fields aren't load-bearing for the basket → order chain (which threads through `basket_id`, a path param), but it's worth noting that OCAPI scenario plans will under-link body-derived prerequisites compared to SCAPI. This is a runtime-composition issue downstream of triggering and would only matter for scenarios where a body field, not a path param, is the chained value. Not in scope for this iteration.
- **First eval run hit a 240s per-run timeout under heavy ambient model load** – multiple OCAPI positives returned 0/3 purely from TIMEOUT, not routing misses. Re-running at `--timeout 600` resolved every TIMEOUT-driven failure. Future iterations should consider 600s the default given the long-cURL/long-prompt pattern in scenario queries.

## Files in this iteration

- `evals/dsc-scenario/trigger-eval.json` – 3 OCAPI positives added.
- `runs/iteration-ocapi-coverage/results.json` – probe-eval output (gitignored, regenerable).
