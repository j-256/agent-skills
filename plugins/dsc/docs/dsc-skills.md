# DSC skills — architecture and design rationale

**Audience:** contributors extending the family. If you're looking for "which skill fires on my ask?" that lives in the [plugin README](../README.md#skills).

This doc explains the layering, why the boundaries are where they are, and what to keep in mind when extending or renaming skills in the family.

## Layers

The three `dsc-*` skills are **peer Skills sharing a scrape library.** All three build on `shared/scrape/` (URL classifier, format parsers, fetch + cache layer); none of them depends on another `dsc-*` skill at runtime. They share an on-disk cache (`~/.cache/dsc-scrape/`) so warming it from one skill benefits the others.

```
            ┌───────────────────────────────────────────┐
            │  shared/scrape/  (library)                │
            │  • Fetches DSC spec files                 │
            │    (OpenAPI 3, RAML/AMF, Swagger 2,       │
            │     ReDoc)                                │
            │  • Parses + writes per-slug JSON          │
            │  • Owns network I/O and 6-hour TTL        │
            │  • Produces structured JSON, no prose     │
            │  Runtime path: ../../shared/scrape/       │
            └─────────────────────┬─────────────────────┘
                                  │
               ┌──────────────────┼─────────────────────┐
               ▼                  ▼                     ▼
        ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
        │  dsc-scrape  │  │ dsc-endpoint-    │  │ dsc-scenario │
        │  (raw-dump)  │  │ help             │  │ (walk-graph) │
        │              │  │ (extract-one /   │  │              │
        │  Thin Skill  │  │  compare-two)    │  │  Walks the   │
        │  wrapper:    │  │                  │  │  type graph  │
        │  user asks   │  │  Reads ONE JSON, │  │  from a      │
        │  "scrape X", │  │  pulls ONE field │  │  target op,  │
        │  scrape and  │  │  OR diffs a      │  │  recursing   │
        │  return JSON │  │  failing request │  │  through     │
        │  on disk.    │  │  vs. the spec.   │  │  prereq ops. │
        │              │  │  Runtime branch  │  │  Composes    │
        │  1 URL in,   │  │  on input shape. │  │  plan +      │
        │  N JSON      │  │                  │  │  cURL.       │
        │  files out.  │  │  1 endpoint in,  │  │              │
        │              │  │  1 answer out;   │  │  N eps in,   │
        │              │  │  OR 1 req +      │  │  1 plan out. │
        │              │  │  1 err in,       │  │              │
        │              │  │  1 diag out.     │  │              │
        └──────────────┘  └──────────────────┘  └──────────────┘
```

## What each skill does

### dsc-scrape — raw-dump for direct user invocation

When the user explicitly asks to scrape, fetch, or mirror a DSC reference, this is the skill that fires. Thin wrapper around the shared scrape library: fetches a Salesforce API reference on developer.salesforce.com (`developer.salesforce.com/docs/.../references/<ref>`), parses it, and writes per-slug JSON under `~/.cache/dsc-scrape/<ref>/`. Returns the file list to the user.

**Produces:** `_index.json` (slug list + title + siblings), `Summary.json` (overview prose), `<operationId>.json` (one per endpoint), `types/<TypeName>.json` (one per named type).

**Used by:** humans who want the raw JSON dump (CI, ad-hoc inspection, populating the cache for later sessions).

The synthesis skills (`dsc-endpoint-help`, `dsc-scenario`) **don't invoke `dsc-scrape`** – they call the shared library directly via `../../shared/common/scrape-refresh.js`. The on-disk cache layout is shared, so warming the cache from any of the three skills benefits the others, but at the runtime layer they're independent peers, not consumers.

### dsc-endpoint-help – extract-one / compare-two

Two output modes selected by a runtime branch on the prompt's input shape:

**Spec-field lookup (extract-one).** Reads one endpoint JSON, pulls one specific field (scopes, params, body, response schema, auth scheme, method/path), and formats it as prose with the public DSC URL as the citation. Declines when the ask isn't a spec-field question (code generation, how-to, concept comparison).

