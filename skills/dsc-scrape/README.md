# dsc-scrape

A Claude Code skill that scrapes developer.salesforce.com (DSC) API reference docs into structured JSON. One call in, structured JSON out -- per-slug files keyed by area and reference, with a unified envelope across OpenAPI 3 (YAML), RAML (AMF JSON), Swagger 2 (OCAPI), and ReDoc parsers.

## What it does

- **Scrapes any DSC reference URL** -- single-slug, whole-reference, product-area landing, ReDoc landing, or the top-level `/docs/apis` catalog. URL classifier picks the right pipeline.
- **Parses four spec formats into one envelope.** OAS 3 YAML, RAML/AMF JSON, Swagger 2 (OCAPI), and ReDoc-bundled refs all produce identical-shaped output -- consumers don't branch on `source.format`.
- **Caches per area + reference** under `~/.cache/dsc-scrape/<area>/<reference>/`. Areas come from the `/docs/<area>/references` URL (`commerce_commerce-api`, `revenue_subscription-management`, etc.) so refs that share an id across product areas don't collide.
- **Honors a 1-hour TTL** matching DSC's `cache-control: max-age=3600`. Repeat scrapes are effectively free -- one `_index.json` read, zero network round-trips, until the TTL expires.
- **Discovers references through aliases on cold cache.** Catalog-missing products (e.g. Agentforce) resolve through `lib/scrape/aliases.js` -- the cascade reads the alias map, hits the area-landing, and warms the reference in one call.
- **Cites every reference and slug to a public DSC URL.** Each per-slug file carries `url:` (the operation's `?meta=` permalink); each `_index.json` carries `source.specUrl` (the static spec file). No reliance on local cache paths.
- **Declines non-scrapeable surfaces honestly.** Atlas books (`docs/atlas.*.htm`), legacy static-HTML references, MuleSoft, guides, concept pages -- the classifier rejects with a message; products with non-scrapeable references are tagged `referenceShape: "atlas"` or `"static-html"` in `_catalog.json` so callers can filter up front.

## Not for

- **Asking what one endpoint requires** ("what scopes does X need", "why is this 403ing"). That's [`dsc-endpoint-help`](../dsc-endpoint-help/) -- it composes a prose answer; this skill produces raw JSON.
- **Building a multi-call repro plan** ("what do I need to call before X"). That's [`dsc-scenario`](../dsc-scenario/).
- **Atlas books, legacy static-HTML refs, MuleSoft, guides, concept pages.** Out of scope. The classifier declines.
- **Authentication setup, rate-limit policies, or anything outside the static spec file.** Those live in DSC guide pages, not in the JSON DSC publishes per reference.
- **Salesforce APIs outside developer.salesforce.com** -- internal-only specs, partner-portal docs, MuleSoft Anypoint Exchange.

## Why you'd want this

DSC publishes references in four different formats (OAS 3 YAML, RAML/AMF JSON, Swagger 2, ReDoc) and three different page shapes (single slug, whole reference, ReDoc landing) -- and the underlying static spec file lives at a different URL pattern for each. Hand-fetching one slug means: open the references page, view source to find the embedded `refList` (it's a JSON attribute on a custom HTML element, not a clean API), parse it to find the spec file URL, fetch the spec, parse the right format, locate the slug. That's tedious for one endpoint and prohibitive for warming a cache across several references.

The skill collapses the whole pipeline to `node scripts/scrape.js <url> <out>`. The unified envelope means downstream consumers (`dsc-endpoint-help`, `dsc-scenario`, your own scripts) read identical-shaped JSON whether the spec was OAS, RAML, or Swagger 2. The TTL+area cache keys mean repeat queries are free *and* don't collide across product areas.

The catalog-missing alias cascade is the load-bearing capability for newer products. When DSC ships a new product (Agentforce, MCG) before catalog `_catalog.json` indexes it, the skill still resolves the right reference because the alias map records canonical URLs for products the catalog doesn't yet know about. Without that, you'd get "not in the catalog -- give up" answers for the products the user is most likely asking about.

## Tested

Synthesis-eval: 10/10 strict on Sonnet 4.6 (2 fixtures × 5 runs each):

| Fixture | What it guards |
|---|---|
| `mcg-alias-citation-leak` | MCG triggers the catalog-missing alias-map fallback. The cascade reads `lib/scrape/aliases.js`, hits the area-landing, and cites the public DSC URL -- never the local cache path. |
| `agentforce-alias-url-trace` | Agentforce is catalog-missing (added to `aliases.js` in commit `faa2f20`); the trace must surface alias resolution and cite developer.salesforce.com URLs throughout. |

Plus 8 unit-test suites under `tests/`:

- **classify** -- 14 URL classification cases (single slug, reference root, area-landing, api-catalog, ReDoc landing, decline cases).
- **api-catalog** -- parses `docs-apis.html` fixture, asserts `referenceShape` tagging for area-landing / atlas / static-html products.
- **catalog** -- 3 refList fixtures (SCAPI `reference-set-config`, Einstein `reference-set-config`, Data 360 `reference-config` on ReDoc).
- **parse-oas** -- structural checks against the SCAPI Orders fixture (13 endpoints, 51 types).
- **parse-amf** -- structural checks against the Einstein Recommendations fixture (7 endpoints, 19 types, enum resolution).
- **parse-swagger2** -- structural checks against OCAPI Shop fixtures.
- **freshness** -- TTL behavior for cached `_index.json` (4 cases: fresh skip, expired refresh, first scrape, `--force` bypass).
- **endpoints-index** + **golden-diff** -- `_index.json.endpoints` map shape and 6 golden per-slug outputs (Summary + endpoint + type, all three parsers).

See [`tests/`](tests/) and [`evals/dsc-scrape/`](../../evals/dsc-scrape/).

## What it produces

```
<out>/
├── _catalog.json              top-level /docs/apis product index (only if scraped)
├── _landing/
│   ├── <product>_<area>.json  product-area landing (list of refs in the area)
│   └── <path-slug>.json       ReDoc / non-slug landing URLs (walks the refList, scrapes everything)
└── <area>/                    e.g. commerce_commerce-api, revenue_subscription-management
    └── <reference>/
        ├── _index.json        reference-wide metadata (title, source, full slug list, siblings)
        ├── Summary.json       reference overview (title, version, description, baseUrl)
        ├── <operationId>.json one per endpoint
        └── types/
            └── <TypeName>.json one per named type
```

Each per-slug file has a unified envelope. Top level is always these fields; the `endpoint` / `type` / `summary` payload keys off `kind`:

```json
{
  "kind": "endpoint",
  "reference": "shopper-products",
  "slug": "getProducts",
  "url": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products?meta=getProducts",
  "scrapedAt": "2026-04-27T19:02:11.412Z",
  "source": {
    "format": "oas-3",
    "specUrl": "https://developer.salesforce.com/static/commercecloud/commerce-api/shopper-products/shopper-products-oas-v1-public.yaml"
  },
  "endpoint": {
    "method": "GET",
    "path": "/organizations/{organizationId}/products",
    "url": "https://{shortCode}.api.commercecloud.salesforce.com/product/shopper-products/v1/organizations/{organizationId}/products",
    "operationId": "getProducts",
    "summary": "Returns product details for multiple products.",
    "description": "Returns product details for up to 24 products...",
    "parameters": [...],
    "body": null,
    "headers": [],
    "responses": [...],
    "security": [
      { "scheme": "ShopperToken", "scopes": ["sfcc.shopper-products", "sfcc.shopper-standard"] }
    ]
  }
}
```

**What's in each endpoint field:**

| Field | Content |
|---|---|
| `method`, `path`, `url` | HTTP verb, templated path, full URL with the spec's server prefix prepended |
| `operationId` | Matches the slug and filename. `null` for specs that don't set it -- in those cases the slug (and filename) is synthesized as `{method}-{path-with-slashes-and-braces-stripped}` |
| `parameters[]` | Path, query, and header params. Each has `name`, `in`, `required`, `schema`, `description` |
| `body` | Request body -- `{ schemaRef, mediaType, examples? }` or `{ schema, ... }` if inline. `null` for GET/DELETE |
| `responses[]` | One entry per status code, each `{ code, description, schemaRef?, schema?, examples? }` |
| `security[]` | Auth requirements. Each entry is `{ scheme, scopes[] }`. Multiple entries in the array are alternatives (OR); all scopes within one entry are required together by OAS syntax (AND) -- in practice almost universally OR-listed alternatives. See `dsc-endpoint-help`'s "Scope conjunction" note. |

**Cross-referencing types:** schema refs use the OAS/AMF path `#/components/schemas/<TypeName>`. The corresponding file on disk is `<area>/<reference>/types/<TypeName>.json` with the same envelope but `kind: "type"` and a `type` payload. Refs nest -- a type's own schema may reference further types, each resolvable the same way.

OAS, AMF, and Swagger 2 parsers produce **identical envelope shape**, so consumers don't branch on `source.format`. The inner schema representation differs only in leaf detail (AMF carries a few extra shape metadata fields).

## URL shapes handled

| URL | Behavior |
|---|---|
| `/docs/apis` (top-level API catalog) | Writes `<out>/_catalog.json` listing every product DSC publishes, with title, body, overviewUrl, guidesUrl, referenceUrl, and a `referenceShape` tag. No spec fetches |
| `.../references` (product-area landing) | Writes `<out>/_landing/<product>_<area>.json` listing every reference in the area. No spec fetches. Pass `--all` to scrape every reference in the area |
| `.../references/<name>` or `?meta=Summary` | Whole reference (writes every slug) |
| `.../references/<name>?meta=<slug>` | Single slug |
| `.../references/<name>/<landing>.html` (e.g. `scapi-api-doc.html`) | ReDoc landing -- parses the embedded refList and scrapes every reference it mentions |

Out of scope: atlas books (`docs/atlas.*.htm`), legacy static-HTML references (e.g. Pardot `guide/version3.html`), MuleSoft (`docs.mulesoft.com`), guides, concept pages.

## Install

```bash
git clone <repo-url>
cd claude-code-skills
ln -s "$PWD/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
npm install --prefix skills/dsc-scrape   # installs js-yaml
```

Prereqs: Node 22+ (current Active LTS; 20 reached EOL April 2026).

## Usage

```bash
node ~/.claude/skills/dsc-scrape/scripts/scrape.js <url> <out>
```

`<url>` is any DSC reference URL (see "URL shapes handled"). `<out>` is the output directory; the skill writes a structured tree under it.

In conversation, ask Claude to scrape, mirror, or fetch a reference and the skill picks up.

## How it works

Every DSC `/references/` page carries a JSON `refList` as an HTML attribute: `reference-set-config` on the page root for the RAML/OAS viewer, or `reference-config` on a `<doc-redoc-reference>` element for the ReDoc viewer. Each entry in that list has a `source` field pointing to the static spec file:

- `referenceType: "rest-oa3"` -> `.yaml` OpenAPI 3 spec
- `referenceType: "rest-raml"` -> `.raml` (not fetched) plus a sibling `.raml.amf.json` with the pre-compiled AMF graph
- `referenceType: "rest-oa2"` -> `.json` Swagger 2 (OCAPI)

Both static files are publicly fetchable with realistic Chrome-style headers (User-Agent + Sec-Fetch-* + Referer). One HTTP GET for the references-page HTML (to get the refList), one more per reference (for the spec file), and the parse is offline.

### Pipeline

```
URL -> classify -> fetch references page -> parse refList
                                          -> TTL fresh? -> done (refreshed: false)
                                          -> TTL stale? -> fetch spec (YAML or AMF JSON)
                                                        -> parse into [{kind, slug, payload}, ...]
                                                        -> write per-slug JSON (refreshed: true)
```

### Module map

```
dsc-scrape/
├── SKILL.md                – agent-facing flow
├── README.md               – this file
├── package.json            – Node deps (js-yaml only)
│
├── scripts/
│   ├── scrape.js              – entry point; argv parsing, orchestration
│   ├── classify.js            – URL shape detection + decline cases
│   ├── fetch-url.js           – HTTP fetch with DSC-friendly headers
│   ├── parse-api-catalog.js   – /docs/apis product index extractor
│   ├── parse-catalog.js       – refList extractor (handles both attr forms)
│   ├── parse-oas.js           – OpenAPI 3 spec -> slug list
│   ├── parse-amf.js           – AMF JSON graph -> slug list (same shape as OAS)
│   ├── parse-swagger2.js      – Swagger 2 spec -> slug list (OCAPI; same shape, $refs normalized to OAS-3)
│   └── write-slugs.js         – disk layout: <area>/<ref>/<slug>.json + types/ subdir
│
└── tests/
    ├── run.sh                 – test runner (npm test)
    ├── test-*.js              – unit tests + golden-diff
    ├── fixtures/              – saved live DSC data (HTML + YAML + AMF + Swagger 2 JSON)
    └── expected/              – golden JSON for 9 slugs (Summary + endpoint + type, all three parsers)
```

### AMF notes (RAML parsing)

RAML references don't publish friendly YAML. Instead, DSC ships a pre-compiled AMF (API Modeling Framework) JSON-LD graph alongside each `.raml` file. The graph uses six vocabularies (`apiContract`, `raml-shapes`, `shacl`, `core`, `doc`, `data`) and wraps every value in single-element arrays (`[{@value: ...}]`) with `@id` cross-references.

Key architectural facts that made this tractable:

- **Every referenced fragment is bundled.** `doc:references` contains type libraries, traits, and named examples as inline fragments -- no external fetches needed. Only vocabulary IRIs (XSD primitives, AMF data-property names) point outside the file, and those are stable static namespaces, not data sources.
- **`@id` resolution is local.** A one-pass index of every defined node handles the reference graph. No network traversal.
- **Enums are `rdfs:Seq`.** `shacl:in` wraps enumeration values in `rdfs:_1`, `rdfs:_2`, etc. -- needs ordered walking, not array iteration. (Easy to miss on first pass.)

The parser is ~280 lines and produces output in the same shape as `parse-oas.js`, so downstream consumers don't care which parser ran.

## Cache freshness (TTL)

The script honors a 1-hour TTL, matching the `cache-control: max-age=3600` header DSC serves on spec files. When `_index.json.scrapedAt` is within the TTL window, the script skips the fetch entirely and returns `refreshed: false`. This makes repeat scrapes (including every `dsc-endpoint-help` call) effectively free -- one `fs.readFileSync` on `_index.json` and no network round-trip.

Overrides:

- `--force` -- bypass TTL for one invocation
- `DSC_CACHE_TTL_MS=<ms>` -- change the default (e.g. `0` to always refresh, `86400000` for 1 day)

## Tests

```bash
npm test
```

Runs 8 suites; see "Tested" above for the breakdown. Fixtures were captured on 2026-04-27 from the live DSC site; refresh if the schemas change. Regenerate goldens by running each parser over its fixture and writing the result to `tests/expected/`.

## Companion skills

- [`dsc-endpoint-help`](../dsc-endpoint-help/) -- consumes the cache to answer single-endpoint questions in prose, with a public DSC URL for every claim.
- [`dsc-scenario`](../dsc-scenario/) -- consumes the cache to compose multi-call repro plans, walking the type graph for ID threading and prerequisite ordering.

The synthesis skills warm the cache themselves on miss (via the same shared scrape library this skill uses), so installing `dsc-scrape` standalone is only required when you want raw JSON dumps invoked directly by name.

## Limitations

- **Catalog stale entries.** DSC's `refList` occasionally lists references whose static files 404 (e.g. `conversation-service-api` as of this writing). In `--all` mode, the loop records these as errors per-reference and continues.
- **RAML types that aren't in `doc:declares`.** If a RAML reference inlines a type rather than declaring it, the parser captures it in the property schema but not as a standalone `type:` slug. Observed in practice to be rare; easy to extend if needed.
- **No schema $ref resolution in OAS output.** Endpoints emit `schemaRef: "#/components/schemas/Order"` rather than inlining the resolved type. Consumers can look up the referenced type in `types/<Name>.json` -- keeping them separate avoids duplicating large schemas across every referring endpoint.
