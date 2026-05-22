# dsc-endpoint-help

Claude Code skill that answers questions about a Salesforce API endpoint against its public spec on developer.salesforce.com ("DSC"). It has two output shapes, picked at runtime: a **lookup branch** that quotes the relevant spec field on a single endpoint, and a **diff branch** that takes a failing request + error body and explains why the call doesn't match the spec. Both surfaces cite a public `developer.salesforce.com` URL the user can forward to a customer.

The lookup and diff mechanisms are generic against any DSC reference [`dsc-scrape`](../dsc-scrape/) can deliver; see [`docs/dsc-skills.md`](../../docs/dsc-skills.md) for what's verified today and where the gaps are. Companion to [`dsc-scrape`](../dsc-scrape/) (the data-layer fetcher) and [`dsc-scenario`](../dsc-scenario/) (the multi-call planner).

## What it does

**Lookup branch.** A user asks *"which scopes do I need to call shopper-products getProducts?"* and gets back:

> `getProducts`'s spec lists `sfcc.shopper-products` and `sfcc.shopper-standard` under the `ShopperToken` scheme – either grants access. `sfcc.shopper-standard` is a meta-scope that bundles the common shopper feature scopes (including `sfcc.shopper-products`), so a token with `shopper-standard` covers `getProducts` already; see https://developer.salesforce.com/docs/commerce/commerce-api/guide/standard-shopper-scope.html.
>
> `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]`
>
> Source: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products?meta=getProducts

No trip to developer.salesforce.com, no CTRL-F through rendered HTML, no inline JSON dump. The answer is one or two paragraphs of prose with a public URL the user can open if they want the full spec.

**Diff branch.** A user pastes a `403 insufficient_scope` from a `POST /baskets/{id}/items` call against shopper-baskets and asks *"why is this failing?"* and gets back:

> ## Diagnosis
> The token presented carries `sfcc.shopper-products` but `addItemToBasket` requires the `sfcc.shopper-baskets` scope under the `ShopperToken` scheme; that's why the gateway returns `insufficient_scope`. Add `sfcc.shopper-baskets` (or use the `sfcc.shopper-standard` meta-scope) to the SLAS client's allowed scope list and re-mint the token. See https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket.
>
> Confidence: high – scopes decoded directly from the access token's `scp` claim.
>
> ## Diff
>
> ### Scopes
> - Required:  `sfcc.shopper-baskets`
> - Provided:  `sfcc.shopper-products`
> - Missing:   `sfcc.shopper-baskets`
>
> ### Request shape
> - OK
>
> ## Sources
> - https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket

Output is always cited to URLs a customer can open. No local paths.

## Why one merged skill

Up to the point where the spec field is fetched and quoted, the lookup branch and the diff branch are the same cognitive operation – read the spec, find the relevant field, ground the answer in a public URL. The diff branch is "do the lookup, then narrate the difference between what the spec says and what the user's request did." The two output shapes share everything except the final composition step. Splitting them into two skills with two descriptions reproduces a routing decision that doesn't exist at the cognitive level; merging them removes the decision and pushes lookup-vs-diff to a deterministic runtime branch inside the merged skill.

## Install

```bash
# Clone the whole claude-code-skills repo – don't cherry-pick a single dir,
# because dsc-endpoint-help's lib/ is a symlink to ../_shared/.
git clone https://github.com/j-256/claude-code-skills.git
ln -s "$PWD/claude-code-skills/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
```

See the repo-root [`README.md`](../../README.md) for the full install block covering all skills.

`dsc-endpoint-help` has zero npm dependencies – just Node built-ins.

## Usage – lookup branch

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

`query.js` exit codes:

