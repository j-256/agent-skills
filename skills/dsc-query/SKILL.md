---
name: dsc-query
description: Answer specific questions about a Salesforce DSC API endpoint -- OAuth scopes, query params, request body, response schema, auth scheme, HTTP method/path -- by reading JSON that `dsc-scrape` produced (or producing it on demand). Invoke whenever the user asks a targeted question about a DSC reference endpoint -- "what scopes does shopper-products getProducts need?", "which query params does searchOrders take?", "what auth scheme guards createOrder?", "show me the 201 response schema for customer-groups createCustomerGroup" -- regardless of whether they name the reference explicitly. Not for scraping whole references wholesale (that's `dsc-scrape`), not for guides/concept pages/release notes (decline).
---

# DSC Endpoint Query

Answer one targeted question about one DSC endpoint, fast. The heavy lifting -- fetching and parsing the spec -- belongs to `dsc-scrape`. This skill's job is to (a) make sure the endpoint JSON exists locally, (b) pull out the specific field the user is asking about, and (c) answer in prose with the file path so the user can verify.

## Inputs from the user

The user's question usually contains:

- **A reference name** ("shopper-products", "orders", "scapi shopper baskets") -- maybe abbreviated, maybe product-branded ("SCAPI Shopper Products" -> `shopper-products`).
- **An operation identifier** ("getProducts", "createOrder", sometimes partial: "the products get endpoint", "that getCustomer call").
- **A concrete question**: what scopes, what params, what body, what response, what method/path, what auth scheme.

Sometimes one of these is missing. See "Disambiguation" below.

## Cache location

Use `~/.cache/dsc-scrape/` as the cache root. Create it if it doesn't exist (scrape will create subdirs itself). This is shared across projects -- scraping once benefits future sessions.

Per-reference layout inside the cache mirrors `dsc-scrape`'s output:

```
~/.cache/dsc-scrape/
└── <reference>/
    ├── _index.json           full slug list + title + siblings
    ├── Summary.json          overview prose (NOT an endpoint)
    ├── <operationId>.json    one file per endpoint
    └── types/<TypeName>.json one file per named type
```

## Flow

1. **Pick reference + slug** from the user's question. If either is missing or ambiguous, disambiguate (see below) before running anything.
2. **Try to answer locally** by running `scripts/query.js`. If it exits 0, you have the data.
3. **If it exits 2 (reference not cached)**, run `dsc-scrape` to populate it, then retry. If exit 3 (slug not found / ambiguous), use the returned `candidates` to confirm with the user or narrow.
4. **Write the answer in prose**, quoting only the field the user asked about, and cite the file path (`~/.cache/dsc-scrape/<reference>/<slug>.json`) so the user can open it.

### Step 1: Resolve reference + slug

Common name drifts you'll see:

| User says | Reference slug |
|---|---|
| "Shopper Products", "SCAPI products", "the products API" | `shopper-products` |
| "Orders API", "SCAPI orders" | `orders` (under commerce-api) or possibly `shopper-orders` (under commerce-api) -- different references, different operations |
| "Customer Groups" | `customer-groups` |
| "Data Cloud X", "Data 360 X" | Data 360 references (Salesforce rebranded) |

If unsure, run `node scripts/list.js ~/.cache/dsc-scrape/` to see what's already cached. If the target reference isn't there, you'll need the full DSC URL to scrape -- ask the user, or for common SCAPI references infer: `https://developer.salesforce.com/docs/commerce/commerce-api/references/<reference>`.

The **slug** is typically the `operationId` (`getProducts`, `createOrder`). Fuzzy matching is built in -- `query.js` will resolve "products" against the index if there's exactly one match.

### Step 2: Query locally

```bash
node <skill>/scripts/query.js ~/.cache/dsc-scrape/ <reference> <slug> [--field <name>]
```

Match the question to the right field -- this keeps the output small and focused:

| User asks... | Use `--field` |
|---|---|
| "what scopes...", "what OAuth...", "which permissions..." | `security` |
| "what params...", "what query params...", "required params..." | `parameters` |
| "what's the request body", "what fields in the POST body" | `body` -- add `--resolve-refs` |
| "what response schema", "what does it return", "what's the 200 response" | `responses` -- add `--resolve-refs` |
| "HTTP method", "path", "endpoint URL" -- any of these alone | `all` (the header is included with every field) |
| "show me the whole endpoint" | `all` or `raw` if they want the full JSON untouched |

**`--resolve-refs` matters a lot for `body` and `responses` questions.** Without it you get back `schemaRef: "#/components/schemas/Product"` and you'd have to read `types/Product.json` separately (and every type it nests) to get real fields. `--resolve-refs` inlines the referenced type in one call, so the user's question ("what does it return?") gets a direct answer from a single script run instead of a chain of file reads.

Examples are stripped by default (they can be huge). Pass `--include-examples` only if the user explicitly wants them.

### Step 3: Scrape on cache miss

When `query.js` exits 2, invoke `dsc-scrape` directly by its bundled script -- do NOT call it via the Skill tool. Assume the standard install path:

```bash
node ~/.claude/skills/dsc-scrape/scripts/scrape.js \
  "https://developer.salesforce.com/docs/<product>/<area>/references/<reference>" \
  ~/.cache/dsc-scrape/
```

Scraping the **reference root** (no `?meta=`) writes the whole reference in one pass -- Summary + every endpoint + every type + `_index.json`. Do this even if the user only asked about one endpoint. The network cost is identical: `dsc-scrape` downloads a single static spec file (one OAS YAML or one AMF JSON) that already contains every operation -- writing out one slug vs. all of them is just a parse-time decision. Upsides of the whole-reference scrape:

1. **Slug safety** -- if the user's slug guess was slightly off (`searchCustomerGroup` vs. `searchCustomerGroups`), `_index.json` lets you correct it without a second fetch.
2. **Future cache hits** -- any later question about any other endpoint in this reference is free.
3. **Type resolution works** -- `--resolve-refs` reads `types/<TypeName>.json`. Those files only exist if the whole reference was scraped.

Only scrape a single slug (`?meta=<slug>`) if the user explicitly asked for just that one to land on disk.

If `~/.claude/skills/dsc-scrape/scripts/scrape.js` doesn't exist, tell the user: "I need the `dsc-scrape` skill installed to fetch uncached references. Install it, or point me at an existing cache of scraped JSON." Don't try to fetch DSC pages via WebFetch/curl as a substitute -- DSC specs are static files linked from the HTML and `dsc-scrape` knows how to locate and parse them.

**If the scrape 404s** (exit 1 with an HTTP 404 message), the reference slug the user gave you is wrong -- misspelled, rebranded, or it doesn't exist under that product area at all. Don't guess variations by re-scraping them one at a time; that's slow and fragile.

Instead, fetch any **known-good reference page from the same product area** and extract its sibling list. Every DSC reference page embeds the full refList for its product in a `reference-set-config` HTML attribute -- the same attribute `dsc-scrape` itself parses. One `curl` + a regex gives you the authoritative list of references that exist for that product:

```bash
curl -s "https://developer.salesforce.com/docs/<product>/<area>/references/<any-known-ref>" \
  | grep -oE "reference-set-config='[^']+'" | head -1
```

The JSON in that attribute has `refList[]` with `id`, `title`, `href`, `source` for every reference in the product area. Find the closest real name, tell the user what their guess should have been, and rescrape. Common drifts: "customer-groups" (operations actually live in `customers`), "baskets" (could be `shopper-baskets` or `baskets` depending on audience), anything where the user pluralized/singularized.

If you don't know *any* reference in the user's product area to seed the lookup, ask the user for a full DSC URL rather than guessing. A wrong reference name is a cheap user question; a cascade of guessed scrapes is not.

After a successful scrape, rerun `query.js`. If it still can't find the slug, read `_index.json`'s slug list -- the user's operation name may also be off (e.g. `searchCustomerGroups` plural vs. `searchCustomerGroup` singular).

### Step 4: Answer in prose

Lead with the direct answer, then show the evidence (one-line quote of the relevant JSON shape), then the file path. One or two paragraphs for most questions; grouped bullets when there are many related facts (e.g. long parameter list, wide response type).

**Format guidance -- this matters because answers are read in a terminal:**

- Use **prose + bullets**. Skip markdown tables -- they render fine in a rendered preview but look like walls of `|` characters in the raw terminal most users are actually reading. Bullets degrade gracefully.
- Use **one-line JSON-ish quotes** (`security: [{ scheme: "X", scopes: [...] }]`) for shape, not full pretty-printed blocks. The user can open the cited file if they want the full thing.
- **Group related fields** when a type is wide (e.g. a Product response with 45 fields). "Scalars: ..., Pricing: ..., Merchandising: ..." beats an alphabetical dump.
- **No hedging preamble.** Don't open with "Based on the cached JSON, I can tell you that..." -- just answer.
- **Cite the file path** at the end, not inline mid-sentence.

**Example: "what scopes does shopper-products getProducts need?"**

> `getProducts` needs the `sfcc.shopper-products` **and** `sfcc.shopper-standard` scopes (both required, not either/or) via the `ShopperToken` OAuth scheme.
>
> `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]`
>
> Source: `~/.cache/dsc-scrape/shopper-products/getProducts.json`

**Note on OAS/AMF `security[]` semantics:** all scopes within a single entry are **required together** (AND). Multiple entries in the array are alternatives (OR). So `security: [{ scheme: X, scopes: [a, b] }]` means "scope a AND b required via X." Don't describe co-listed scopes as "one of" -- that misreads the spec and will bite the user when their token fails with a 403.

**Example: "what query params does searchOrders take?"**

> `searchOrders` accepts these query params (all optional unless noted):
> - `siteId` (required) -- site identifier
> - `q` -- free-text search
> - `limit` / `offset` -- pagination
>
> Source: `~/.cache/dsc-scrape/shopper-orders/searchOrders.json`

**Example: "what does getProduct return on 200?"** (response-schema question -- use `--field responses --resolve-refs` so you can name real fields)

> Returns a `Product` object. Top-level shape:
> - **Identifiers**: `id` (required), `brand`, `manufacturerName`, `upc`, `ean`
> - **Content**: `name`, `shortDescription`, `longDescription`, `pageTitle`, `pageKeywords`
> - **Pricing**: `price`, `priceMax`, `prices` (pricebookId -> number), `tieredPrices`, `currency`
> - **Media**: `imageGroups[]`
> - **Variation** (master/variant products): `variants[]`, `variationAttributes[]`, `master`
> - **Expansion-gated**: `inventory` (availability expansion), `shippingMethods` (shipping_methods expansion)
>
> Also allows `c_*` custom attributes. Other responses: 400, 401, 404.
>
> Source: `~/.cache/dsc-scrape/shopper-products/getProduct.json` + `types/Product.json`

Stay terse. Do not dump the whole JSON unless the user asked for it.

## Disambiguation

**Slug ambiguous.** `query.js` exit 3 with `candidates` means the fuzzy match hit more than one slug. Show the user the candidates and ask which they meant. Don't guess.

**Reference ambiguous.** "orders" could be the commerce-api `orders` reference (the merchant-facing order management API) or `shopper-orders` (the shopper-facing one). If the user's question could belong to either, list both and ask. Don't default silently.

**Slug is a type, not an endpoint.** Type slugs are stored as `type:<Name>` and live under `types/`. If the user asks about a shape like "Order" or "Product", they usually mean the type -- query with `type:Order`. If unclear whether they want the *endpoint* `getOrders` or the *type* `Order`, ask.

**User said "Summary"** or asked for "the endpoint" without naming one. Summary.json is the reference overview, not an endpoint. Read `_index.json`, pick a verb-shaped slug (starts with `get/create/update/delete/search/list`), and confirm with the user before answering for a specific one.

## When NOT to invoke

- "Scrape this URL" / "get me all the endpoints in X" -> that's `dsc-scrape`, not this.
- Atlas books (URLs with `atlas.` and `.htm`) -> decline, same reasoning as `dsc-scrape`.
- MuleSoft docs (docs.mulesoft.com) -> decline.
- Guides, concept pages, release notes -> decline. This skill only reads the structured output of `/references/` pages.
- "Compare the response body of X and Y" -> you *can* do this by running `query.js` twice, but lean on the JSON -- don't invent comparisons beyond what the files support.

## Key invariants

- Every answer cites the file path. The user should always be able to open the JSON and verify.
- Never fabricate a scope, param, or response. If the file doesn't have the field the user asked about, say "the spec doesn't declare that" and point at the file.
- Default to the smallest useful `--field`. Don't dump the full endpoint JSON unless the user asked to see everything.
- Cache is per-machine, not per-project. Don't scrape into project-local paths unless the user explicitly specifies one.

## Bundled scripts

- `scripts/query.js` -- resolve slug, extract field, print digest. Exit codes: 0 found, 2 reference-not-cached, 3 slug-not-found-or-ambiguous.
- `scripts/list.js` -- list cached references, or list slugs within a cached reference (optional `--grep` filter).

Both scripts use only Node built-ins. No install needed.
