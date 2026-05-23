---
name: dsc-scrape
description: Scrape developer.salesforce.com (DSC) API reference pages and write structured JSON. Invoke whenever the user asks to scrape, extract, fetch, mirror, capture, discover, or get the contents of any DSC reference URL (anything under `/docs/.../references/` or the top-level `/docs/apis` catalog) -- including "get me the Shopper Products endpoints", "pull the SCAPI reference", "pull an OCAPI reference", "what APIs exist on DSC", "list Commerce Cloud references", "what's under Agentforce", or "scrape this whole API family." Handles the top-level product catalog, product-area reference listings, individual references (OAS 3 YAML, RAML/AMF JSON, Swagger 2 / OCAPI, ReDoc), and single operations in one fetch-based architecture. Not for guides, concept pages, atlas-format books, or release notes -- decline.
---

# DSC Doc Scraping

## Inputs

- `url` (required) -- a DSC URL: either the top-level `/docs/apis` catalog, a product-area landing `/docs/<product>/<area>/references`, a specific reference root `/docs/<product>/<area>/references/<name>`, or a single slug `.../references/<name>?meta=<slug>`.
- `out` (required) -- an absolute path to the output root directory.

If the user's request is vague ("pick one from Commerce Cloud", "scrape any endpoint from Data Cloud"), bootstrap from the top-level catalog: scrape `https://developer.salesforce.com/docs/apis` first, read the resulting `<out>/_catalog.json`, pick the product whose title matches the user's request, and follow its `referenceUrl` into the area-landing scrape. Each product in the catalog has `title`, `body` (short description), `referenceUrl`, `referenceShape`, and `searchKeys` (an array of acronyms and synonyms drawn from the product's landing page plus a hand-curated map for community jargon like "SCAPI"). Match the user's hint case-insensitive substring against `title`, `body`, and `searchKeys` together – the third surface is what makes acronyms like "OCI" or "FSC" resolve without depending on the model's training data. The `referenceShape` tells you whether the reference target is scrapeable (`area-landing`, `reference-root`) or out-of-scope (`atlas`, `static-html`).

Catalog product names drift from what a user might say. Salesforce has rebranded "Data Cloud" to **Data 360**, for example, so matching the literal string "Data Cloud" against catalog titles finds nothing; match on topic keywords. A handful of products (notably Marketing Cloud Growth / Marketing Cloud Next, and Agentforce) don't surface in `/docs/apis` at all but do have `/references/` pages reachable by direct URL. After a catalog miss, lowercase the user's hint and substring-match it against the keys in `lib/scrape/aliases.js` (the `CATALOG_MISSING_ALIASES` map) before asking the user for a URL. **Don't substitute a related-looking product** when the catalog and alias map both miss – e.g. for "Agentforce" the catalog returns no match and the alias map is the canonical next step, not Einstein Gen AI or any other product whose name overlaps semantically. If both miss, ask the user for a URL.

**Watch out for Summary-page redirects.** On reference roots, DSC auto-redirects bare `/references/<name>` URLs to `?meta=Summary` -- a valid slug, but it's the reference's *overview prose*, not an operation. If the user asked for "an endpoint" (or said something that implies one, like "a POST call" or "a specific operation"), scrape the reference root first; the output includes a per-reference `_index.json` with the full slug list, and you can pick a verb-shaped slug (names starting with `get`, `create`, `update`, `delete`, `search`, `list`, etc.) for the user's follow-on question.

## URL shapes

| URL shape | Behavior |
|---|---|
| `/docs/apis` (top-level API catalog) | Write `<out>/_catalog.json` listing every product with title/description and its reference URL. No spec fetches |
| `.../references` (product-area landing) | Write `<out>/_landing/<area>.json` listing every reference in this product area, with `id`/`title`/`referenceType`/`href`. No spec fetches. Pass `--all` to additionally scrape every reference in the area |
| `.../references/<name>` or `?meta=Summary` | Write every slug in the reference (Summary + endpoints + types). For OCAPI, `<name>` may be either a single family (`ocapi-shop-products`) or the wrapper id (`b2c-commerce-ocapi`); the wrapper expands to all 84 OCAPI families |
| `.../references/<name>?meta=<slug>` | Write 1 file for the requested slug |
| `.../references/.../something.html` (ReDoc / OCAPI landing) | Parse the embedded refList and scrape every reference it mentions. OCAPI's `b2c-api-doc.html` works here |

## Flow

Single call -- run this skill's `scripts/scrape.js` with Node. Both `<url>` and `<out>` are **positional** arguments; there is no `--cache-root` / `--cache` / `--out` flag. The only flags accepted are `--all` and `--force`. The out-root must be a concrete shell-expanded path (e.g. `/Users/me/.cache/dsc-scrape`), not a literal `~/...` string – tilde expansion is the caller's job:

```bash
node ~/.claude/skills/dsc-scrape/scripts/scrape.js \
  'https://developer.salesforce.com/docs/commerce/commerce-api/references/orders' \
  ~/.cache/dsc-scrape
```

The script is a thin wrapper around the shared scrape library at `lib/scrape/` (reached via the `lib -> ../_shared` symlink); js-yaml ships there. If invoked with a misparsed flag (`--cache-root`, `--out`, etc.) or a literal `~` as the second positional, the script exits with code 2 and a usage hint instead of silently creating a stray directory.

The script classifies the URL, fetches the reference page HTML to extract the `refList` (from `reference-set-config` or ReDoc's `reference-config`), fetches the static spec file (OAS 3 YAML for `rest-oa3`, AMF JSON sidecar for `rest-raml`, Swagger 2 JSON or YAML for `rest-oa2`), parses it, and writes one JSON file per slug. No browser, no external tools required.

For successful runs, the script prints a JSON summary to stdout listing `slugsWritten`, `format`, `specUrl`, `files[]`, and `refreshed` (boolean). `refreshed: false` means the cached reference was still fresh and no fetch happened (fast path); `refreshed: true` means new bytes were fetched and written. Relay the file count and (for reference-root scrapes) the path to `_index.json` back to the user. If `refreshed: false`, mention that the cache was already fresh.

## Freshness

The script uses a 1-hour TTL that matches DSC's own `cache-control: max-age=3600` on spec files. On each scrape:

- Read `_index.json.scrapedAt` from the output directory.
- If it's less than 1 hour old, **skip the fetch entirely** -- no network, no parse, no disk writes. Result: `refreshed: false`.
- Otherwise fetch, parse, and overwrite `_index.json` + every slug file. Result: `refreshed: true`.

**Overrides:**
- `--force` CLI flag ignores the TTL and always re-fetches.
- `DSC_CACHE_TTL_MS=<ms>` env var replaces the default (set to `0` to always refresh).

Single-slug scrapes (`?meta=<slug>`) bypass the TTL -- the caller explicitly wants that file on disk, possibly rewritten.

### Vague-URL recipe

When the user asks for "an endpoint" or a product without naming a specific reference (`"scrape any endpoint from Commerce Cloud"`, `"pick a SCAPI call"`):

1. Scrape `/docs/apis` -- writes `_catalog.json` with every top-level product and its `referenceUrl`.
2. Pick the product whose title matches the user's request. Skip any whose `referenceShape` is `atlas` or `static-html` -- those aren't scrapeable.
3. Scrape the product's `referenceUrl` (an area-landing). This writes `_landing/<area>.json` listing every reference in that area with its `id`, `title`, and `referenceType` (`rest-oa3` / `rest-raml` are scrapeable; `markdown` isn't).
4. Scrape a specific reference root (`/references/<name>`) from that list. This writes every slug -- Summary, endpoints, types, and `_index.json`.
5. Read `_index.json`, pick a verb-shaped slug from its `slugs` list, and point the user at the corresponding file on disk.

The catalog scrape and area-landing scrape are list-only by design -- they don't eat spec bandwidth for refs the user doesn't want. TTL is the same 1-hour freshness window used for references, so once you've bootstrapped a product area, follow-on scrapes are free cache hits.

Only re-scrape a single slug to a different output path if the user was specific about where one endpoint JSON should land.

## Output layout

```
<out>/
├── _catalog.json                    top-level /docs/apis product index (only if scraped)
├── _landing/
│   ├── <product>_<area>.json        product-area landing (list of refs in the area)
│   └── <slug-of-html-path>.json     ReDoc / non-slug landing URLs
└── <area>/                          e.g. commerce_commerce-api, revenue_subscription-management
    └── <reference>/
        ├── _index.json              reference-wide metadata: title, source, full slug list, siblings
        ├── Summary.json             reference overview
        ├── <operationId>.json       one file per endpoint
        └── types/
            └── <TypeName>.json      one file per named type
```

Each per-slug JSON has a unified envelope -- `kind` (`endpoint`/`type`/`summary`), `reference`, `slug`, `url`, `scrapedAt`, `source.{format, specUrl}` -- followed by an `endpoint` / `type` / `summary` payload. OAS, AMF, and Swagger 2 sources produce identical envelope shape; consumers don't branch on format. Swagger 2 specs have their `$ref` paths normalized from `#/definitions/X` to `#/components/schemas/X` so type lookups by ref work the same way OAS 3 does.

`_catalog.json` has `products[]` with `title`, `body`, `overviewUrl`, `guidesUrl`, `referenceUrl`, and `referenceShape` (`area-landing` / `reference-root` / `atlas` / `static-html` / `unknown`). Only `area-landing` and `reference-root` shapes are scrapeable.

`_landing/<product>_<area>.json` has `references[]` with `id`, `title`, `referenceType` (`rest-oa3` / `rest-raml` / `rest-oa2` are scrapeable; `markdown` is not), `source`, and `href`.

## Reading the output

Downstream questions like "which scopes do I need for `getProducts`?" or "what query params does `searchOrders` take?" are answered directly from the scraped JSON -- no need to re-scrape or visit the site. The `endpoint` payload has the same shape for both OAS and AMF sources. Fields worth knowing when fielding such questions:

- `endpoint.method` / `endpoint.path` / `endpoint.url` -- HTTP verb, templated path, full URL with the spec's base server prepended.
- `endpoint.operationId` -- may be `null` for specs that don't set it. In those cases the slug is synthesized as `{method}-{path-with-slashes-and-braces-stripped}`, so the file on disk still has a predictable name.
- `endpoint.parameters[]` -- path, query, and header params. Each has `name`, `in` (`path` / `query` / `header`), `required`, `schema`, `description`.
- `endpoint.body` -- request body shape, if any. Either `schemaRef` (`#/components/schemas/...`) or inline `schema`, with optional `examples`.
- `endpoint.responses[]` -- one entry per status code with `code`, `description`, and `schemaRef` or `schema`.
- `endpoint.security[]` -- auth requirements. Each entry is `{scheme, scopes[]}`. This is where OAuth scope questions live.

OCAPI specifics: `endpoint.operationId` may be human prose like `"Get multiple products"`. The slug used as the on-disk filename comes from a fallback `<method>-<path>` derivation (e.g. `get-products-ids`) for that reason -- search by method/path or `endpoint.operationId`, not by slug, when an OCAPI question references a verb-shaped name. OCAPI URLs in `endpoint.url` carry `{host}` and `{siteId}` placeholders rather than concrete hostnames; that mirrors the spec, where the runtime host is the customer's sandbox.

Type references resolve by path: `endpoint.body.schemaRef = "#/components/schemas/Product"` -> read `<area>/<reference>/types/Product.json` for the full type shape. Type files carry `type.schema` with the same structure OAS/RAML produces.

## Citing in the answer

Every customer-facing answer this skill composes from the scraped JSON cites public `developer.salesforce.com` URLs. Never cite the local cache path (`~/.cache/dsc-scrape/...`) and never cite the skill's own files (`~/.claude/skills/...`) – those are skill internals; engineers forward these answers to customers. The URLs are already in the JSON: `_landing/<product>_<area>.json` carries the area `url`, each per-slug file carries a `url` field, and `_index.json` per reference carries `source.specUrl`. When the answer is a list of references rather than a single endpoint – e.g. "which references does Marketing Cloud Growth expose?" – cite each reference's URL inline alongside its name. **Listing reference names without URLs is not a citation.** A discovery-style summary still has to be forwardable.

Even when the answer is a negative finding – "the queried product doesn't expose an endpoint for X" – cite the queried product's references-area URL so the user can verify and explore. Pivoting to related products that *do* expose X is fine and often helpful; pivoting *away from* the queried product's URL is not. An answer that concludes "MCG has no event-ingestion API, here's where to look in Data Cloud and Pub/Sub" must still cite the MCG references-area URL alongside the alternatives. The citation contract is "cite the queried product, then optionally cite alternatives," not "cite some `developer.salesforce.com` URL."

## Scope

- **In scope**: DSC `/references/` pages that expose either `reference-set-config` (OAS 3 YAML, RAML, or Swagger 2 / OCAPI) or a `<doc-redoc-reference>` element (ReDoc-rendered OAS 3), plus the top-level `/docs/apis` catalog. All render via static HTML the skill fetches directly.
- **Atlas books** (URLs contain `atlas.` and end in `.htm`, with no `/references/` segment). Decline -- different viewer. Example: the core Platform REST API guide is an atlas book. The catalog parser flags these as `referenceShape: "atlas"` so callers can filter them before attempting to scrape.
- **Static HTML references** (legacy, e.g. Pardot/Account Engagement's `guide/version3.html`). Decline for the same reason. Flagged as `referenceShape: "static-html"` in the catalog.
- **MuleSoft docs** at `docs.mulesoft.com` are a separate platform. Decline.
- **Guides, concept pages, release notes**: Decline. This skill is for reference pages.

The script's classifier catches these and exits with a decline message. If the user hands you a clearly-out-of-scope URL, call the script anyway and relay its decline -- don't second-guess the classifier.

## Error handling

- Decline (classifier) -> exit 3 with a message. No file written. Relay the reason.
- Unreachable spec (catalog lists a reference but the static file is 404 -- e.g. `conversation-service-api` is a known stale catalog entry) -> exit 1 with the URL and status. In `--all` mode, the error is recorded per-reference and the loop continues.
- Malformed spec -> exit 1 with the parse error.

Never retry. Surface the error to the user.

## Key invariants

- One slug -> one file. The per-reference `_index.json` is the only file that carries the full slug list and sibling list. Don't duplicate that data into individual slug files.
- Type slugs (`type:<Name>`) write to `<area>/<reference>/types/<Name>.json`. Other slugs write to `<area>/<reference>/<slug>.json`. The `slug` field in the JSON keeps the `type:` prefix; the filesystem layout is purely a disk concern.
- Endpoint slug = the spec's `operationId`. When a spec has no `operationId` for an operation (e.g. Data 360 Connect), a fallback `<method>-<path-with-slashes-and-braces-stripped>` is synthesized -- `get-ssot-activation-targets`, `post-ssot-activations-activationId-actions-publish`. In both cases the slug is filesystem-safe, so slug and filename (minus `.json`) are the same string.
- `rest-oa3`, `rest-raml`, and `rest-oa2` dispatch to different parsers but produce identical-shape output. Consumers don't need to branch on `source.format`.

## See also

- `README.md` (in this skill dir) -- design, internals, test instructions.
