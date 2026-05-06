# dsc-scrape

Claude Code skill that scrapes **developer.salesforce.com** (DSC) API reference docs into structured JSON. Claude loads [`SKILL.md`](./SKILL.md) via the `Skill` tool when a matching user request arrives, then runs the bundled `scripts/scrape.js` as a Node subprocess to do the actual scraping. The `dsc-endpoint-lookup` skill also invokes that script by path directly (without going through the `Skill` tool) on cache misses.

## What it does

One call in, structured JSON out. `node scripts/scrape.js <url> <out>` takes any DSC reference URL and writes per-slug JSON files under `<out>`. Every slug of every reference DSC publishes -- SCAPI, Einstein, Data 360, Loyalty, etc. -- resolves to a single static spec file (OpenAPI 3 YAML or AMF-flavored JSON), which the script fetches and parses directly.

## What it produces

```
<out>/
├── _catalog.json              top-level /docs/apis product index (only if scraped)
├── <reference>/
│   ├── _index.json            reference-wide metadata (title, source, full slug list, siblings)
│   ├── Summary.json           reference overview (title, version, description, baseUrl)
│   ├── <operationId>.json     one per endpoint
│   └── types/
│       └── <TypeName>.json    one per named type
└── _landing/
    ├── <product>_<area>.json  product-area landing (list of refs in the area)
    └── <path-slug>.json       ReDoc / non-slug landing URLs (walks the refList, scrapes everything)
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
    "parameters": [
      { "name": "organizationId", "in": "path", "required": true, "schema": {"$ref": "#/components/schemas/OrganizationId"} },
      { "name": "ids", "in": "query", "required": true, "description": "Comma-separated list of product IDs, max 24.", "schema": {"type": "string"} },
      { "name": "siteId", "in": "query", "required": true, "schema": {"$ref": "#/components/schemas/SiteId"} }
    ],
    "body": null,
    "headers": [],
    "responses": [
      { "code": "200", "description": "Success.", "schemaRef": "#/components/schemas/ProductResult" },
      { "code": "400", "description": "Bad Request.", "schemaRef": "#/components/schemas/ErrorResponse" }
    ],
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
| `security[]` | Auth requirements. Each entry is `{ scheme, scopes[] }`. Multiple entries in the array are alternatives (OR); all scopes **within one entry** are required together (AND) |

**Cross-referencing types:** schema refs use the OAS/AMF path `#/components/schemas/<TypeName>`. The corresponding file on disk is `<reference>/types/<TypeName>.json` with the same envelope but `kind: "type"` and a `type` payload. Refs nest -- a type's own schema may reference further types, each resolvable the same way.

Summary and type envelopes follow the same pattern:

```json
{ "kind": "summary", "reference": "shopper-products", "slug": "Summary", "source": {...},
  "summary": { "title": "Shopper Products", "version": "1.0.0", "description": "...", "baseUrl": "https://{shortCode}.api.commercecloud.salesforce.com/product/shopper-products/v1" } }

{ "kind": "type", "reference": "shopper-products", "slug": "type:Product", "source": {...},
  "type": { "name": "Product", "schema": { "type": "object", "required": ["id"], "properties": { ... }, "additionalProperties": "only c_* allowed" } } }
```

OAS and AMF parsers produce **identical envelope shape**, so consumers don't branch on `source.format`. The inner schema representation differs only in leaf detail (AMF carries a few extra shape metadata fields that OAS doesn't).

## URL shapes handled

| URL | Behavior |
|---|---|
| `/docs/apis` (top-level API catalog) | Writes `<out>/_catalog.json` listing every product DSC publishes, with title, body, overviewUrl, guidesUrl, referenceUrl, and a `referenceShape` tag. No spec fetches |
| `.../references` (product-area landing) | Writes `<out>/_landing/<product>_<area>.json` listing every reference in the area. No spec fetches. Pass `--all` to scrape every reference in the area |
| `.../references/<name>` or `?meta=Summary` | Whole reference (writes every slug) |
| `.../references/<name>?meta=<slug>` | Single slug |
| `.../references/<name>/<landing>.html` (e.g. `scapi-api-doc.html`) | ReDoc landing -- parses the embedded refList and scrapes every reference it mentions |

Out of scope: atlas books (`docs/atlas.*.htm`), legacy static-HTML references (e.g. Pardot `guide/version3.html`), MuleSoft (`docs.mulesoft.com`), guides, concept pages. The classifier declines these with a message; products with non-scrapeable references are tagged `referenceShape: "atlas"` or `"static-html"` in `_catalog.json` so callers can filter them up front.

## Installation

Prereqs: Node 22+ (current Active LTS; 20 reached EOL April 2026).

```bash
cd ~/.claude/skills/dsc-scrape
npm install   # installs js-yaml
```

To install the skill itself, drop this directory at `~/.claude/skills/dsc-scrape/`. Claude Code discovers skills by name from that tree.

## How it works

