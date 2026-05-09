# iteration-ocapi-coverage

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 26/26 passed, runs=3, ~15 min wall clock.

## Hypothesis

OCAPI references reachable via `dsc-scrape`'s scraper layer (Swagger 2 / `rest-oa2`) route through `dsc-endpoint-lookup`'s synthesis layer cleanly on Sonnet – the existing description ("any DSC reference the scraper can deliver") is enough to fire on OCAPI-flavored queries without a description tweak.

The 2026-05-08 OCAPI scraper landing verified the data layer end-to-end: 82 of 84 refList entries scrape, parser tests + golden coverage on `ocapi-shop-products` and `ocapi-shop-baskets`. What was unverified was synthesis-layer triggering: whether Sonnet routes OCAPI queries (which name the family explicitly and use OCAPI-flavored operationIds like "Get multiple products" rather than verb-shaped slugs) to the right skill.

## Setup

Cache-warmed three OCAPI references that the queries reference, to avoid cold-cache timeouts during probe-eval:

| Reference | Slug count |
|---|---|
| ocapi-shop-products | 14 endpoints + 24 types |
| ocapi-shop-baskets | 36 endpoints + 31 types |
| ocapi-shop-customers | 47 endpoints + 28 types |

Then added 3 OCAPI positives to `evals/dsc-endpoint-lookup/trigger-eval.json`, mirroring the einstein iteration's pattern (1 body shape, 1 auth scheme, 1 code-gen with named endpoint):

1. ocapi-shop-baskets `Create basket` request body (direct lookup, with OCAPI->SCAPI migration framing)
2. ocapi-shop-products `Get multiple products` auth schemes (auth-scheme question)
3. ocapi-shop-customers `Get or refresh customer JWT` node fetch (code-gen with named endpoint)

The third query was reworded from the README's original "Login customer" (no such operation in `ocapi-shop-customers`; the actual op is "Get or refresh customer JWT" at `POST /customers/auth`).

## Result

| Query | Triggers |
|---|---|
| ocapi-shop-baskets Create basket request body | 3/3 |
| ocapi-shop-products Get multiple products auth schemes | 3/3 |
| ocapi-shop-customers Get or refresh customer JWT code-gen | 3/3 |

No regressions on the 23 SCAPI + Einstein baseline queries (still 23/23). The OCAPI conceptual negative ("difference between OCAPI and SCAPI") correctly produced text-only responses (no skill invocation).

## Verdict

Hypothesis confirmed. OCAPI references trigger `dsc-endpoint-lookup` correctly on Sonnet via the existing description. Zero skill or description changes needed. Promotes OCAPI from tier 2 (scraper-level only) to tier 1 (eval-harness validated) in `docs/dsc-skills.md`.

## Note on OCAPI operationId / slug mismatch

OCAPI's `operationId` is human prose (`"Get multiple products"`, `"Create basket"`, `"Get or refresh customer JWT"`), not the verb-shaped camelCase that SCAPI uses. The on-disk slug derives from method+path (`get-products-ids`, `post-baskets`, `post-customers-auth`). The `dsc-scrape` SKILL.md "OCAPI specifics" section already covers this; search by `endpoint.operationId` or method/path, not by slug, when an OCAPI question references a verb-shaped name.

The trigger eval doesn't depend on this resolving correctly at runtime – it only verifies routing – but it's worth noting that the synthesis-layer answer for these queries depends on `dsc-endpoint-lookup` reading `_index.json` and matching by `operationId`, not by slug. That path is exercised by the existing OCAPI parser tests but hasn't been exercised through an actual end-to-end synthesis run on this eval harness.

## Files in this iteration

- `evals/dsc-endpoint-lookup/trigger-eval.json` – the 3 OCAPI positives added in this iteration.
- `runs/iteration-ocapi-coverage/results.json` – probe-eval output (gitignored, regenerable).
