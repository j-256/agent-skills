# iteration-industries-coverage

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 35/35 passed, runs=3, ~20.0 min wall clock.

## Hypothesis

Three more catalog products from the catalog-walk plan walk end-to-end with the existing scraper and route
correctly through dsc-endpoint-lookup on Sonnet, with no skill or
description changes:

- **Energy and Utilities Cloud Integrations API**
  (`/docs/industries/energy/references`, `referenceShape: area-landing`)
  – single ref `energyapi`, RAML/AMF, 34 slugs.
- **Financial Services Cloud Integrations** (`/docs/industries/fsc/
  references`, `referenceShape: area-landing`) – 11 refs, all `rest-raml`
  (Insurance, Mortgage, Wealth Management, etc.).
- **Loyalty Management Integrations** (`/docs/industries/loyalty/
  references`, `referenceShape: area-landing`) – 3 refs: 2 `rest-raml`
  + 1 `rest-oa3` (loyalty_retail_api, 14 slugs).

These are the rest-raml-heavy industries cluster, sister to the
Healthcare iteration (Healthcare's RAML/AMF parser path proved itself
2026-05-09 in `iteration-commerce-healthcare-coverage`). Loyalty also
exercises the mixed-format case: a single area-landing carrying both
RAML and OAS 3 refs, both routing through the right format parser.

Same eval shape as the prior commerce-healthcare iteration: one
positive query per family, all referencing real endpoints (Create an
account, Cancel Policy, createCustomer). No existing-query regressions
expected – additive positives only.

## Setup

Cache-warmed all three families to confirm shape + avoid cold-cache
timeouts:

| Reference | URL | Format | Slug count |
|---|---|---|---|
| Energy `energyapi` | `/docs/industries/energy/references/energyapi` | RAML/AMF | 34 |
| FSC `insurance` | `/docs/industries/fsc/references/insurance` | RAML/AMF | 3 |
| Loyalty `loyalty_retail_api` | `/docs/industries/loyalty/references/loyalty_retail_api` | OAS 3 | 14 |

Then added 3 positives to `evals/dsc-endpoint-lookup/trigger-eval.json`.
Total queries went from 32 to 35 (27 positive + 8 negative).

## Result

| Query | Triggers |
|---|---|
| Energy energyapi Create an account request body | 3/3 |
| FSC insurance Cancel Policy body + path | 3/3 |
| Loyalty loyalty_retail_api createCustomer request body | 3/3 |

No regressions on the 32-query baseline (SCAPI + Einstein + OCAPI +
Data 360 + MCG + B2B/D2C + MRT + Healthcare): all still 3/3.

## Verdict

Hypothesis confirmed. All three families route correctly through dsc-
endpoint-lookup on Sonnet via the existing description. Zero skill or
description changes needed. Promotes Energy and Utilities Cloud,
Financial Services Cloud Integrations, and Loyalty Management
Integrations to ✅ in the dsc-endpoint-lookup column of the matrix.

## Caveats

- **Energy is single-ref.** No Release Notes ref exists in this family
  – it's just the integrations API itself. Same shape as Data 360
  Connect (single-ref family, one URL to scrape).
- **FSC is broad but shallow.** 11 refs, but each is a small surface
  (Insurance is 3 endpoints; some refs are larger). The eval picks
  Insurance / Cancel Policy as a representative endpoint.
- **Loyalty's mixed format.** 2 refs route through the RAML/AMF parser
  and 1 through the OAS 3 parser. The eval query targets the OAS 3
  ref so the format-routing happens end-to-end. Independent confirmation
  that the mixed-area case works comes from the `parseCatalog` test
  asserting both 2 rest-raml + 1 rest-oa3 in the same fixture.
- **Spec-declared scopes are absent across the cluster.** Same as the
  prior B2B/D2C / Cart caveat – auth schemes are documented in prose
  on the developer.salesforce.com pages but not as structured `security`
  fields in the spec. Eval queries focus on body / path / shape, not
  auth.

## Files in this iteration

- `evals/dsc-endpoint-lookup/trigger-eval.json` – 3 positives added.
- `runs/iteration-industries-coverage/results.json` – probe-eval output
  (gitignored, regenerable).
- `skills/dsc-scrape/tests/fixtures/energy-utilities-landing.html` –
  live HTML for Energy & Utilities area-landing.
- `skills/dsc-scrape/tests/fixtures/fsc-landing.html` – live HTML for
  FSC area-landing.
- `skills/dsc-scrape/tests/fixtures/loyalty-landing.html` – live HTML
  for Loyalty area-landing.
- `skills/dsc-scrape/tests/test-catalog.js` – 3 new test cases
  (catalog parser ok 11 fixtures total).
- `docs/dsc-skills.md` – matrix gains 3 rows; per-family detail prose
  picks up the Energy single-ref shape, FSC's 11-ref breadth, and
  Loyalty's mixed-format case. Known-gaps count drops from 11 to 8.