Every DSC `/references/` page carries a JSON `refList` as an HTML attribute: `reference-set-config` on the page root for the RAML/OAS viewer, or `reference-config` on a `<doc-redoc-reference>` element for the ReDoc viewer. Each entry in that list has a `source` field pointing to the static spec file:

- `referenceType: "rest-oa3"` -> `.yaml` OpenAPI 3 spec
- `referenceType: "rest-raml"` -> `.raml` (not fetched) plus a sibling `.raml.amf.json` with the pre-compiled AMF graph

Both static files are publicly fetchable with realistic Chrome-style headers (User-Agent + Sec-Fetch-* + Referer). One HTTP GET for the references-page HTML (to get the refList), one more per reference (for the spec file), and we're done.

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
│   └── write-slugs.js         – disk layout: <ref>/<slug>.json + types/ subdir
│
├── tests/
│   ├── run.sh                 – test runner (npm test)
│   ├── test-*.js              – unit tests (classify / api-catalog / catalog / parse-oas / parse-amf / freshness / endpoints-index) + golden-diff
│   ├── fixtures/              – saved live DSC data (HTML + YAML + AMF, including docs-apis.html)
│   └── expected/              – golden JSON for 6 slugs (Summary + endpoint + type, both parsers)
│
└── evals/evals.json        – agent-level eval prompts
```

## AMF notes (RAML parsing)

RAML references don't publish friendly YAML. Instead, DSC ships a pre-compiled AMF (API Modeling Framework) JSON-LD graph alongside each `.raml` file. The graph uses six vocabularies (`apiContract`, `raml-shapes`, `shacl`, `core`, `doc`, `data`) and wraps every value in single-element arrays (`[{@value: ...}]`) with `@id` cross-references.

Key architectural facts that made this tractable:

- **Every referenced fragment is bundled.** `doc:references` contains type libraries, traits, and named examples as inline fragments -- no external fetches needed. Only vocabulary IRIs (XSD primitives, AMF data-property names) point outside the file, and those are stable static namespaces, not data sources.
- **`@id` resolution is local.** A one-pass index of every defined node handles the reference graph. No network traversal.
- **Enums are `rdfs:Seq`.** `shacl:in` wraps enumeration values in `rdfs:_1`, `rdfs:_2`, etc. -- needs ordered walking, not array iteration. (Easy to miss on first pass.)

The parser is ~280 lines and produces output in the same shape as `parse-oas.js`, so downstream consumers don't care which parser ran.

## Tests

```bash
npm test
```

Runs 8 suites:

- **classify**: 14 URL classification cases (single slug, reference root, area-landing, api-catalog, ReDoc landing, decline cases)
- **api-catalog**: parses `docs-apis.html` fixture (top-level product index), asserts `referenceShape` tagging for area-landing / atlas / static-html products
- **catalog**: 3 refList fixtures (SCAPI `reference-set-config`, Einstein `reference-set-config`, Data 360 `reference-config` on ReDoc)
- **parse-oas**: structural checks against the SCAPI Orders fixture (13 endpoints, 51 types)
- **parse-amf**: structural checks against the Einstein Recommendations fixture (7 endpoints, 19 types, enum resolution)
- **freshness**: TTL behavior for cached `_index.json` (4 cases: fresh skip, expired refresh, first scrape, `--force` bypass)
- **endpoints-index**: `_index.json.endpoints` map shape
- **golden-diff**: 6 per-slug outputs (Summary + one endpoint + one type, for each parser)

Regenerate goldens by running each parser over its fixture and writing the result to `tests/expected/`. Fixtures were captured on 2026-04-27 from the live DSC site; refresh if the schemas change.

## Cache freshness (TTL)

The script honors a 1-hour TTL, matching the `cache-control: max-age=3600` header DSC serves on spec files. When `_index.json.scrapedAt` is within the TTL window, the script skips the fetch entirely and returns `refreshed: false`. This makes repeat scrapes (including every `dsc-endpoint-lookup` call) effectively free -- one `fs.readFileSync` on `_index.json` and no network round-trip.

Overrides:

- `--force` -- bypass TTL for one invocation
- `DSC_CACHE_TTL_MS=<ms>` -- change the default (e.g. `0` to always refresh, `86400000` for 1 day)

## Limitations

- **Catalog stale entries.** DSC's `refList` occasionally lists references whose static files 404 (e.g. `conversation-service-api` as of this writing). In `--all` mode, the loop records these as errors per-reference and continues.
- **RAML types that aren't in `doc:declares`.** If a RAML reference inlines a type rather than declaring it, the parser captures it in the property schema but not as a standalone `type:` slug. Observed in practice to be rare; easy to extend if needed.
- **No schema $ref resolution in OAS output.** Endpoints emit `schemaRef: "#/components/schemas/Order"` rather than inlining the resolved type. Consumers can look up the referenced type in `types/<Name>.json` -- keeping them separate avoids duplicating large schemas across every referring endpoint.

