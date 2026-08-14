---
name: dsc-endpoint-help
description: Look up a spec field on, or diff a failing request against, one named endpoint in a Salesforce API reference published on developer.salesforce.com ("DSC"). Invoke whenever the user's ask is about what one specific endpoint's spec says or why one specific call doesn't match it – OAuth scopes, query params, request body, response schema, auth scheme, HTTP method/path, or a cURL/HTTP request paired with an error body (`invalid_client`, `insufficient_scope`, `400 missing_parameter`, `401 AuthenticationFailedException`, `415` content-type, etc.). Covers spec-field lookups ("what scopes does shopper-products getProducts need?", "which query params does searchOrders take?", "what auth scheme guards createOrder?"), code-generation asks against a named endpoint ("write me a node script that calls getProduct" – quote the spec; don't write the code), how-to asks that are really spec-field questions ("how do I paginate searchOrders", "what limit does X accept"), and failing-request diagnosis ("why is this 403ing", "diff this against the spec", "what scope is missing"). This is the unified successor to `dsc-endpoint-lookup` and `dsc-triage`; prefer it whenever either of those would have fired – the runtime branches internally on whether a failing request is attached. Every claim cited to a public developer.salesforce.com URL. Works against any DSC reference `dsc-scrape` can deliver. Hands off honestly for errors the spec can't explain (5xx, 404 path-or-resource-missing, 409 conflicts). Decline when no endpoint field is in scope at all: concept or comparison questions without a named endpoint ("what's the difference between OCAPI and SCAPI", "what is SLAS"), parsing a user-supplied local file rather than a DSC reference ("parse my ~/work/foo.json"), scraping whole references wholesale (that's `dsc-scrape`), multi-call ordering / scenario-building (that's `dsc-scenario`), and guides / concept pages / atlas-format books / release notes. Also decline questions about what a separate runtime consumer of the response requires – Customer Service Center field dependencies, SFRA hook semantics, "which response fields can my custom hook null out without breaking X" – even when an endpoint is named; the spec describes the endpoint's own input/output, not what other runtimes downstream of the response do with it, so any spec-framed answer would be fabrication.
---

# DSC Endpoint Help

Answer one question about one endpoint in a Salesforce API reference on DSC – either by quoting the relevant spec field, or (when a failing request is attached) by diffing the request against the spec and naming the root cause. Every claim is backed by a public `developer.salesforce.com` URL the user can forward to a customer.

## When to use

**Lookup branch** (no failing request attached):

- A direct spec-field question about a named endpoint: "what scopes does shopper-products getProducts need", "which query params does searchOrders take", "what auth scheme guards createOrder".
- A code-generation ask that references a named endpoint: "write me a node script that calls getProduct" – quote the spec the user can write the code against; don't write the code.
- A how-to ask that's really a spec-field question in disguise: "how do I paginate search results", "what limit does X accept" – quote the relevant param.

**Diff branch** (a failing request is attached):

- A cURL command + an error body: "why is this 403ing", "what's wrong with this request".
- A request + an `insufficient_scope` / `invalid_client` / `unauthorized_client` envelope, optionally with a JWT to decode for the scope diff.
- A content-type / body-shape failure: "diff this against the spec", "is this 415 because content-type is wrong".

## Inputs from the user

The user's prompt usually contains some of:

- **A reference name** ("shopper-products", "orders", "scapi shopper baskets") – maybe abbreviated, maybe product-branded ("SCAPI Shopper Products" → `shopper-products`).
- **An operation identifier** ("getProducts", "createOrder", sometimes partial: "the products get endpoint", "that getCustomer call").
- **A concrete spec-field question** (lookup branch): what scopes, what params, what body, what response, what method/path, what auth scheme.
- **A request artifact** (diff branch): cURL, raw HTTP, or `{method + URL}`. Required for the diff branch.
- **An error response** (diff branch): `{status, body}`. Required for the diff branch. Body can be JSON or prose.
- **An access token (JWT)** (diff branch, optional): if provided (or embedded in the request's `Authorization: Bearer` header), the skill decodes the `scp` claim for a high-confidence scope diff.
- **Registered client scopes** (diff branch, optional): if the user has the list from their SLAS/OAuth client config, pass it instead (confidence: medium, with a disclaimer).
- **Reference URL** (diff branch): the developer.salesforce.com URL of the reference containing this endpoint. Usually inferrable from the request path (`/checkout/shopper-baskets/...` → `https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets`). If the path is ambiguous, ask.

Sometimes one of these is missing. See "Disambiguation" below.

## Choosing the output shape

The diff branch fires when **both** of these conditions hold; the lookup branch fires otherwise.

1. **Request artifact present.** A cURL command, a raw HTTP request line/block, or a `{method, url, body?}` shaped paste. Detection cues: `curl ` followed by a URL; HTTP request-line pattern (`<METHOD> <path> HTTP/`); an explicit `Authorization:` / `x-dw-client-id:` / similar request-shaped header line.
2. **Error artifact present.** A 4xx or 5xx status code in proximity to the request artifact (`returns 403`, `403ing`, `status: 401`); a recognized error body / fault envelope (SCAPI's `{"error": "..."}` shape, OCAPI's `{"fault": {"type": "...", ...}}` shape, OAuth's `invalid_client` / `insufficient_scope` / `unauthorized_client` strings); or explicit failure framing tied to the request (`why is this failing`, `what's wrong`, `diff this against the spec`).

If both are present, the prompt is asking "why is this specific call broken" – diff branch (`triage.js`). If only one or neither is present, the prompt is asking a spec-field question (possibly with failure-themed phrasing) – lookup branch (`query.js`).

### Boundary cases this resolves cleanly

| Input shape | Branch | Why |
|---|---|---|
| Bare spec-field Q (`"what scopes does X need"`) | lookup | No request, no error |
| cURL pasted, no error mentioned | lookup | Request present, but no failure to diff against |
| Error body / status alone, no request | lookup | Failure-themed, but nothing to compare against |
| cURL + error body together | diff | Both signals present |
| `getCustomer 403 + JWT decode` | diff | cURL implied, JWT-decode is the diff |
| `createBasket 400 missing_parameter` (status only, no body) | lookup-with-nudge | Spec-field framing dominates; brief mention that the 400 likely indicates a required field, paste the body for a real diff |
| `B2C job webhook silently dropping events` (decline) | declined | No endpoint, no request – falls into the decline list |

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

## Lookup branch flow

1. **Pick reference + slug** from the user's question. If either is missing or ambiguous, disambiguate (see below) before running anything.
2. **Always refresh first.** Run `scrapeRefresh` (from `lib/common/scrape-refresh.js`) against the reference root before querying. The shared scrape library owns a 1-hour TTL matching DSC's upstream `cache-control: max-age=3600`, so when the cache is fresh this costs one `_index.json` read and zero network round-trips. The returned summary has `refreshed: true` (new data fetched) or `refreshed: false` (cache already fresh).
3. **Query locally** by running `scripts/query.js`. If it exits 0, you have the data. If exit 3 (slug not found / ambiguous), use the returned `candidates` to confirm with the user or narrow.
4. **Write the answer in prose**, quoting only the field the user asked about, and cite the public DSC URL – the `url` field in the JSON returned by `query.js`. Never cite the local cache path in your output. (If the user explicitly asks "where's the local copy?", read the absolute path from `query.js`'s `file` field on demand; don't volunteer it.)

### Step 1: Resolve reference + slug

The user's question may name a reference directly ("shopper-products getProducts"), name it under a brand or rebrand ("SCAPI products" → `shopper-products`; "Data Cloud" → Data 360), or leave it implicit ("how do I paginate searches" – which search?). Resolve to a concrete `<reference>/<slug>` pair before any other step.

**Default discovery path: bootstrap via the shared scrape library.** When the reference name isn't already concrete in your context, call `scrapeRefresh` against `https://developer.salesforce.com/docs/apis` first. This writes `~/.cache/dsc-scrape/_catalog.json` listing every product DSC publishes, with each product's `referenceUrl`, a `referenceShape` tag (`area-landing` / `reference-root` / `atlas` / `static-html` / `unknown` – only the first two are scrapeable), and a `searchKeys` array (acronyms drawn from the product's landing titles plus hand-curated entries like "SCAPI"). Match the user's hint case-insensitive substring against `title`, `body`, AND `searchKeys` – the third surface is what makes acronyms like "OCI" or "MIAW" resolve cold-cache without relying on the model's training data. Once a product is picked, scrape its `referenceUrl` (a product-area landing) to get `_landing/<product>_<area>.json`, which lists every reference in that area with its `id`, `title`, and `referenceType` (`rest-oa3` / `rest-raml` / `rest-oa2` are scrapeable; `markdown` isn't). Read these files to anchor your slug pick to ground truth instead of guessing. Both list-only modes share the 1-hour TTL with reference scrapes – once `_catalog.json` exists locally, follow-on discovery in this session is free.

**Shortcut: skip the catalog scrape only if the reference name is already concrete.** If the user explicitly named a Commerce SCAPI reference ("shopper-products", "shopper-baskets", "orders") or one you've already cached this session, you can scrape its reference root directly without going through the catalog. The 1-hour TTL absorbs the cost if you're wrong about cache state.

You can list what's already on disk via `node scripts/list.js ~/.cache/dsc-scrape/` to skip a redundant catalog scrape.

Common name drifts to anchor against the catalog/landing:

| User says | Reference slug |
|---|---|
| "Shopper Products", "SCAPI products", "the products API" | `shopper-products` |
| "Orders API", "SCAPI orders" | `orders` (merchant-facing, under commerce-api) **or** `shopper-orders` (shopper-facing) – different references |
| "Customer Groups" | the operations live in `customers`, not `customer-groups` |
| "Data Cloud X", "Data 360 X" | Data 360 references (Salesforce rebranded) |

The **slug** is typically the `operationId` (`getProducts`, `createOrder`). Fuzzy matching is built in – `query.js` will resolve "products" against the index if there's exactly one match.

### Step 2: Refresh the cache

Use `lib/common/scrape-refresh.js` to warm the cache before every query. The helper owns the subprocess dance, calls into the shared scrape library at `lib/scrape/scrape.js`, and returns a normalized `{refreshed, reference, format, specUrl, files, cacheRoot}` object. When the cache is still within its 1-hour TTL, `scrapeRefresh` returns `refreshed: false` without fetching – calling it unconditionally is effectively free.

```js
const { scrapeRefresh } = require('./lib/common/scrape-refresh.js');

const result = await scrapeRefresh({
  referenceUrl: 'https://developer.salesforce.com/docs/<product>/<area>/references/<reference>',
  // scrapeScript defaults to lib/scrape/scrape.js (resolved via require.resolve)
  // cacheRoot defaults to ~/.cache/dsc-scrape
});
```

Scraping the **reference root** (no `?meta=`) writes the whole reference in one pass – Summary + every endpoint + every type + `_index.json`. Do this even if the user only asked about one endpoint. The network cost is identical: the scraper downloads a single static spec file that already contains every operation, and writing one slug vs. all of them is just a parse-time decision. Upsides of the whole-reference scrape:

1. **Slug safety** – if the user's slug guess was slightly off, `_index.json` lets you correct it without a second fetch.
2. **Future cache hits** – any later question about any other endpoint in this reference is free.
3. **Type resolution works** – `--resolve-refs` reads `types/<TypeName>.json`. Those files only exist if the whole reference was scraped.
4. **TTL is cheap.**

Only scrape a single slug (`?meta=<slug>`) if the user explicitly asked for just that one to land on disk.

**If the scrape exits 1 with a 404 on a reference root** (your shortcut path was wrong – misspelled, rebranded, or not in that product area), fall back to the same cascade Step 1 describes: scrape `/docs/apis` for `_catalog.json`, then the product's `referenceUrl` for `_landing/<area>.json`, then the corrected reference root. Don't guess variations by re-scraping them one at a time.

A few products have `/references/` pages but don't appear in the `/docs/apis` catalog – if the catalog has no match for a product the user named, lowercase the user's hint and substring-match it against the keys in `lib/scrape/aliases.js` (the `CATALOG_MISSING_ALIASES` map) for the area-landing URL. Only ask the user for a DSC URL if neither catalog nor alias map resolves the hint.

If `referenceType` is anything other than `rest-oa3`, `rest-raml`, or `rest-oa2` (for example `markdown`), the reference isn't a machine-readable spec the scrape library can deliver – tell the user and stop.

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

**Freshness preamble:** If `scrapeRefresh` returned `refreshed: true` *and* there was a prior cache (i.e. this wasn't a first-ever scrape), open with a single short sentence: *"I refreshed the cache first – the upstream spec had changed."* Then answer. If `refreshed: false`, or if this was the first scrape of this reference, skip the preamble and go straight to the answer. You can tell it's a first-ever scrape if `_index.json` didn't exist before your `scrapeRefresh` call.

**Format guidance – this matters because answers are read in a terminal:**

- Use **prose + bullets**. Skip markdown tables – they render fine in a rendered preview but look like walls of `|` characters in the raw terminal most users are actually reading. Bullets degrade gracefully.
- Use **one-line JSON-ish quotes** (`security: [{ scheme: "X", scopes: [...] }]`) for shape, not full pretty-printed blocks. The user can open the cited file if they want the full thing.
- **Group related fields** when a type is wide (e.g. a Product response with 45 fields). "Scalars: ..., Pricing: ..., Merchandising: ..." beats an alphabetical dump.
- **No hedging preamble.** Don't open with "Based on the cached JSON, I can tell you that..." – just answer.
- **Cite the `url` field** from `query.js`'s structured output at the end, not inline mid-sentence. Never cite the local cache path.

**Example: "what scopes does shopper-products getProducts need?"**

> `getProducts`'s spec lists `sfcc.shopper-products` and `sfcc.shopper-standard` under the `ShopperToken` scheme – either grants access. `sfcc.shopper-standard` is a meta-scope that bundles the common shopper feature scopes (including `sfcc.shopper-products`), so a token with `shopper-standard` covers `getProducts` already; see https://developer.salesforce.com/docs/commerce/commerce-api/guide/standard-shopper-scope.html.
>
> `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]`
>
> Source: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products?meta=getProducts

**Note on `security[]` semantics in practice.** OAS says all scopes within a single `security[]` entry are required together (AND); multiple entries in the array are alternatives (OR). In practice this is almost universally ignored: public REST specs co-list scope alternatives in a single entry rather than producing multiple entries, and the consuming auth servers treat the co-list as OR. Slack's canonical OpenAPI spec, for example, co-lists `chat:write:user` and `chat:write:bot` on `chat.postMessage` (https://github.com/slackapi/slack-api-specs/blob/master/web-api/slack_web_openapi_v2.json), and per https://api.slack.com/methods/chat.postMessage those are alternative token types that can't both be present – AND is impossible. SCAPI follows the same convention: merchant `["sfcc.products", "sfcc.products.rw"]` on a GET means either grants the read; shopper `["sfcc.shopper-products", "sfcc.shopper-standard"]` means either grants the call (shopper-standard is a meta-scope, not a co-required umbrella). Default reading: a co-listed scope set is OR unless you have specific evidence otherwise (a runtime test that fails with one scope missing, or an explicit doc statement that both are required). Don't claim AND just because OAS syntax says AND.

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

## Diff branch flow

Invoke `scripts/triage.js`, piping a JSON payload into stdin:

```bash
node ~/.claude/skills/dsc-endpoint-help/scripts/triage.js <<'EOF'
{
  "request": "<cURL | raw HTTP | {method,url} pair>",
  "errorResponse": { "status": 403, "body": { "error": "insufficient_scope" } },
  "providedScopes": { "source": "clientList", "scopes": ["sfcc.shopper-products"] },
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets",
  "cacheRoot": "/Users/<you>/.cache/dsc-scrape"
}
EOF
```

Defaults: `cacheRoot` defaults to `~/.cache/dsc-scrape`, `scrapeScript` defaults to `lib/scrape/scrape.js` (resolved via `require.resolve`, ships with the skill via `lib -> ../_shared`). Omit them unless you need to override.

`triage.js` prints a JSON object on stdout with:
- `errorClass` – one of `AUTH_MISSING_SCOPE`, `AUTH_INVALID_CLIENT`, `AUTH_INVALID_TOKEN`, `AUTH_UNAUTHORIZED`, `REQUEST_MISSING_REQUIRED`, `REQUEST_WRONG_TYPE`, `REQUEST_BAD_SHAPE`, `UNKNOWN`.
- `handsOff` – `true` when `errorClass === 'UNKNOWN'`. The spec can't explain this class of error – do **not** compose a Diagnosis / Diff / Sources block, do **not** enumerate runtime causes 1/2/3 even if you can think of plausible ones. Skip the "Output composition" template entirely and follow the **hand-off shape** described below (under "When `handsOff === true`").
- `scopeDiff` – `{required, provided, providedSource, missing}`.
- `shapeDiff` – array of `{kind, ...}` findings. Kinds: `method-mismatch`, `query-missing-required`, `header-missing-required`, `wrong-content-type` (fields `expected` (array of accepted media types per the spec), `actual` (the request's `Content-Type` header) – quote the accepted set verbatim in the answer), `body-missing-required`, `body-wrong-type`, `body-malformed-json`, `version-mismatch` (OCAPI: live URL hits a different API version than the cached spec describes – fields `liveVersion`, `specVersion`).
- `confidence` – `high | medium | low`.
- `sources` – list of public DSC URLs. **Cite only these URLs** in your reply. Never mention the local cache path.

### Output composition

**Check `handsOff` first.** If `triage.js` returned `handsOff: true`, jump to the hand-off section below – this template does not apply. Composing a Diagnosis / Diff / Sources block on a hand-off case is the failure mode this skill exists to prevent.

Write a short prose diagnosis naming the root cause and the fix, followed by a structured Diff section quoting the relevant fields, followed by a Sources section listing the public URLs from `sources[]`. Template:

```
## Diagnosis
<One paragraph: what's failing, why, and what to change. Cite the DSC URL inline.>

Confidence: <high | medium | low> – <reason based on providedSource>.

## Diff

### Scopes
- Required:  <list>
- Provided:  <list>
- Missing:   <list>

### Request shape
- <one line per shapeDiff finding, or "OK" if empty>

## Sources
- <url 1>
- <url 2>
```

When `providedSource === 'clientList'`, always include this disclaimer after the prose:

> Registered client scopes are not the same as scopes actually in the access token. If the token is available, rerun with it for a definitive answer.

When `handsOff === true`, the spec-grounded reasoning ends. Do not write a Diff section, a confident diagnosis, a Confidence rating, a Sources section, or a numbered list of runtime causes – even if you can think of plausible ones. Write three or four sentences in the **exemplar shape** below, cite the endpoint's `developer.salesforce.com` URL, and stop.

**Forbidden phrasings when `handsOff: true`:**

- "Based on the spec, here are the likely causes", "in order of probability", "most likely", "Most likely cause:" – the spec does not rank runtime causes.
- "Token belongs to a different shopper", "wrong `siteId`", "wrong hostname" presented as a fix – these are runtime claims dressed as spec-derivable.
- "The platform returns 404 when…" / "The runtime applies the same check…" – behavioral claims about the runtime, not the spec.
- Numbered cause enumerations (`1.` / `2.` / `3.`) under a "Diagnosis" header – they signal spec-grounded ranking the spec does not support.

**Exemplar shape** (three or four sentences; vary specifics for the actual error):

> The spec can't explain this 404. `getOrder`'s request shape is spec-compliant – `organizationId`, `orderNo`, and `siteId` are all present, and the 404 body (`/error-types/order-not-found`) is a runtime response the spec only describes as "the order with the given order number is unknown." This is outside what the spec alone can diagnose; check the instance's session, site assignment, and order ownership – `dsc-endpoint-help` hands off here.
>
> Spec reference: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=getOrder

If you find yourself writing "the most likely cause is…" or numbering runtime causes 1/2/3, stop – the honest answer is "spec can't explain this," not a ranked list of plausible-sounding guesses. Naming categories inline ("session, site assignment, order ownership") is fine; ranking them as causes is not.

## Disambiguation

**Slug ambiguous.** `query.js` exit 3 with `candidates` means the fuzzy match hit more than one slug. Show the user the candidates and ask which they meant. Don't guess.

**Reference ambiguous.** "orders" could be the commerce-api `orders` reference (the merchant-facing order management API) or `shopper-orders` (the shopper-facing one). If the user's question could belong to either, list both and ask. Don't default silently.

**Slug is a type, not an endpoint.** Type slugs are stored as `type:<Name>` and live under `types/`. If the user asks about a shape like "Order" or "Product", they usually mean the type – query with `type:Order`. If unclear whether they want the *endpoint* `getOrders` or the *type* `Order`, ask.

**User said "Summary"** or asked for "the endpoint" without naming one. Summary.json is the reference overview, not an endpoint. Read `_index.json`, pick a verb-shaped slug (starts with `get/create/update/delete/search/list`), and confirm with the user before answering for a specific one.

## What this skill doesn't do

- **No runtime calls.** Doesn't hit the customer's instance, doesn't introspect tokens against SLAS, doesn't fetch anything beyond what the shared scrape library does.
- **No fix proposals for `UNKNOWN`.** Hands off – the diff branch produces a short paragraph saying the error class is outside what the spec can explain, and stops.
- **No parsing of non-spec error envelopes** (WAF, CDN, raw HTML) – classified as `UNKNOWN` and handed off.
- **No local cache paths in output.** Cite the public DSC URLs from `query.js`'s `url` field or `triage.js`'s `sources[]` only.
- **No multi-call ordering.** "What do I need to call before createOrder" is `dsc-scenario`, not this.
- **No whole-reference scrape output.** "Scrape this URL and give me all the endpoints" is `dsc-scrape`, not this.
- **No guides, concept pages, atlas-format books, or release notes.** Decline – this skill only reads the structured output of `/references/` pages.
- **No runtime-consumer field dependencies.** "What does Customer Service Center require from product_search's response", "which fields can my custom hook null out without breaking SFRA", "what does the storefront read from this payload" – the spec describes the endpoint's input/output, not what other runtimes downstream of the response do with it. An endpoint name appearing in the question doesn't make this answerable; producing a spec-framed list of "fields runtime X depends on" would be fabrication. Decline and tell the user this is a runtime-debugging question, not a spec question – they need to instrument the consumer (CSC, SFRA, the storefront) to see what it actually reads, or ask the team that owns it.

  **The carving trap.** Questions in this shape often LOOK partly answerable from the spec ("what does the response schema say is required?"). Resist running a spec lookup and stitching the result into a runtime-consumer answer. If you quote `required: [refinements, ...]` from the spec and present it next to the customer's observation that "removing `refinements` breaks CSC search," the composed answer reads as "the spec says CSC needs refinements" – which is exactly the fabrication this rule exists to prevent. The spec saying a field is `required` means the API guarantees emitting it; it does not mean any specific consumer requires it. If the question is principally about which fields a downstream runtime depends on, decline wholesale – do not run any lookup, do not produce a partial spec quote, do not compose a "here's what we can say from the spec" preamble. The instinct to be helpful by carving the question into a spec-answerable subset is the failure mode.

## Prerequisites

- `~/.cache/dsc-scrape/` exists and is writable.
- Node.js. The shared scrape library (`lib/scrape/`) ships with this skill via the `lib -> ../_shared` symlink – no separate skill install needed.

## Bundled scripts

- `scripts/query.js` – resolve slug, extract field, print digest. Exit codes: 0 found, 2 reference-not-cached, 3 slug-not-found-or-ambiguous. (Lookup branch.)
- `scripts/list.js` – list cached references, or list slugs within a cached reference (optional `--grep` filter). (Lookup branch helper.)
- `scripts/triage.js` – diff a failing request against the spec; emits structured `{errorClass, scopeDiff, shapeDiff, confidence, sources}` JSON. (Diff branch.)
- `scripts/classify.js` – classify a `{status, body}` error response into an error class. Used internally by `triage.js`. (Diff branch.)
- `scripts/decode-token.js` – decode a JWT's `scp` claim without verifying signature; used to populate the scope diff. (Diff branch.)
- `scripts/diff.js` – mechanical diff of a request vs. spec required fields/types. Used internally by `triage.js`. (Diff branch.)

All scripts use only Node built-ins. The shared scrape library in `skills/_shared/` (reached via the `lib/` symlink) vendors its one dependency (a YAML parser), so no install step is needed.

## Key invariants

- **All DSC fetches go through the shared scrape library** (via `scrapeRefresh`). Never use `curl`, `WebFetch`, or any other client to read a `developer.salesforce.com` URL – not for discovery, not for verification, not for "just one quick check." The cascade in the lookup-branch flow above (`/docs/apis` → area landing → reference root → single slug) covers every shape with shared TTL caching. Both branches share the same fetch path. Reaching for curl is a sign you're solving a problem the library already owns.
- **Cite the public DSC URL** in every answer – the `url` field returned by `query.js` (lookup branch) or the entries in `triage.js`'s `sources[]` (diff branch). The user should always be able to open the URL and verify. Never cite the local cache path.
- **Never fabricate a scope, param, or response.** If the spec doesn't declare the field the user asked about, say "the spec doesn't declare that" and point at the file. The diff branch hands off when the error class is `UNKNOWN`; the lookup branch quotes the spec verbatim or says nothing.
- **Default to the smallest useful field/branch.** Lookup branch uses the smallest useful `--field`; diff branch fires only when both a request and an error artifact are present. Don't dump the full endpoint JSON unless the user asked to see everything; don't run `triage.js` on a bare spec-field question.
- **Cache is per-machine, not per-project.** Don't scrape into project-local paths unless the user explicitly specifies one.