- **Shape:** 1 endpoint in → 1 answer out. Bounded work; fits in one short response.
- **Example ask:** "what scopes does shopper-products getProducts need?"

**Failing-request diagnosis (compare-two).** Takes a failing Salesforce API request (cURL, raw HTTP, or `{method, url}`) plus the error response and diffs:
- Required scopes (from the spec) vs. provided scopes (decoded from the JWT, or from a registered client list the user supplies).
- Required request shape (from the spec) vs. actual request shape.

Returns a structured diagnosis: one of a small set of error classes (missing scope, invalid client, malformed body, …) or `UNKNOWN` if the spec can't explain the failure. Hands off honestly for 5xx, 404 resource-missing, 409 conflicts – those aren't spec-explainable.

- **Shape:** 1 failing request + 1 error in → 1 diagnosis out. A diff, not a lookup.
- **Example ask:** "why is this request failing – `insufficient_scope`, but I thought my client had everything?"

`dsc-endpoint-help` is the merged successor to what were two separate skills (`dsc-endpoint-lookup` and `dsc-triage`), unified per the 2026-05-23 cutover (see `evals/dsc-endpoint-help/iteration-merge-baseline.md`). The two output shapes share the same cache-resolution and citation rules; the merge eliminated cross-skill routing decisions Sonnet was losing in trigger-eval.

### dsc-scenario – walk-graph

Given a target operation (or a natural-language goal that resolves to one), walks the type graph to find prerequisite operations – ops whose responses produce fields the target needs as inputs. Recurses until it hits primitives or auth material. Composes a linear plan with scope union across all steps, ID threading (e.g. basket IDs flow into line-item paths), and emits a runnable cURL block with per-step placeholders.

**Shape:** N endpoints in → 1 plan out. Graph traversal, not field extraction.

**Example ask:** "what do I need to call before createOrder so it'll succeed?"

## Why this split and not one big skill?

The synthesis work splits along two axes – `dsc-endpoint-help` covers the single-endpoint axis (with a runtime branch between two endpoint-scoped output modes); `dsc-scenario` covers the multi-endpoint axis (graph traversal across prerequisite ops):

| Dimension | endpoint-help (lookup mode) | endpoint-help (diagnosis mode) | scenario |
|---|---|---|---|
| **Inputs** | 1 endpoint name | 1 request + 1 error | 1 target + N prerequisites |
| **Cache reads** | 1 file | 1-3 files | tens of files (graph walk) |
| **Synthesis** | none – quote the spec field | diff observed vs. expected | scope union, ID threading, business-logic ordering |
| **Output shape** | prose + `Source:` URL | templated diagnosis with error class, diff blocks, sources | templated plan + bash block + sources |
| **User intent** | "what does X require" | "why is X failing" | "how do I reach X" |

The lookup and diagnosis modes share the cache-resolution path and citation rules and both consume *one named endpoint*; merging them removed routing decisions Sonnet was losing under co-existence (see `evals/dsc-endpoint-help/iteration-merge-baseline.md`). Collapsing `dsc-scenario` in too would mean one `SKILL.md` trying to describe both single-endpoint and multi-endpoint jobs, with distinct output templates and decline boundaries that aren't naturally distinguishable from input shape alone – that's the kind of cross-shape conflation the original three-skill split avoided, and the merge preserves.

Sharing the scrape library (`shared/scrape/`) **is** the right factoring. Sharing the multi-endpoint synthesis layer with the single-endpoint synthesis layer is not.

## Discovery cascade

Synthesis skills (`dsc-endpoint-help`, `dsc-scenario`) resolve a reference name to a concrete URL through a cascade backed by the shared scrape library:

1. `/docs/apis` (top-level catalog) → `_catalog.json` listing every product DSC publishes, with each product's `referenceUrl` and a `referenceShape` tag.
2. **Catalog-missing alias map** (`shared/scrape/aliases.js`) → for products that publish `/references/` pages but don't appear in `_catalog.json` (today: Marketing Cloud Growth, Agentforce). Lowercase the user's hint and substring-match against keys.
3. `/docs/<product>/<area>/references` (product-area landing) → `_landing/<product>_<area>.json` listing every reference in the area with its `id`, `title`, and `referenceType`.
4. `.../references/<name>` (reference root) → per-slug JSON (`Summary.json`, `<operationId>.json`, `types/<TypeName>.json`, plus `_index.json`).

