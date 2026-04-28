# dsc-query

Claude Code skill that answers **one specific question** about a Salesforce DSC API endpoint -- OAuth scopes, query params, request body, response schema, auth scheme, HTTP method/path -- by reading the JSON that [`dsc-scrape`](../dsc-scrape/) produces. Claude loads [`SKILL.md`](./SKILL.md) via the `Skill` tool when a matching user request arrives, then runs bundled Node scripts (`scripts/query.js`, `scripts/list.js`) directly and, on cache misses, invokes `dsc-scrape`'s `scripts/scrape.js` by file path -- *not* via the `Skill` tool -- to populate the cache before answering.

## What it does

A user asks *"which scopes do I need to call shopper-products getProducts?"* and gets back:

> `getProducts` needs the `sfcc.shopper-products` **and** `sfcc.shopper-standard` scopes (both required) via the `ShopperToken` OAuth scheme.
>
> Source: `~/.cache/dsc-scrape/shopper-products/getProducts.json`

No trip to developer.salesforce.com, no CTRL-F through rendered HTML, no inline JSON dump. The answer is one or two paragraphs of prose with a file path the user can open if they want the full spec.

## Why not just use dsc-scrape alone?

You can — `dsc-scrape` writes the same JSON files `dsc-query` reads. But for question-answering they solve different problems:

| | `dsc-scrape` alone | `dsc-scrape` + `dsc-query` |
|---|---|---|
| **User says** | "scrape shopper-products and give me the JSON" | "what scopes does getProducts need?" |
| **Claude does** | fetches, parses, writes JSON files, points user at filesystem | same fetch *if* not cached, then extracts the one field that matters, returns prose |
| **What the user has to do** | open the right JSON, find the right section, interpret the shape | nothing -- just read the answer |
| **Answer format** | file paths + "here's what I wrote" | direct prose: *"two scopes: A and B, both required, via ShopperToken"* |
| **Handles `--resolve-refs`?** | writes `schemaRef: "#/components/schemas/Product"`, user follows the chain | inlines the referenced type automatically for response/body questions |
| **Cache-aware?** | needs an explicit `<out>` arg every time | keeps a shared cache at `~/.cache/dsc-scrape/`, scrapes only on miss |
| **Disambiguates fuzzy slugs?** | no -- unknown slug = error | yes -- fuzzy-matches against `_index.json`, asks when multiple candidates |

Short version: `dsc-scrape` is the bulk data tool. `dsc-query` is the question-answering tool on top of it.

They're **cleanly separable**. Install only `dsc-scrape` if you want raw JSON and will read it yourself. Install both if you want Claude to answer natural-language questions about DSC endpoints.

## Installation

Prereqs: Node 22+ (current Active LTS), plus [`dsc-scrape`](../dsc-scrape/) installed at `~/.claude/skills/dsc-scrape/` -- this skill invokes its `scripts/scrape.js` directly on cache misses.

```bash
cd ~/.claude/skills
ln -s /path/to/this/repo/skills/dsc-query dsc-query
```

`dsc-query` has zero npm dependencies -- just Node built-ins.

## Usage

Via Claude, you just ask. Claude invokes the skill, which calls the bundled helper scripts. Under the hood:

```bash
# Direct query (cache hit)
node scripts/query.js ~/.cache/dsc-scrape/ shopper-products getProducts --field security

# With ref resolution (for body/response questions)
node scripts/query.js ~/.cache/dsc-scrape/ shopper-products getProduct --field responses --resolve-refs

# List what's cached
node scripts/list.js ~/.cache/dsc-scrape/
node scripts/list.js ~/.cache/dsc-scrape/ shopper-products --grep search
```

Exit codes signal where to go next:

- `0` -- found, digest on stdout
- `2` -- reference not cached; skill invokes `dsc-scrape` and retries
- `3` -- slug not found or ambiguous; response includes `candidates[]` to show the user
- `1` -- unexpected error

## Example: walking through a real question

User asks: *"What does shopper-products getProduct actually return on a 200 response? Give me the real fields, not just a type name."*

**Step 1 -- cache check.**

```
node scripts/query.js ~/.cache/dsc-scrape/ shopper-products getProduct --field responses --resolve-refs
```

If `shopper-products` isn't cached yet, `query.js` exits 2. The skill then:

