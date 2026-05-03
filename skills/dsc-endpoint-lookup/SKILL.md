---
name: dsc-endpoint-lookup
description: Look up and quote one spec field on one endpoint in a Salesforce API reference published on developer.salesforce.com ("DSC") – OAuth scopes, query params, request body, response schema, auth scheme, HTTP method/path – by reading JSON that `dsc-scrape` produced (or producing it on demand). Invoke whenever answering the user's ask requires knowing what one specific endpoint's spec says about one of those fields, even if the user's surface ask is broader: direct spec-field lookups ("what scopes does shopper-products getProducts need?", "which query params does searchOrders take?", "what auth scheme guards createOrder?"), code-generation asks that reference a named endpoint ("write me a node script that calls getProduct" – quote the spec for the user to write the code against; don't write the code yourself), and how-to asks that are really spec-field questions in disguise ("how do I paginate search results", "what limit does X accept" – quote the relevant param; ask which search endpoint if ambiguous). The reference name can be implicit if the endpoint name is unambiguous. Decline when no endpoint field is in scope at all: concept or comparison questions without a named endpoint ("what's the difference between OCAPI and SCAPI", "what is SLAS"), parsing a user-supplied local file rather than a DSC reference ("parse my ~/work/foo.json"), scraping whole references wholesale (that's `dsc-scrape`), and guides / concept pages / release notes.
---

# DSC Endpoint Lookup

Answer one targeted question about one endpoint in a Salesforce API reference on DSC, fast. The heavy lifting – fetching and parsing the spec – belongs to `dsc-scrape`. This skill's job is to (a) make sure the endpoint JSON exists locally, (b) pull out the specific field the user is asking about, and (c) answer in prose with the file path so the user can verify.

## Inputs from the user

The user's question usually contains:

- **A reference name** ("shopper-products", "orders", "scapi shopper baskets") – maybe abbreviated, maybe product-branded ("SCAPI Shopper Products" -> `shopper-products`).
- **An operation identifier** ("getProducts", "createOrder", sometimes partial: "the products get endpoint", "that getCustomer call").
- **A concrete question**: what scopes, what params, what body, what response, what method/path, what auth scheme.

Sometimes one of these is missing. See "Disambiguation" below.

## Cache location

Use `~/.cache/dsc-scrape/` as the cache root. Create it if it doesn't exist (scrape will create subdirs itself). This is shared across projects – scraping once benefits future sessions.

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
2. **Always refresh first.** Invoke `dsc-scrape` against the reference root before querying. `dsc-scrape` owns a 1-hour TTL matching DSC's upstream `cache-control: max-age=3600`, so when the cache is fresh this costs one `_index.json` read and zero network round-trips. Parse the stdout summary: `refreshed: true` means new data was fetched; `refreshed: false` means the cache was already fresh.
3. **Query locally** by running `scripts/query.js`. If it exits 0, you have the data. If exit 3 (slug not found / ambiguous), use the returned `candidates` to confirm with the user or narrow.
4. **Write the answer in prose**, quoting only the field the user asked about, and cite the public DSC URL – the `url` field in the JSON returned by `query.js`. Never cite the local cache path in your output. (If the user explicitly asks "where's the local copy?", derive the path from `~/.cache/dsc-scrape/<reference>/<slug>.json` on demand; don't volunteer it.)

### Step 1: Resolve reference + slug

Common name drifts you'll see:

| User says | Reference slug |
|---|---|
| "Shopper Products", "SCAPI products", "the products API" | `shopper-products` |
| "Orders API", "SCAPI orders" | `orders` (under commerce-api) or possibly `shopper-orders` (under commerce-api) – different references, different operations |
| "Customer Groups" | `customer-groups` |
| "Data Cloud X", "Data 360 X" | Data 360 references (Salesforce rebranded) |

If unsure, run `node scripts/list.js ~/.cache/dsc-scrape/` to see what's already cached. If the target reference isn't there, you'll need the full DSC URL to scrape – ask the user, or for common SCAPI references infer: `https://developer.salesforce.com/docs/commerce/commerce-api/references/<reference>`.

The **slug** is typically the `operationId` (`getProducts`, `createOrder`). Fuzzy matching is built in – `query.js` will resolve "products" against the index if there's exactly one match.

### Step 2: Refresh the cache

Use `lib/scrape-refresh.js` to invoke `dsc-scrape` before every query. The helper owns the subprocess dance and returns a normalized `{refreshed, reference, format, specUrl, files, cacheRoot}` object. When the cache is still within its 1-hour TTL, `dsc-scrape` returns `refreshed: false` without fetching – calling `scrapeRefresh` unconditionally is effectively free.

```js
const { scrapeRefresh } = require('./lib/scrape-refresh.js');

const result = await scrapeRefresh({
  referenceUrl: 'https://developer.salesforce.com/docs/<product>/<area>/references/<reference>',
  // scrapeScript defaults to ~/.claude/skills/dsc-scrape/scripts/scrape.js
  // cacheRoot defaults to ~/.cache/dsc-scrape
});
```

Scraping the **reference root** (no `?meta=`) writes the whole reference in one pass – Summary + every endpoint + every type + `_index.json`. Do this even if the user only asked about one endpoint. The network cost is identical: `dsc-scrape` downloads a single static spec file that already contains every operation, and writing one slug vs. all of them is just a parse-time decision. Upsides of the whole-reference scrape:

1. **Slug safety** – if the user's slug guess was slightly off, `_index.json` lets you correct it without a second fetch.
2. **Future cache hits** – any later question about any other endpoint in this reference is free.
3. **Type resolution works** – `--resolve-refs` reads `types/<TypeName>.json`. Those files only exist if the whole reference was scraped.
4. **TTL is cheap.**

Only scrape a single slug (`?meta=<slug>`) if the user explicitly asked for just that one to land on disk.

If `scrapeRefresh` throws `ScrapeInvocationError` with no `exitCode` (install missing), tell the user: "I need the `dsc-scrape` skill installed to fetch uncached references. Install it, or point me at an existing cache of scraped JSON." Don't try to fetch DSC pages via WebFetch/curl as a substitute.

**If the scrape exits 1 with a 404**, the reference slug the user gave you is wrong – misspelled, rebranded, or it doesn't exist under that product area at all. Don't guess variations by re-scraping them one at a time; that's slow and fragile.

Instead, grab the authoritative **refList** for the product area. Every DSC page under a product embeds the full refList in a `reference-set-config` HTML attribute – the same attribute `dsc-scrape` itself parses.

**Preferred: the catalog index** (`.../references`, no trailing slug) always carries the refList for that product area:

```bash
curl -s "https://developer.salesforce.com/docs/<product>/<area>/references" \
  | grep -oE "reference-set-config='[^']+'" | head -1
```

**Fallback: any known-good sibling reference page** (`.../references/<some-real-ref>`) carries the same attribute. Use this if you've already scraped one reference successfully for the same product area.

The JSON in that attribute has `refList[]` with `id`, `title`, `href`, `source` for every reference in the product area. Find the closest real name, tell the user what their guess should have been, and rescrape. Common drifts: "customer-groups" (operations actually live in `customers`), "baskets" (could be `shopper-baskets` or `baskets` depending on audience), anything where the user pluralized/singularized.

If you don't know even the product area (say the user said "Data Cloud X" and you're unsure whether that's under `data-360`, `cdp`, or something else), ask the user for a full DSC URL rather than guessing. A wrong reference name is a cheap user question; a cascade of guessed scrapes is not.

After a successful scrape, run `query.js`. If it can't find the slug, read `_index.json`'s slug list – the user's operation name may also be off (e.g. `searchCustomerGroups` plural vs. `searchCustomerGroup` singular).

### Step 3: Query locally

```bash
node <skill>/scripts/query.js ~/.cache/dsc-scrape/ <reference> <slug> [--field <name>]
```

Match the question to the right field – this keeps the output small and focused:

| User asks... | Use `--field` |
|---|---|
| "what scopes...", "what OAuth...", "which permissions..." | `security` |
| "what params...", "what query params...", "required params..." | `parameters` |
| "what's the request body", "what fields in the POST body" | `body` – add `--resolve-refs` |
| "what response schema", "what does it return", "what's the 200 response" | `responses` – add `--resolve-refs` |
| "HTTP method", "path", "endpoint URL" – any of these alone | `all` (the header is included with every field) |
| "show me the whole endpoint" | `all` or `raw` if they want the full JSON untouched |

**`--resolve-refs` matters a lot for `body` and `responses` questions.** Without it you get back `schemaRef: "#/components/schemas/Product"` and you'd have to read `types/Product.json` separately (and every type it nests) to get real fields. `--resolve-refs` inlines the referenced type in one call, so the user's question ("what does it return?") gets a direct answer from a single script run instead of a chain of file reads.

Examples are stripped by default (they can be huge). Pass `--include-examples` only if the user explicitly wants them.

### Step 4: Answer in prose

Lead with the direct answer, then show the evidence (one-line quote of the relevant JSON shape), then the file path. One or two paragraphs for most questions; grouped bullets when there are many related facts (e.g. long parameter list, wide response type).

**Freshness preamble:** If `dsc-scrape` returned `refreshed: true` *and* there was a prior cache (i.e. this wasn't a first-ever scrape), open with a single short sentence: *"I refreshed the cache first – the upstream spec had changed."* Then answer. If `refreshed: false`, or if this was the first scrape of this reference, skip the preamble and go straight to the answer. You can tell it's a first-ever scrape if `_index.json` didn't exist before your `dsc-scrape` call.

**Format guidance – this matters because answers are read in a terminal:**

- Use **prose + bullets**. Skip markdown tables – they render fine in a rendered preview but look like walls of `|` characters in the raw terminal most users are actually reading. Bullets degrade gracefully.
- Use **one-line JSON-ish quotes** (`security: [{ scheme: "X", scopes: [...] }]`) for shape, not full pretty-printed blocks. The user can open the cited file if they want the full thing.
- **Group related fields** when a type is wide (e.g. a Product response with 45 fields). "Scalars: ..., Pricing: ..., Merchandising: ..." beats an alphabetical dump.
- **No hedging preamble.** Don't open with "Based on the cached JSON, I can tell you that..." – just answer.
- **Cite the `url` field** from `query.js`'s structured output at the end, not inline mid-sentence. Never cite the local cache path.

**Example: "what scopes does shopper-products getProducts need?"**

> `getProducts` needs the `sfcc.shopper-products` **and** `sfcc.shopper-standard` scopes (both required, not either/or) via the `ShopperToken` OAuth scheme.
>
> `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]`
>
> Source: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products?meta=getProducts

**Note on OAS/AMF `security[]` semantics:** all scopes within a single entry are **required together** (AND). Multiple entries in the array are alternatives (OR). So `security: [{ scheme: X, scopes: [a, b] }]` means "scope a AND b required via X." Don't describe co-listed scopes as "one of" – that misreads the spec and will bite the user when their token fails with a 403.

**Example: "what query params does searchOrders take?"**

> `searchOrders` accepts these query params (all optional unless noted):
> - `siteId` (required) – site identifier
> - `q` – free-text search
> - `limit` / `offset` – pagination
>
> Source: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=searchOrders

**Example: "what does getProduct return on 200?"** (response-schema question – use `--field responses --resolve-refs` so you can name real fields)

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
> Source: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products?meta=getProduct (response type `Product`)

Stay terse. Do not dump the whole JSON unless the user asked for it.

## Disambiguation

**Slug ambiguous.** `query.js` exit 3 with `candidates` means the fuzzy match hit more than one slug. Show the user the candidates and ask which they meant. Don't guess.

**Reference ambiguous.** "orders" could be the commerce-api `orders` reference (the merchant-facing order management API) or `shopper-orders` (the shopper-facing one). If the user's question could belong to either, list both and ask. Don't default silently.

**Slug is a type, not an endpoint.** Type slugs are stored as `type:<Name>` and live under `types/`. If the user asks about a shape like "Order" or "Product", they usually mean the type – query with `type:Order`. If unclear whether they want the *endpoint* `getOrders` or the *type* `Order`, ask.

**User said "Summary"** or asked for "the endpoint" without naming one. Summary.json is the reference overview, not an endpoint. Read `_index.json`, pick a verb-shaped slug (starts with `get/create/update/delete/search/list`), and confirm with the user before answering for a specific one.

## When NOT to invoke

- "Scrape this URL" / "get me all the endpoints in X" -> that's `dsc-scrape`, not this.
- Atlas books (URLs with `atlas.` and `.htm`) -> decline, same reasoning as `dsc-scrape`.
- MuleSoft docs (docs.mulesoft.com) -> decline.
- Guides, concept pages, release notes -> decline. This skill only reads the structured output of `/references/` pages.
- "Compare the response body of X and Y" -> you *can* do this by running `query.js` twice, but lean on the JSON – don't invent comparisons beyond what the files support.

## Key invariants

- Every answer cites the file path. The user should always be able to open the JSON and verify.
- Never fabricate a scope, param, or response. If the file doesn't have the field the user asked about, say "the spec doesn't declare that" and point at the file.
- Default to the smallest useful `--field`. Don't dump the full endpoint JSON unless the user asked to see everything.
- Cache is per-machine, not per-project. Don't scrape into project-local paths unless the user explicitly specifies one.

## Bundled scripts

- `scripts/query.js` – resolve slug, extract field, print digest. Exit codes: 0 found, 2 reference-not-cached, 3 slug-not-found-or-ambiguous.
- `scripts/list.js` – list cached references, or list slugs within a cached reference (optional `--grep` filter).

Both scripts use only Node built-ins. No install needed.