A model's training-data memory of "which endpoint exists in which Salesforce reference" is unreliable, and DSC URL shapes drift (Data Cloud → Data 360 is the canonical example). The cascade is the structured-source-of-truth alternative to guessing. The "All DSC fetches go through the shared scrape library" invariant – repeated in every synthesis SKILL.md – means there's no escape hatch to `curl` or `WebFetch` for a quick verification; if a name doesn't resolve, the cascade is the answer.

All cascade-fetched URL shapes share the 6-hour TTL with reference scrapes, so once the cascade is warmed in a session, follow-on discovery is free. (The alias map is a static data file – no fetch, no TTL.)

For the full surface of URL shapes the scraper accepts, see `skills/dsc-scrape/SKILL.md`'s "URL shapes" table (the same library backs both the dsc-scrape Skill and the synthesis skills). The synthesis-side flow lives in `skills/dsc-endpoint-help/SKILL.md` Step 1, which mandates the cascade as the default discovery path; `dsc-scenario` invariants point at the same cascade.

## Scope and coverage

The scraper isn't hard-coded to any one Salesforce product area – it handles any DSC reference that resolves to a supported machine-readable spec file. Today that's:

- **OpenAPI 3 (YAML)** — covers SCAPI and other modern references.
- **RAML via AMF JSON** — covers Einstein Recommendations and other RAML-backed families.
- **Swagger 2 (JSON or YAML)** — covers OCAPI (B2C Commerce legacy) and any other Swagger-2-backed reference.
- **ReDoc** — additional OpenAPI-3 surface.

Nothing in the synthesis layers is product-specific; extending to a new DSC family is primarily a scraper concern (URL shape, catalog mechanism, spec format).

### Coverage matrix

A previous version of this doc split coverage into three tiers (eval-validated / scraper-only / unsupported). Four families moved through the middle tier in 2026-05; each was promoted to eval-validated in the same session it was added, with no skill changes and no eval surprises. The intermediate tier turned out to be a holding pen rather than a meaningful capability state, so this section replaces the tier ladder with a per-skill matrix. The matrix expresses the actual interesting axis: a family can be eval-validated against one synthesis skill but not another.

`dsc-scrape` is the data layer – every family the scraper handles is verified by the scraper's own test suite (`skills/dsc-scrape/tests/`); the `dsc-scrape` column tracks whether the family is exercised through the scraper's *own* trigger-eval. The two synthesis-skill columns track whether each skill's trigger-eval has positive queries naming the family. The `dsc-endpoint-help` column merges what were `dsc-endpoint-lookup` and `dsc-triage` columns prior to the 2026-05-23 cutover; a row is ✅ if either predecessor's coverage was ✅ on that family.

| Family | dsc-scrape | dsc-endpoint-help | dsc-scenario |
|---|---|---|---|
| SCAPI | ✅ | ✅ | ✅ |
| SLAS | ✅ | ✅ | ✅ |
| Einstein API (cQuotient) | ✅ | ✅ | N/A (independent calls) |
| OCAPI | ✅ | ✅ | ✅ |
| Data 360 Connect REST API | ❓ | ✅ | ❓ |
| Marketing Cloud Growth | ❓ | ✅ | ❓ |
| Agentforce | ✅ | ❓ | ❓ |
| B2B / D2C Commerce | ❓ | ✅ | ❓ |
| Composable Storefront (MRT) | ❓ | ✅ | ❓ |
| Healthcare API | ❓ | ✅ | ❓ |
| Energy and Utilities Cloud | ❓ | ✅ | ❓ |
| Financial Services Cloud | ❓ | ✅ | ❓ |
| Loyalty Management | ❓ | ✅ | ❓ |
| Tableau Next REST API | ❓ | ✅ | ❓ |
| Communications Cloud TM Forum | ❓ | ✅ | ❓ |
| Subscription Management | ❓ | ✅ | ❓ |
| Einstein Bots API | ❓ | ✅ | N/A (independent calls) |
| Messaging for In-App and Web | ❓ | ✅ | ❓ |

