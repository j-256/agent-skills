# iteration-einstein-coverage

**Date:** 2026-05-07
**Model:** Sonnet 4.5
**Result:** 23/23 passed, runs=5, ~33 min wall clock.

## Hypothesis

The rest of the `einstein-api` product area on developer.salesforce.com
(siblings of `einstein-recommendations`) uses the same `reference-set-config`
refList mechanism, the same `rest-raml` referenceType, and the same
`api.cquotient.com/v3` runtime as Recommendations does. If true, the existing
`dsc-scrape` parser handles them with zero code changes, and the only
remaining question is whether `dsc-endpoint-lookup`'s synthesis layer
correctly routes Einstein-flavored queries to the skill on Sonnet.

## Setup

Catalog walk against `developer.salesforce.com/docs/commerce/einstein-api/references`
returned 4 refList entries, all `rest-raml`, all serving `api.cquotient.com/v3`:

| Reference | Slugs (parsed) |
|---|---|
| einstein-recommendations (control) | 27 |
| einstein-activities | 32 |
| einstein-profile-connector | 14 |
| einstein-gdpr | 8 |

All 4 parsed via `parse-amf.js` with no errors. No new code in the scraper.

Then added 3 Einstein positives to `evals/dsc-endpoint-lookup/trigger-eval.json`:

1. einstein-activities `sendViewProduct` request body (direct lookup)
2. einstein-recommendations `getRecommendations` curl (code-gen with named endpoint)
3. einstein-gdpr `sendGDPRDelete` auth scheme (auth-scheme question)

## Result

| Query | Triggers |
|---|---|
| einstein-activities sendViewProduct request body | 5/5 |
| einstein-recommendations getRecommendations curl | 5/5 |
| einstein-gdpr sendGDPRDelete auth scheme | 5/5 |

No regressions on the 20 SCAPI baseline queries (still 20/20).

## Verdict

Hypothesis confirmed. Einstein API is uniform within its product area, the
scraper handles all 4 references end-to-end, and `dsc-endpoint-lookup`'s
existing description ("any DSC reference the scraper can deliver") is enough
to route Einstein queries correctly on Sonnet without any description tweak.

Promotes Einstein API (cQuotient) from tier 2 (Einstein Recommendations only,
scraper-level) to tier 1 (full `einstein-api` product area, synthesis-layer
validated).

## Caveat

Query #2 ("write me a curl that hits getRecommendations ... what query params
do I need to pass") technically misframes the spec: `getRecommendations` is
POST `/personalization/recs/{siteId}/{recommenderName}` with two path params
and no query params. The skill at runtime would correctly answer "no query
params, here are the path params." This doesn't invalidate the trigger result
(routing fired correctly 5/5), but a future iteration tightening the eval set
should rephrase to something like "what params do I need to pass" or replace
with an endpoint that genuinely has query params.

## Files in this iteration

- `evals/dsc-endpoint-lookup/trigger-eval.json` – the 3 Einstein positives
  added in this iteration.
- `runs/iteration-einstein-coverage/results.json` – probe-eval output
  (gitignored, regenerable).
