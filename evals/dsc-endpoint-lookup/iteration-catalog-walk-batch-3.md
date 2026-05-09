# iteration-catalog-walk-batch-3

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 40/40 passed, runs=3, 25.5 min wall clock.

## Hypothesis

Five more catalog products walk end-to-end with the existing scraper and route
correctly through dsc-endpoint-lookup on Sonnet, with no skill or
description changes:

- **Tableau Next REST API** (`/docs/analytics/tableau-next-rest-api/
  references`, `referenceShape: area-landing`) – 6 refs, all `rest-oa3`
  (Downloads, Followers, Record Access Shares, Subscriptions,
  Visualizations, Workspaces).
- **Communications Cloud TM Forum API** (`/docs/industries/
  communications/references`) – 26 refs, all `rest-raml` (1 Release
  Notes + 25 TMF specs covering Product Catalog, Ordering, Customer
  Mgmt, Quotes, Agreements, etc.).
- **Subscription Management** (`/docs/revenue/subscription-management/
  references`) – 14 refs, all `rest-raml` (Assets, Billing, Buy Now,
  Credit, Invoices, Orders, Payments, Pricing, Products, Quotes,
  Taxes, etc.). Most endpoints route through `/composite`.
- **Einstein Bots API** (`/docs/service/einstein-bot-api/references`)
  – 2 refs: `bot-api-v5` (5 endpoints) `rest-oa3` + 1 `markdown` `about`
  wrapper.
- **Messaging for In-App and Web** (`/docs/service/messaging-api/
  references`) – 2 refs: `miaw-api-reference` (17 endpoints) `rest-oa3`
  + 1 `markdown` `about` wrapper.

These cover all five remaining walkable products in this batch. Two
small-surface 2-ref families (Einstein Bot, MIAW) plus three larger
ones (Tableau Next 6, Subscription Mgmt 14, Comms TM Forum 26).
All routed through existing format parsers (`rest-oa3`, `rest-raml`);
no scraper changes needed.

Same eval shape as prior catalog-walk iterations: one positive query
per family, all referencing real endpoints (postWorkspaceCollection,
Create a product offering, Create a quote, startSession,
createConversation). No existing-query regressions expected –
additive positives only.

## Setup

Cache-warmed all five families via `node skills/dsc-scrape/scripts/
scrape.js <url> --all` to confirm shape and build the on-disk cache:

| Reference | URL | Format | Slug count |
|---|---|---|---|
| Tableau Next `workspaces-operations` | `/docs/analytics/tableau-next-rest-api/references/workspaces-operations` | OAS 3 | 9 |
| Comms `tmf620` (Product Catalog Mgmt) | `/docs/industries/communications/references/tmf620` | RAML/AMF | 26 |
| Subscription Mgmt `quotes` | `/docs/revenue/subscription-management/references/quotes` | RAML/AMF | 3 |
| Einstein Bot `bot-api-v5` | `/docs/service/einstein-bot-api/references/bot-api-v5` | OAS 3 | 6 |
| MIAW `miaw-api-reference` | `/docs/service/messaging-api/references/miaw-api-reference` | OAS 3 | 18 |

Then added 5 positives to `evals/dsc-endpoint-lookup/trigger-eval.json`.
Total queries went from 35 to 40 (32 positive + 8 negative).

## Result

| Query | Triggers |
|---|---|
| Tableau Next workspaces-operations postWorkspaceCollection body | 3/3 |
| Comms TM Forum tmf620 Create a product offering body | 3/3 |
| Subscription Mgmt quotes Create a quote body | 3/3 |
| Einstein Bots API bot-api-v5 startSession body + headers | 3/3 |
| MIAW miaw-api-reference createConversation body | 3/3 |

No regressions on the 35-query baseline (SCAPI + Einstein + OCAPI +
Data 360 + MCG + B2B/D2C + MRT + Healthcare + Energy & Utilities + FSC
+ Loyalty): all still 3/3.

## Verdict

Hypothesis confirmed. All five families route correctly through dsc-
endpoint-lookup on Sonnet via the existing description. Zero skill or
description changes needed. Promotes Tableau Next REST API,
Communications Cloud TM Forum API, Subscription Management, Einstein
Bots API, and Messaging for In-App and Web to ✅ in the dsc-endpoint-
lookup column of the matrix.

## Caveats

- **Communications TM Forum has inbound + outbound variants as
  separate refs.** `tmf620` (inbound) and `tmf620out` (outbound) carry
  different specs; same for several other TMF families. Eval picks
  the inbound `tmf620`, but downstream skill prose may need to learn
  this pattern if a customer asks about outbound.
- **Subscription Management is composite-heavy.** Most endpoints route
  through `POST /composite` with a `compositeRequest` array; the body
  shape lives in description prose rather than a structured `body`
  field on each operation. Endpoint lookup answers will quote the
  prose but won't have a structured schema to extract from.
- **Subscription Management's `intro` and `products` refs are RAML
  modules with no operations.** The AMF parser correctly yields
  `endpoints: {}` for both (the upstream pages render zero operations
  too). Not a bug; ref ids `intro` and `products` are used for shared
  type libraries / overview material in this family.
- **Cache slug collisions.** SM uses ref ids `orders`, `payments`,
  `products` – same ids as SCAPI's commerce-api refs. The cache is
  keyed by ref id (no area prefix), so back-to-back scrapes overwrite
  `_index.json` / `Summary.json` while leaving stale per-endpoint
  files. Filed as a known gap in `docs/dsc-skills.md`. Doesn't block
  this eval (each scrape produces correct outputs at the time it
  runs), but worth fixing.
- **Einstein Bots is hosted off-platform.** Endpoints live under
  `runtime-api-na-west.prod.chatbots.sfdc.sh`, not the standard
  `*.salesforce.com` host pattern. Spec declares `chatbotAuth` scheme
  with `chatbot_api` scope, plus a `jwtBearer` alternative – making it
  one of the few new families with declared scopes. (Triage column is
  ❌, not N/A, because the surface IS scope-rich – just untested.)
- **MIAW endpoints are hosted under `{scrt-url}/iamessage/api/v2/...`.**
  Spec declares a `ScrtAuth` scheme but no spec-side scopes; auth
  tokens are minted via `generateAccessTokenForUnauthenticatedUser` /
  `generateAccessTokenForAuthenticatedUser`. Triage column is ❌
  rather than N/A because the auth-scheme questions remain answerable
  from the spec; just untested.

## Files in this iteration

- `evals/dsc-endpoint-lookup/trigger-eval.json` – 5 positives added.
- `runs/iteration-catalog-walk-batch-3/results.json` – probe-eval
  output (gitignored, regenerable).
- `skills/dsc-scrape/tests/fixtures/tableau-next-landing.html` – live
  HTML for Tableau Next area-landing.
- `skills/dsc-scrape/tests/fixtures/comms-tmforum-landing.html` – live
  HTML for Communications TM Forum area-landing.
- `skills/dsc-scrape/tests/fixtures/subscription-management-landing.html`
  – live HTML for Subscription Management area-landing.
- `skills/dsc-scrape/tests/fixtures/einstein-bot-landing.html` – live
  HTML for Einstein Bots API area-landing.
- `skills/dsc-scrape/tests/fixtures/messaging-miaw-landing.html` – live
  HTML for MIAW area-landing.
- `skills/dsc-scrape/tests/test-catalog.js` – 5 new test cases
  (catalog parser ok 16 fixtures total).
- `docs/dsc-skills.md` – matrix gains 5 rows; per-family detail prose
  picks up the new families. Known-gaps count drops from 8 to 3 of 20
  catalog products.