Legend: ✅ = trigger-eval has positive queries naming the family and they pass on Sonnet 4.5. ❓ = no trigger-eval positive query yet – the family has been verified at the data layer (parser tests, scrape output) and the skill's shape is plausible based on the spec surface, but no fixture has been authored to confirm end-to-end behavior; a follow-up iteration will attempt at least one query per `❓` family and either promote to ✅ or demote to N/A with rationale. N/A = the synthesis skill's shape demonstrably doesn't apply to this family (independent calls with no cross-operation dependencies, like Einstein API and Einstein Bots) – an honest "skill doesn't apply" rather than a forced positive. ❌ would mean a fixture was authored and the layer regressed on it; the matrix has none today. "decline-only" appeared in earlier versions of this matrix to mean "covered by a negative-routing query"; OCAPI moved out of that state in the iteration below.

Per-family detail (citations to iteration notes for the curious; iteration .md files prefixed `dsc-endpoint-lookup/` or `dsc-triage/` lived in the predecessor eval dirs that the 2026-05-23 cutover retired – `git log -- evals/dsc-endpoint-lookup/` and `git log -- evals/dsc-triage/` recover them; per-family results carried into the merged `dsc-endpoint-help`):

- **SCAPI** – dsc-endpoint-help has 10 SCAPI positives; dsc-scenario trigger-eval is SCAPI-heavy and passes under Sonnet 4.5 (10 positives + supporting negatives, see the OCAPI iteration notes for the post-OCAPI totals); the predecessor dsc-triage trigger-eval was likewise SCAPI-heavy. dsc-scrape's `iteration-baseline.md` has 2 SCAPI positives.
- **SLAS** – appears as positives across all skill trigger-evals (pre- and post-cutover); invoked correctly.
- **Einstein API (cQuotient)** – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-einstein-coverage.md`), 23/23 under Sonnet 4.5; coverage spans all 4 references in the `einstein-api` product area (`einstein-activities`, `einstein-profile-connector`, `einstein-recommendations`, `einstein-gdpr`).
- **OCAPI** (Swagger 2 via `rest-oa2`, exposed under `b2c-commerce/references/b2c-commerce-ocapi`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-ocapi-coverage.md`), 26/26 under Sonnet 4.5. 82 of 84 refList entries scrape; the 2 `markdown` wrapper entries skip cleanly. Parser tests + golden-output tests cover `ocapi-shop-products` and `ocapi-shop-baskets`. dsc-scenario `iteration-ocapi-coverage.md`, 23/23 under Sonnet 4.5 – 3 OCAPI positives covering `Submit basket` prereqs, a coupons-cURL scenario, and a registered-shopper customer flow. Predecessor `dsc-triage/iteration-ocapi-coverage.md`, 23/23 under Sonnet 4.5 – 3 OCAPI positives covering `InvalidClientIdException`, `AuthenticationFailedException`, and `MissingRequiredPropertyException`. The triage classifier was extended in the same iteration to inspect `body.fault.{type, message}`; OCAPI's `{"fault":{...}}` envelope previously fell through to `UNKNOWN`.
- **Data 360 Connect REST API** (OAS 3 via `rest-oa3` at `/docs/data/connectapi/references/spec`, listed in `/docs/apis` as area-landing) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-data360-mcg-coverage.md`), 29/29 under Sonnet 4.5. Single-reference family with 1008 slugs; uses singular `reference-config` (ReDoc-style) attribute. Spec-declared scopes are absent; auth is OAuth + Connect REST per the Summary prose.
- **Marketing Cloud Growth** (OAS 3 via `rest-oa3` at `/docs/marketing/marketing-cloud-growth/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-data360-mcg-coverage.md`). Catalog-missing (not in `/docs/apis`) but reachable by direct URL through the catalog-missing alias map (`shared/scrape/aliases.js`). 8 `rest-oa3` + 2 `markdown` skipped; parser tests cover the landing fixture. Endpoint operationIds carry spaces.
- **Agentforce** (mixed `rest-oa3` + `markdown` at `/docs/ai/agentforce/references`) – dsc-scrape `iteration-baseline.md` covers the trigger ("discover what's under Agentforce on developer.salesforce.com – list the references"). Like MCG, catalog-missing but reachable through the alias map. Live-walked 2026-05-09 in predecessor `dsc-endpoint-lookup/iteration-alias-map.md`; 3 `rest-oa3` (notably `agent-api`, 83 slugs) + 7 `markdown` skipped. No dsc-endpoint-help positive yet – adding one is a follow-up; the alias path is wired regardless.
- **B2B / D2C Commerce** (multi-ref OAS 3 via `rest-oa3` at `/docs/commerce/salesforce-commerce/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-commerce-healthcare-coverage.md`). 10 refs: 9 `rest-oa3` (Cart, Payments, Quotes, Analytics, etc.) + 1 `markdown` Apex wrapper that skips cleanly. Cart API alone is 128 slugs. Spec-declared scopes are absent (`security: []`); same Data 360-style caveat applies if a customer asks "what scopes does X need."
- **Composable Storefront (MRT)** (multi-ref OAS 3 via `rest-oa3` at `/docs/commerce/pwa-kit-managed-runtime/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-commerce-healthcare-coverage.md`). 3 refs: `mrt-admin` (131 slugs), `mrt-b2c-config`, and an `about` markdown wrapper. MRT is the only family in this batch with declared `security` (Basic + BearerToken at the per-endpoint level), making auth-scheme questions answerable from the spec.
- **Healthcare API** (multi-ref RAML/AMF via `rest-raml` at `/docs/industries/health/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-commerce-healthcare-coverage.md`). 10 refs, all `rest-raml`, all FHIR R4-shaped (CarePlan, Bundle, Medication, etc.). Same RAML/AMF parser path as Einstein Recommendations; zero scraper changes needed. Operation slugs are human-prose (`Create a care plan record.json`), the same shape OCAPI and MCG carry.
- **Energy and Utilities Cloud** (single-ref RAML/AMF via `rest-raml` at `/docs/industries/energy/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-industries-coverage.md`). Single ref `energyapi` with 34 slugs. No Release Notes ref – the family ships only the integrations API itself. Spec-declared scopes are absent; same caveat as the rest of the industries cluster.
- **Financial Services Cloud Integrations** (multi-ref RAML/AMF via `rest-raml` at `/docs/industries/fsc/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-industries-coverage.md`). 11 refs, all `rest-raml` (Insurance, Mortgage, Credit Cards, Wealth Management, Customers, etc.). Each ref is a small surface (Insurance is 3 endpoints; some refs are tens of endpoints).
- **Loyalty Management Integrations** (mixed `rest-raml` + `rest-oa3` at `/docs/industries/loyalty/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-industries-coverage.md`). 3 refs: 2 `rest-raml` (GDS Profile Sync, Retail/Restaurant POS) and 1 `rest-oa3` (Retail Cloud API, 14 slugs). Loyalty is the only walked family in the industries cluster that mixes formats; both branches scrape with their existing parsers.
- **Tableau Next REST API** (multi-ref OAS 3 via `rest-oa3` at `/docs/analytics/tableau-next-rest-api/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-catalog-walk-batch-3.md`). 6 refs, all `rest-oa3` (Downloads, Followers, Record Access Shares, Subscriptions, Visualizations, Workspaces). Endpoints are scoped under `/tableau/...` on the standard `{MyDomainName}.my.salesforce.com/services/data/v64.0` base. Spec-declared `security: []`; auth handled at the platform layer.
- **Communications Cloud TM Forum API** (multi-ref RAML/AMF via `rest-raml` at `/docs/industries/communications/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-catalog-walk-batch-3.md`). 26 refs: 1 Release Notes + 25 TMF specs (TMF620 Product Catalog, TMF622 Product Ordering, TMF629 Customer Mgmt, TMF648 Customer Quote, TMF651 Agreement, etc.). Inbound + outbound variants are separate refs (`tmf620` vs. `tmf620out`). Operation slugs are human-prose (`Create a product offering.json`).
- **Subscription Management** (multi-ref RAML/AMF via `rest-raml` at `/docs/revenue/subscription-management/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-catalog-walk-batch-3.md`). 14 refs (intro + 13 functional refs: Assets, Billing, Buy Now, Credit, Invoices, Orders, Payments, Pricing, Products, Quotes, Taxes, etc.). Most endpoints route through Salesforce's `/composite` resource (synchronous composite-request flows for create/update). Operation slugs are human-prose.
- **Einstein Bots API** (mixed `markdown` + `rest-oa3` at `/docs/service/einstein-bot-api/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-catalog-walk-batch-3.md`). 2 refs: `bot-api-v5` (5 endpoints: startSession, continueSession, endSession, getAPIVersions, checkHealthStatus) + an `about` markdown wrapper that skips cleanly. Endpoints declare `chatbotAuth` scheme with `chatbot_api` scope and a `jwtBearer` alternative; require `X-Org-Id` header. Hosted under `runtime-api-na-west.prod.chatbots.sfdc.sh`, not `*.salesforce.com`.
- **Messaging for In-App and Web** (mixed `rest-oa3` + `markdown` at `/docs/service/messaging-api/references`) – dsc-endpoint-help (predecessor `dsc-endpoint-lookup/iteration-catalog-walk-batch-3.md`). 2 refs: `miaw-api-reference` (MIAW; 17 endpoints covering conversation/session/messaging lifecycle) + an `about` markdown wrapper. Hosted under `{scrt-url}/iamessage/api/v2/...`. Spec declares a `ScrtAuth` scheme but no spec-side scopes – auth tokens are minted via the unauthenticated/authenticated `generateAccessToken*` endpoints.

### Known gaps

- **Marketing Cloud Einstein Content Selection** and other adjacent Einstein-branded products that aren't part of the `einstein-api` product area. Different reference surfaces (`referenceShape: static-html`, atlas-style); not addressed by the einstein-api coverage above. No live walk attempted yet.
- **A handful of catalog products beyond what's listed above.** `/docs/apis` lists 20 products; this matrix covers 17 of them end-to-end. The remaining few are deferred for known reasons (format outliers below) or genuinely catalog-scaffolded-but-not-published (Conversation Service API). If a user query surfaces one, walk it live first; the OCAPI / Data 360 lessons apply.
- **Format outliers surfaced during the 2026-05-09 catalog walk.** Pub/Sub API (`reference-set-config` with `markdown`-only refs – likely a gRPC / AsyncAPI surface that needs a different parser), Interaction Service API (same – `markdown`-only refList), GraphQL API (singular `reference-config` + `rest-oa3`, but the spec describes a single GraphQL POST endpoint, so its synthesis shape differs from REST). These belong in `dsc-docs-scrape` phase 2 or in a future per-family parser, not in this matrix until a parser path lands. Conversation Service API is in the catalog but its `/references` URL genuinely 404s (catalog scaffolds the product before docs are published).
## Extending the family

### Adding support for a new DSC reference family

Most of the work is in the shared scrape library, not the synthesis skills. In rough order:

1. Find a representative reference URL and check what the page hands out – spec file format, catalog mechanism (`reference-set-config` attribute, refList location).
2. Add URL-shape detection in `shared/scrape/classify.js` if the URL doesn't match an existing shape.
3. If the format is unsupported, add a parser under `shared/scrape/parse-*.js`.
4. Wire it into `handleReference` in `shared/scrape/scrape.js`.
5. Add fixtures + tests under `skills/dsc-scrape/tests/` (that's where the library's tests live – dsc-scrape is the test-owning peer).
6. Add positive trigger-eval queries for the new family to *at least one* synthesis skill's `evals/<skill>/trigger-eval.json`, run `stream-eval trigger`, and write an `iteration-<name>.md` notes file with the result. Same commit as the scraper change.

**Policy: scraper changes and synthesis trigger-evals land together.** Never ship a scraper-only PR that leaves a family in "scraper works but no eval validates the synthesis path." Prior versions of this doc carried a "tier 2" state for that, but every family that landed in it was promoted to full eval coverage same-session anyway, so the intermediate state was holding-pen, not capability gradient. The eval is cheap (~15 min Sonnet probe) and catches synthesis-layer issues the scraper tests can't see (e.g. an OCAPI operationId with spaces routing differently than a SCAPI camelCase operationId). Don't skip it.

If extending a synthesis skill's coverage past one representative family is out of scope, document which skills haven't been eval'd against the family in the matrix above (with `❓`), so the gap is visible rather than implicit.

### Auth routing (dsc-scenario)

`dsc-scenario`'s auth machinery is a product-neutral provider registry (`shared/engine/auth-providers.js`) with a per-product provider set (`shared/products/commerce-b2c/auth-providers.js` for B2C's four planes). The empirical facts behind it – how SCAPI vs OCAPI authenticate, why OCAPI routes on reference family not scheme, the OCAPI Shop tier ladder, and the runtime-vs-spec defects the code encodes – live in [`commerce-auth-matrix.md`](commerce-auth-matrix.md). Read that before touching auth routing or adding a provider for another product's API family.

### Adding a new skill to the family

A new synthesis skill should:

- Consume the shared cache, not talk to the network directly.
- Have an input/output shape that's categorically different from the existing three (extract-one, walk-graph, compare-two). If the shape is just a variant of one of these, extend that skill instead.
- Cite `developer.salesforce.com` URLs in its output, not local cache paths. This is a family-wide invariant documented in the repository's `AGENTS.md`.
- Decline when the user's ask is outside the family's domain (non-DSC APIs, user-supplied local specs, etc.) – these decline rules keep the whole family's trigger accuracy honest.

### Renaming or removing a skill

Update the plugin and repository `README.md` files in the same commit – skills table, install block, and any mentions in the DSC-family section. The repository's `AGENTS.md` carries the drift-prevention rule.

Sibling skills' SKILL.md `description` fields cross-reference each other ("that's `dsc-X`"). Grep the worktree for the old name before committing.

## Edges and caveats

- **Cross-reference scenarios.** If `dsc-scenario`'s graph walk surfaces an input that originates in another reference, the skill names that source reference in `externalInputs[].reference` – warming the cache for the named reference if it's cold – and either expands the dep into the main plan or surfaces it as a numbered step labelled by source. **Auth deps are always expanded; non-auth deps support a mode choice.** SLAS (`auth`'s `authorizeCustomer` + `getAccessToken` – published at `developer.salesforce.com/docs/commerce/commerce-api/references/auth`, page title "Shopper Login (SLAS)") is mandatory for every SCAPI scenario; `customers_auth` (`POST /customers/auth` on `ocapi-shop-customers`) is the analogue for OCAPI Shop scenarios. Both are real DSC references and get integrated as numbered steps in the plan – the user can't make any subsequent call without the token, so leaving them at "step 1: get a token" abdicates on the most important step. Non-auth deps (e.g. a customer-ID-producing call from a different reference when the user might already have one) keep the expansion-vs-surfacing mode choice. What the skill doesn't do is silently invent calls that aren't backed by a scraped spec.
- **Unknown errors in triage.** `dsc-endpoint-help` (in diagnosis mode) refuses to fabricate diagnoses for 5xx, 404 path-or-resource-missing, and 409 conflicts – those require runtime state the spec doesn't carry. It says so explicitly and hands off.
- **Non-DSC asks.** If the user's ask isn't about a DSC reference (GitHub API scopes, a local OpenAPI file, atlas / Experience Cloud guides), all three `dsc-*` skills should decline. Other skills in the repo address their own domains and aren't a fallback for non-DSC API asks.

## Changelog pointer

See commit messages tagged `feat(dsc-*)`, `refactor(dsc-*)`, and `eval(dsc-*)` for how boundaries have shifted. The most recent boundary shift (the 2026-05-23 merge of `dsc-endpoint-lookup` and `dsc-triage` into `dsc-endpoint-help`) is documented in `evals/dsc-endpoint-help/iteration-merge-baseline.md`; before that, the rename `dsc-query` → `dsc-endpoint-lookup` showed how a skill's *name* primes trigger accuracy as much as its description does.