- `0` – found, digest on stdout
- `2` – reference not cached (shouldn't happen in normal flow, since the shared scrape library is called first; indicates the scrape itself failed)
- `3` – slug not found or ambiguous; response includes `candidates[]` to show the user
- `1` – unexpected error

## Usage – diff branch

See [`SKILL.md`](SKILL.md) for the full invocation contract. Quick shape:

```bash
node ~/.claude/skills/dsc-endpoint-help/scripts/triage.js <<'EOF'
{
  "request": "curl -X POST 'https://...' -H 'Authorization: Bearer ...' ...",
  "errorResponse": { "status": 403, "body": { "error": "insufficient_scope" } },
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets"
}
EOF
```

Output is JSON: `{errorClass, scopeDiff, shapeDiff, confidence, sources, handsOff}`. The skill turns it into the `## Diagnosis / ## Diff / ## Sources` template above.

## Question → output mapping

The skill routes the user's question to the right output shape and (lookup branch) the right `--field` argument:

| User asks about... | Output / `--field` |
|---|---|
| When a failing request is attached (cURL + error body together) | diff branch (`triage.js`) |
| OAuth scopes / permissions | `security` |
| Query, path, or header parameters | `parameters` |
| Request body shape | `body` (plus `--resolve-refs` to inline the referenced type) |
| Response schema / what it returns | `responses` (plus `--resolve-refs`) |
| HTTP method, path, endpoint URL alone | `all` (header is included with every field) |
| Full endpoint dump | `all` or `raw` |

The lookup-branch digest strips verbose `examples` blocks by default – most questions don't need them and they're typically the biggest part of any endpoint JSON. Pass `--include-examples` to keep them.

## How it works

```
dsc-endpoint-help/
├── SKILL.md              agent-facing flow + branch trigger
├── README.md             this file
├── package.json          Node test harness config
├── lib -> ../_shared     shared scrape library (symlink)
├── scripts/
│   ├── query.js          (lookup) resolve slug, extract field, print digest
│   ├── list.js           (lookup) list cached references / slugs, optional --grep
│   ├── triage.js         (diff) classify error + diff request vs. spec
│   ├── classify.js       (diff) classify {status, body} into an error class
│   ├── decode-token.js   (diff) decode JWT scp claim, no signature verify
│   └── diff.js           (diff) mechanical diff of request vs. spec required fields
└── tests/                Node assert tests, all offline
```

The SKILL.md is the interesting part. It teaches Claude:

1. **How to read the user's prompt** – pick out the reference, the slug, what they want to know, and (for the diff branch) whether a request artifact + error artifact are both present.
2. **The runtime branch decision** – diff branch fires only when both a request and an error are attached; lookup branch fires otherwise. Boundary cases (cURL alone, error alone, status-without-body) all resolve to lookup.
3. **The cache-miss flow** – call `scrapeRefresh` first against the reference root, run `query.js` (or `triage.js` for diff branch) against the now-current cache.
4. **The 404 flow** – when a reference-root scrape returns 404, fall back to the discovery cascade: scrape `/docs/apis` for `_catalog.json`, then the matching product's area landing for `_landing/<area>.json`, then the corrected reference root. No curl, no guessing variations one at a time.
5. **Answer format** – lookup branch is prose with grouped bullets for wide types and a public URL at the end; diff branch is the `## Diagnosis / ## Diff / ## Sources` template.

The answer format matters because the whole skill is built around "what does a developer actually want when they ask this question?" – usually a short, authoritative answer they can paste into a client config or ticket, not a reference dump.

## Cache location

`~/.cache/dsc-scrape/` by default – shared across projects, populated on first scrape, self-refreshing on a 1-hour TTL. Every query invokes the shared scrape library first; it owns the TTL and short-circuits with `refreshed: false` when the cache is fresh, so unchanged references cost a single `_index.json` read and zero network round-trips. A stale cache triggers a re-parse and rewrite before the answer is composed.

Override by passing a different root to the underlying scripts; the skill uses the default unless the user specifies otherwise. Force a refresh with `--force` on the underlying scrape, or change the TTL via the `DSC_CACHE_TTL_MS` env var.

The layout mirrors `dsc-scrape`'s output exactly:

```
~/.cache/dsc-scrape/
├── _catalog.json                    /docs/apis top-level product list
├── _landing/<area>.json             one per scraped area-landing
└── <area>/                          e.g. commerce_commerce-api, revenue_subscription-management
    └── <reference>/
        ├── _index.json              full slug list + title + siblings (fuzzy-match source)
        ├── Summary.json             overview prose
        ├── <operationId>.json       one per endpoint
        └── types/<TypeName>.json
```

Area-keying isolates references that share an id across product areas (e.g. SCAPI's `orders` vs. Subscription Management's `orders`); without it, the second scrape would silently overwrite or short-circuit on the first. `query.js` resolves the right area automatically (single match in `_landing/`, or scan area dirs); pass `--area <name>` to disambiguate when multiple areas carry the same ref id.

`dsc-endpoint-help` writes nothing on its own – all file writes go through the shared scrape library.

## Scope conjunction (a subtle but important correctness note)

OAS/AMF `security[]` has specific semantics that are easy to misread:

- Multiple entries in the array are **alternatives** (OR): *"authenticate via scheme A OR scheme B."*
- All scopes **within a single entry** are **required together** (AND): *"when using scheme A, you need all of these scopes."*

So `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]` means *"one ShopperToken, carrying both scopes."* It does **not** mean *"either scope works."* Getting this wrong will silently give the user a config that produces 403s at runtime. SKILL.md calls this out explicitly for that reason.

## Tests

```bash
cd ~/.claude/skills/dsc-endpoint-help && bash tests/run.sh
```

All tests run offline. Fixtures embed the spec slices they need.

## Limitations

- **Questions about non-endpoint concepts** (guide content, authentication setup, rate limits) aren't in the JSON the shared scrape library produces. The skill declines and points the user at the corresponding DSC guide page.
- **Very new references** not yet in DSC's catalog (e.g. right after a product launch) won't be scrapeable until DSC publishes the static spec file. No workaround.
- **Body/response schema answers depend on `--resolve-refs`**; the flag is bundled in `query.js`, so this is automatic, but a naive reading of the raw JSON would still show unresolved `$ref` strings. The skill is explicit about this in its field-mapping table.
- **Scope-array semantics require care** (see above).
- **Freshness is TTL-based, not push.** The default TTL is 1 hour, matching DSC's `cache-control: max-age=3600`. If DSC publishes a spec change mid-hour, your cached answer is up to 60 minutes behind. Pass `--force` to the shared scrape (or set `DSC_CACHE_TTL_MS=0`) to bypass the TTL for a single invocation.
- **Runtime-only errors hand off honestly.** When the diff branch can't classify the error against the spec (5xx, 404 path-or-resource-missing, 409 conflicts), `triage.js` returns `errorClass: 'UNKNOWN'` and the skill produces a short paragraph naming the likely runtime-state categories (session, replication, tenant config) and stops. No guessing.
