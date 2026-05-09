# iteration-commerce-healthcare-coverage

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 32/32 passed, runs=3, ~19.8 min wall clock.

## Hypothesis

Three more catalog products from the catalog-walk plan walk end-to-end with the existing scraper and route correctly through
dsc-endpoint-lookup on Sonnet, with no skill or description changes:

- **B2B / D2C Commerce API** (`/docs/commerce/salesforce-commerce/references`,
  `referenceShape: area-landing`) – 10 refs, 9 `rest-oa3` + 1 `markdown` Apex
  wrapper. Cart API alone is 128 slugs.
- **Composable Storefront / MRT** (`/docs/commerce/pwa-kit-managed-runtime/references`,
  `referenceShape: area-landing`) – 3 refs, 2 `rest-oa3` (mrt-admin: 131
  slugs, mrt-b2c-config) + 1 `markdown` about-page.
- **Healthcare API** (`/docs/industries/health/references`,
  `referenceShape: area-landing`) – 10 refs, all `rest-raml`, all FHIR R4-
  shaped. Same RAML/AMF parser path as Einstein Recommendations.

Same eval shape as `iteration-data360-mcg-coverage`: one positive query per
family, all referencing real endpoints (postCartItemCollection,
organizations_certificates_create, "Create a care plan record"). No
existing-query regressions expected because these are additive positives,
not description changes.

## Setup

Cache-warmed all three families to confirm shape + avoid cold-cache
timeouts:

| Reference | URL | Format | Slug count |
|---|---|---|---|
| B2B/D2C `comm-cart-ref` | `/docs/commerce/salesforce-commerce/references/comm-cart-ref` | OAS 3 | 128 |
| Composable Storefront `mrt-admin` | `/docs/commerce/pwa-kit-managed-runtime/references/mrt-admin` | OAS 3 | 131 |
| Healthcare `care_management` | `/docs/industries/health/references/care_management` | RAML/AMF | 9 |

Then added 3 positives to `evals/dsc-endpoint-lookup/trigger-eval.json`.
Total queries went from 29 to 32 (24 positive + 8 negative).

## Result

| Query | Triggers |
|---|---|
| B2B/D2C comm-cart-ref postCartItemCollection request body | 3/3 |
| Composable Storefront mrt-admin organizations_certificates_create auth scheme | 3/3 |
| Healthcare care_management Create a care plan record request body | 3/3 |

No regressions on the 29-query baseline (SCAPI + Einstein + OCAPI + Data
360 + MCG): all still 3/3.

## Verdict

Hypothesis confirmed. All three families route correctly through dsc-
endpoint-lookup on Sonnet via the existing description. Zero skill or
description changes needed. Promotes B2B/D2C Commerce, Composable
Storefront (MRT), and Healthcare API to ✅ in the dsc-endpoint-lookup
column of the matrix in `docs/dsc-skills.md`.

## Caveats

- **Cart API has `security: []` per endpoint.** The OAS 3 spec doesn't
  declare top-level `securitySchemes`. Auth is OAuth 2 + Bearer per the
  Summary's prose. Same Data 360-shaped caveat: dsc-endpoint-lookup would
  truthfully report "no spec-declared scopes" if asked. Eval query for
  Cart asks about request body shape, sidestepping this.
- **MRT Admin has declared `security`** (Basic + BearerToken at the per-
  endpoint level). This is the only family in the batch where auth-scheme
  questions are genuinely answerable from the spec. The eval query for
  MRT exercises this.
- **Healthcare uses RAML/AMF**, the same parser path as Einstein
  Recommendations. Operation slugs are human-prose ("Create a care plan
  record.json") – the same pattern OCAPI and MCG carry. No parser
  changes needed; the existing slug-with-spaces handling cleared the
  Einstein iteration.
- **B2B/D2C operationIds** are camelCase (`postCartCollection`,
  `getCartItemCollection`) – the conventional OAS 3 shape. No surprises.

## Catalog walk – broader picture

This iteration covers 3 of the 17 untouched products from the catalog-walk plan.
The walk also confirmed:

**Walkable now (existing parsers handle them, batch in future iterations):**
Communications TMF, Einstein Bots, Energy & Utilities, FSC, Loyalty,
Messaging, Subscription Management, Tableau Next.

**Format outliers (defer to docs-scrape phase 2 or per-family parser):**
- Pub/Sub API – `reference-set-config` with `markdown`-only refs. Likely a
  gRPC / AsyncAPI surface that needs a different parser.
- Interaction Service API – `markdown`-only refList; same family.
- GraphQL API – singular `reference-config` + `rest-oa3`, but the spec
  describes a single GraphQL POST endpoint. Synthesis shape differs from
  REST.

**Genuinely empty:**
- Conversation Service API – `/references` URL 404s with full scraper
  headers + referer. Catalog scaffolds the product entry before docs are
  published. All four URLs (overview, guide, references, singular) 404.
  Re-walk after Salesforce publishes content.

A "404 without referer that succeeds with referer" gotcha was checked
during this walk: full scraper-style headers + `Referer:
https://developer.salesforce.com/docs/apis` were applied; Conversation
Service still 404s, so it is genuinely missing rather than a probe
artifact.

## Long-term: the catalog walk's tempo

The catalog-walk plan estimated half a session per ~5 products. This iteration walked
3 in less than half a session, all rest-oa3 / rest-raml. The
straightforward-format products are quick once the pattern is in muscle
memory: scrape → confirm slug → save fixture → add 1 trigger-eval positive
→ run probe-eval. The format outliers are where future sessions slow down,
because they need parser scoping rather than walks.

## Files in this iteration

- `evals/dsc-endpoint-lookup/trigger-eval.json` – 3 positives added.
- `runs/iteration-commerce-healthcare-coverage/results.json` – probe-eval
  output (gitignored, regenerable).
- `skills/dsc-scrape/tests/fixtures/b2b-d2c-commerce-landing.html` – live
  HTML for the B2B/D2C area-landing page.
- `skills/dsc-scrape/tests/fixtures/composable-storefront-landing.html` –
  live HTML for the Composable Storefront area-landing page.
- `skills/dsc-scrape/tests/fixtures/healthcare-landing.html` – live HTML
  for the Healthcare area-landing page.
- `skills/dsc-scrape/tests/test-catalog.js` – 3 new test cases asserting
  each fixture parses to the expected ref counts and types.
- `docs/dsc-skills.md` – matrix gains 3 rows; per-family detail prose
  picks up the Cart `security: []` caveat, the MRT auth-scheme observation,
  and the Healthcare FHIR R4 framing. Known-gaps count drops from 14 to 11
  and surfaces the format-outlier list for the future.