**Step 2 -- scrape** (only if cache missed):

```
node ~/.claude/skills/dsc-scrape/scripts/scrape.js \
  "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products" \
  ~/.cache/dsc-scrape/
```

This writes the whole reference (~45 endpoints + ~60 types) in one pass. Every future question about any shopper-products endpoint is now a cache hit.

**Step 3 -- retry the query.** With `--resolve-refs`, the tool follows `schemaRef: "#/components/schemas/Product"` into `types/Product.json` and inlines the type. One script call, no hand-traversal.

**Step 4 -- answer in prose.** Grouped bullets for a wide type:

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

Full spec is still on disk for verification.

## Question → field mapping

The skill routes the user's question to the right `--field` argument:

| User asks about... | `--field` |
|---|---|
| OAuth scopes / permissions | `security` |
| Query, path, or header parameters | `parameters` |
| Request body shape | `body` (plus `--resolve-refs` to inline the referenced type) |
| Response schema / what it returns | `responses` (plus `--resolve-refs`) |
| HTTP method, path, endpoint URL alone | `all` (header is included with every field) |
| Full endpoint dump | `all` or `raw` |

The digest strips verbose `examples` blocks by default -- most questions don't need them and they're typically the biggest part of any endpoint JSON. Pass `--include-examples` to keep them.

## How it works

`dsc-query` is small: two Node scripts, no dependencies.

```
dsc-query/
├── SKILL.md              agent-facing flow
├── README.md             this file
└── scripts/
    ├── query.js          resolve slug, extract field, print digest
    └── list.js           list cached references / slugs, with optional --grep
```

The SKILL.md is the interesting part. It teaches Claude:

1. **How to read the user's question** -- pick out the reference, the slug, and what they want to know
2. **The cache-miss flow** -- call `query.js`, if exit 2 then call `dsc-scrape` by file path (not via the Skill tool -- cheaper), always scrape the reference root (not a single slug, since the spec file is one request either way)
3. **The 404 flow** -- when `dsc-scrape` returns HTTP 404, the user's reference name is wrong; fetch any known-good reference page and extract the sibling list from its `reference-set-config` HTML attribute to find the right name
4. **Answer format** -- prose with grouped bullets for wide types, one-line JSON-ish quotes for shape, file path at the end. No markdown tables (they render as walls of `|` in most terminals)

The answer format matters because the whole skill is built around "what does a developer actually want when they ask this question?" -- usually a short, authoritative answer they can paste into a client config or ticket, not a reference dump.

## Scope conjunction (a subtle but important correctness note)

OAS/AMF `security[]` has specific semantics that are easy to misread:

- Multiple entries in the array are **alternatives** (OR): *"authenticate via scheme A OR scheme B."*
- All scopes **within a single entry** are **required together** (AND): *"when using scheme A, you need all of these scopes."*

So `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]` means *"one ShopperToken, carrying both scopes."* It does **not** mean *"either scope works."* Getting this wrong will silently give the user a config that produces 403s at runtime. SKILL.md calls this out explicitly for that reason.

## Cache location

`~/.cache/dsc-scrape/` by default -- shared across projects, populated on first scrape. Override by passing a different root to the underlying scripts; the skill uses the default unless the user specifies otherwise.

The layout mirrors `dsc-scrape`'s output exactly:

```
~/.cache/dsc-scrape/
└── <reference>/
    ├── _index.json          full slug list + title + siblings (fuzzy-match source)
    ├── Summary.json         overview prose
    ├── <operationId>.json   one per endpoint
    └── types/<TypeName>.json
```

`dsc-query` writes nothing on its own -- all file writes go through `dsc-scrape`.

## Limitations

- **Questions about non-endpoint concepts** (guide content, authentication setup, rate limits) aren't in the JSON `dsc-scrape` produces. The skill declines and points the user at the corresponding DSC guide page.
- **Very new references** not yet in DSC's catalog (e.g. right after a product launch) won't be scrapeable until DSC publishes the static spec file. No workaround.
- **Body/response schema answers depend on `--resolve-refs`**; the flag is bundled in `query.js`, so this is automatic, but a naive reading of the raw JSON would still show unresolved `$ref` strings. The skill is explicit about this in its field-mapping table.
- **Scope-array semantics require care** (see above).
