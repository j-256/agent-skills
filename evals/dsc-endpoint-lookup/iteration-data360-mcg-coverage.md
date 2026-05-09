# iteration-data360-mcg-coverage

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 29/29 passed, runs=3, ~16.9 min wall clock.

## Hypothesis

Data 360 Connect REST API and Marketing Cloud Growth – the two families an earlier reference-coverage analysis flagged as the "atlas-style" tier-3 gap – are NOT actually atlas-style. Live walk on 2026-05-09 (this iteration) found:

- Data 360 Connect lives at `/docs/data/connectapi/references/spec` with a singular `reference-config` attribute pointing at `/static/datacloud/connectapi/spec/cdp-connect-api-Swagger.yaml` (despite the filename, it's OAS 3 – `referenceType: "rest-oa3"`). Listed in `/docs/apis` as `Data 360 Connect REST API`, `referenceShape: area-landing`.
- Marketing Cloud Growth lives at `/docs/marketing/marketing-cloud-growth/references` with `reference-set-config` and 10 refs (8 `rest-oa3` + 2 `markdown` skipped, same mechanism as OCAPI). NOT in `/docs/apis` catalog, which matches the dsc-scrape SKILL.md note about MCG / Agentforce being catalog-missing but reachable by direct URL.

Both already scrape end-to-end with the existing OAS 3 parser – zero scraper code changes needed. The hypothesis tested here is whether the existing dsc-endpoint-lookup description ("any DSC reference the scraper can deliver") is enough to trigger correctly on Data 360 and MCG queries on Sonnet.

## Setup

Cache-warmed both families to confirm shape and avoid cold-cache timeouts:

| Reference | URL | Slug count |
|---|---|---|
| Data 360 Connect | `/docs/data/connectapi/references/spec` | 1008 |
| MCG `mc-rest-briefs` | `/docs/marketing/marketing-cloud-growth/references/mc-rest-briefs` | 12 |
| MCG landing | `/docs/marketing/marketing-cloud-growth/references` | 10 refs (8 rest-oa3 + 2 markdown) |

Then added 3 positives to `evals/dsc-endpoint-lookup/trigger-eval.json`, mirroring the OCAPI / Einstein iteration patterns:

1. Data 360 `POST /ssot/activation-targets` request body (direct lookup).
2. Data 360 GET activation target by id – response schema (with the "Data 360 (formerly Data Cloud)" framing the user might use).
3. MCG `Create a Brief` curl code-gen.

## Result

| Query | Triggers |
|---|---|
| Data 360 POST /ssot/activation-targets request body | 3/3 |
| Data 360 (formerly Data Cloud) GET activation target response schema | 3/3 |
| MCG Create a Brief curl code-gen | 3/3 |

No regressions on the 26-query SCAPI + Einstein + OCAPI baseline (still 26/26).

## Verdict

Hypothesis confirmed. Both Data 360 Connect and Marketing Cloud Growth route correctly through dsc-endpoint-lookup on Sonnet via the existing description. Zero skill or description changes needed. Promotes both families from tier 3 (the prior reference-coverage analysis had them as the remaining gap) to tier 1 (eval-harness validated) in `docs/dsc-skills.md`.

The "atlas-style" branch from the prior reference-coverage analysis is closed without ever needing an atlas parser; the analysis was wrong about the URL shape. The "Suggested first steps" section's instruction to walk the atlas path live was the right move – it's what surfaced the misframing.

## Caveats

- Data 360 Connect's spec doesn't declare endpoint-level `security` or top-level `securitySchemes` (the API is auth'd via OAuth + Connect REST per the Summary's prose, but the YAML doesn't carry it as a structured field). Asking dsc-endpoint-lookup "what scopes does X need" for Data 360 would correctly trigger but truthfully report no spec-declared scopes. Eval queries here avoided that field for clarity.
- MCG endpoints have spec-level `operationId` strings with spaces (`"Create a Brief"`). Slugs on disk match (`/Create a Brief.json`); endpoint references work either way. Same pattern as OCAPI's human-prose operationIds.
- The earlier reference-coverage analysis assumed atlas-style URLs and HTML-prose-only specs. Live walk overturned both assumptions; this iteration's findings reflect what's actually true.

## Long-term: catalog-driven discovery vs. alias map

An earlier proposal suggested a `slug-aliases.js` synonym map (e.g. "Data Cloud" → `data/connectapi`). This iteration declines that approach for two reasons:

1. The map will go stale fast. Salesforce rebrands on a multi-year cadence; the map needs maintenance every time, with no automatic drift signal.
2. `/docs/apis` is Salesforce's machine-readable product list with `title` + `body` + `referenceUrl` per product. When a user says "Data Cloud," the synthesis skill's discovery cascade should fuzzy-match against catalog `title` and `body` – Salesforce updates the catalog when they rebrand, so the matching surface stays current automatically. dsc-scrape SKILL.md already directs Sonnet to "match on topic keywords" against catalog titles.

A tiny alias map (3-5 entries) might still be worth it for catalog-missing products (MCG, Agentforce). That's a follow-on if user queries surface a real gap; not in this iteration's scope.

## Files in this iteration

- `evals/dsc-endpoint-lookup/trigger-eval.json` – 3 Data 360 + MCG positives added in this iteration.
- `runs/iteration-data360-mcg-coverage/results.json` – probe-eval output (gitignored, regenerable).
- `skills/dsc-scrape/tests/fixtures/marketing-cloud-growth-landing.html` – new fixture proving the catalog parser handles MCG end-to-end.
- `skills/dsc-scrape/tests/test-catalog.js` – test case asserting MCG fixture parses to 8 rest-oa3 + 2 markdown refs.
