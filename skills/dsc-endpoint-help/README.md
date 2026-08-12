# dsc-endpoint-help

A Claude Code skill that answers questions about a Salesforce API endpoint against its public spec on developer.salesforce.com ("DSC") -- spec-field lookups (scopes, params, body, response) and failing-request diagnosis (cURL + error body together) -- with every claim cited to a public URL the user can forward downstream.

## What it does

- **Quotes the relevant spec field** for any one endpoint -- scopes, query/path/header parameters, request body schema, response schema, HTTP method, auth scheme. No CTRL-F through rendered HTML, no JSON dump.
- **Diffs a failing request against the spec** when a cURL + error body are pasted together. Names the root cause -- missing scope, wrong content-type, missing required body field, OCAPI version drift, JWT scope mismatch -- with confidence.
- **Routes lookup-vs-diff at runtime.** Both branches share everything up to the final composition step; the skill picks based on whether a failing request is attached, not which "skill" the user invoked.
- **Decodes the `Authorization: Bearer ...` JWT** for scope diffs. The provided scopes come from the token's `scp` claim, not from guessing -- so "missing X" is grounded.
- **Resolves OCAPI version drift.** When the live request hits `/v23_2/...` and the cached spec describes `/v25_6/...`, the resolver still matches and the answer surfaces both versions explicitly rather than silently picking one.
- **Hands off honestly on runtime errors the spec can't explain** -- 5xx, 404 path-or-resource-missing, 409 conflicts. Returns `errorClass: 'UNKNOWN'` and names the likely runtime-state categories (session, replication, tenant config) instead of guessing.
- **Cites a public DSC URL.** Every answer ends with `https://developer.salesforce.com/...` -- never a local cache path, never a skill file path.

## Not for

- **Multi-call repro plans** ("what do I need to call before X", "prereqs for createOrder"). That's [`dsc-scenario`](../dsc-scenario/) -- it walks the type graph for ordering and ID threading.
- **Scraping a reference wholesale.** That's [`dsc-scrape`](../dsc-scrape/) -- raw JSON dump.
- **Authoring a paste-and-run demo script.** That's [`stepped-demo-script`](../stepped-demo-script/).
- **Non-endpoint concepts** -- guide content, authentication setup walkthroughs, rate-limit policies, billing. Those aren't in the JSON the shared scrape library produces; the skill declines and points at the relevant DSC guide page.
- **Very new references** not yet in DSC's catalog (right after a product launch). The static spec file has to be published before the skill can answer.
- **Runtime-only errors** the spec doesn't describe (5xx, 404 path-or-resource-missing, 409 conflicts). The diff branch returns `errorClass: 'UNKNOWN'` and stops -- no guessing.

## Why you'd want this

A spec-field question -- "what scopes does `getProducts` need?" -- is a five-minute round trip without help: open developer.salesforce.com, navigate the reference, expand the operation, find the security block, copy the relevant scopes, paste somewhere shareable. Diffing a failing request is harder, because the relevant spec field isn't always the one whose name appears in the error message: a 415 with `Content-Type: text/plain` requires looking up the operation's `requestBody.content` map; a `403 insufficient_scope` requires decoding the JWT *and* reading the operation's `security[]` *and* understanding that an array entry's scopes are an OR-listed alternative set in practice (not the AND that OAS syntax says). Getting the diff right means assembling several spec fields plus the request artifact in one place.

The skill collapses both round-trips. For lookups, the answer is a paragraph of prose with a public URL the reader can forward to their downstream customer or paste into a ticket. For diffs, the answer is a structured `## Diagnosis / ## Diff / ## Sources` template -- the diagnosis is the actionable fix in plain English, the diff names the specific mismatch, and the sources are URLs.

The merged-skill design (one skill, two output shapes) is deliberate: up to the point where the spec field is fetched and quoted, lookup and diff are the same cognitive operation -- read the spec, find the relevant field, ground the answer in a public URL. Splitting them into two skills with two descriptions reproduces a routing decision that doesn't exist at the cognitive level. The merge pushes lookup-vs-diff to a deterministic runtime branch.

## Tested

Synthesis-eval covers 5 fixtures × 5 runs each on the diff branch -- the higher-stakes branch where the model has to assemble several spec fields against a request artifact:

| Fixture | What it guards |
|---|---|
| `synthesis-diff-insufficient-scope-shopper-baskets` | cURL + `insufficient_scope` body together must produce a scope diff naming the missing scope and citing the public DSC URL |
| `synthesis-diff-content-type-415` | cURL + 415 + content-type mismatch must name `application/json` (from the spec's `requestBody.content`) vs. the request's `text/plain` |
| `synthesis-diff-jwt-scope-decode` | cURL + 403 + JWT in `Authorization` header must decode the `scp` claim and name the missing scope |
| `synthesis-diff-OCAPI-fault-envelope` | OCAPI's `{"fault": {...}}` envelope must classify (extends triage's classifier beyond `body.error.code`); version drift on basePath surfaces both versions |
| `synthesis-diff-hands-off-404-not-found` | A 404 path-or-resource-missing failure can't be diagnosed from the spec alone -- the answer must hand off, not guess |

Trigger-eval covers 33 positive + decline fixtures; the routing signal on completed runs is 100% (right skill fires every time) -- under-coverage on cold-cache regression fixtures is gateway-throttle artefact, not a routing miss. Iteration history at [`evals/dsc-endpoint-help/`](../../evals/dsc-endpoint-help/) documents the full per-run breakdown.

Plus offline unit tests under `tests/` covering `query.js`, `triage.js`, `classify.js`, `decode-token.js`, `diff.js`, and the resolve-slug fallback for OCAPI version drift.

## What it produces

**Lookup branch.** A user asks *"which scopes do I need to call shopper-products getProducts?"* and gets back:

> `getProducts`'s spec lists `sfcc.shopper-products` and `sfcc.shopper-standard` under the `ShopperToken` scheme -- either grants access. `sfcc.shopper-standard` is a meta-scope that bundles the common shopper feature scopes (including `sfcc.shopper-products`), so a token with `shopper-standard` covers `getProducts` already; see https://developer.salesforce.com/docs/commerce/commerce-api/guide/standard-shopper-scope.html.
>
> `security: [{ scheme: "ShopperToken", scopes: ["sfcc.shopper-products", "sfcc.shopper-standard"] }]`
>
> Source: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-products?meta=getProducts

**Diff branch.** A user pastes a `403 insufficient_scope` from a `POST /baskets/{id}/items` call against shopper-baskets and asks *"why is this failing?"* and gets back:

> ## Diagnosis
> The token presented carries `sfcc.shopper-products` but `addItemToBasket` requires the `sfcc.shopper-baskets` scope under the `ShopperToken` scheme; that's why the gateway returns `insufficient_scope`. Add `sfcc.shopper-baskets` (or use the `sfcc.shopper-standard` meta-scope) to the SLAS client's allowed scope list and re-mint the token. See https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket.
>
> Confidence: high -- scopes decoded directly from the access token's `scp` claim.
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

Output is always cited to URLs the reader can open. No local paths.

## Install

```bash
git clone <repo-url>
cd claude-code-skills
ln -s "$PWD/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
```

One npm dependency: `js-yaml`, declared in `skills/_shared/` and loaded by the shared scrape step this skill calls (via `scrapeRefresh`). Install it once with `npm install --prefix skills/_shared`. The skill's own `scripts/` use only Node built-ins. The `lib/` directory is a symlink to `skills/_shared/`, so cloning the whole repo is required (a single-skill copy will break the symlink).

See the repo-root [`README.md`](../../README.md) for the full install block covering all skills.

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

When invoked, the skill:

1. **Reads the prompt** -- pulls out the reference, the slug, what the user wants to know, and (for the diff branch) whether a request artifact + error artifact are both present.
2. **Picks the runtime branch.** Diff branch fires only when both a request and an error are attached; lookup branch fires otherwise. Boundary cases (cURL alone, error alone, status-without-body) all resolve to lookup.
3. **Warms the cache on miss.** Calls `scrapeRefresh` first against the reference root, runs `query.js` (or `triage.js` for diff branch) against the now-current cache.
4. **Cascades on 404.** When a reference-root scrape returns 404, falls back through `/docs/apis` -> `_landing/<area>.json` -> the corrected reference root. No curl, no guessing variations one at a time.
5. **Composes the answer.** Lookup branch is prose with grouped bullets for wide types and a public URL at the end; diff branch is the `## Diagnosis / ## Diff / ## Sources` template.

## Usage -- lookup branch

In conversation, ask the question. Claude invokes the skill, which calls the bundled scripts. Under the hood:

```bash
# Direct query (cache hit)
node scripts/query.js ~/.cache/dsc-scrape/ shopper-products getProducts --field security

# With ref resolution (for body/response questions)
node scripts/query.js ~/.cache/dsc-scrape/ shopper-products getProduct --field responses --resolve-refs

# List what's cached
node scripts/list.js ~/.cache/dsc-scrape/
node scripts/list.js ~/.cache/dsc-scrape/ shopper-products --grep search
```

`query.js` exit codes: `0` found, `2` reference not cached, `3` slug not found / ambiguous (response includes `candidates[]`), `1` unexpected error.

## Usage -- diff branch

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

## Question -> output mapping

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

The lookup-branch digest strips verbose `examples` blocks by default -- most questions don't need them and they're typically the biggest part of any endpoint JSON. Pass `--include-examples` to keep them.

## Cache location

`~/.cache/dsc-scrape/` by default -- shared across projects, populated on first scrape, self-refreshing on a 1-hour TTL. Every query invokes the shared scrape library first; it owns the TTL and short-circuits with `refreshed: false` when the cache is fresh, so unchanged references cost a single `_index.json` read and zero network round-trips. A stale cache triggers a re-parse and rewrite before the answer is composed.

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

`dsc-endpoint-help` writes nothing on its own -- all file writes go through the shared scrape library.

## Scope conjunction (a subtle but important correctness note)

OAS/AMF `security[]` syntax says all scopes within a single entry are required together (AND); multiple entries in the array are alternatives (OR). In practice this is almost universally ignored: public REST specs co-list scope alternatives in a single entry rather than producing multiple entries, and the consuming auth servers treat the co-list as OR. SCAPI follows the same convention -- shopper `["sfcc.shopper-products", "sfcc.shopper-standard"]` means either grants the call. Default reading: a co-listed scope set is OR unless you have specific evidence otherwise. Don't claim AND just because OAS syntax says AND. SKILL.md calls this out explicitly because getting it wrong silently produces 403 advice the user can't act on.

## Tests

```bash
cd ~/.claude/skills/dsc-endpoint-help && bash tests/run.sh
```

All tests offline. Fixtures embed the spec slices they need.

## Companion skills

- [`dsc-scrape`](../dsc-scrape/) -- the data-layer fetcher. Shares the on-disk cache (`~/.cache/dsc-scrape/`) and the same scrape library that this skill uses internally. Optional install -- `dsc-endpoint-help` warms the cache itself on miss.
- [`dsc-scenario`](../dsc-scenario/) -- the multi-call planner. Complementary skill: `dsc-endpoint-help` answers "what does this one endpoint require?", `dsc-scenario` answers "what's the chain to reach this endpoint?".

## Coverage and known gaps

See [`docs/dsc-skills.md`](../../docs/dsc-skills.md) for the per-family matrix. SCAPI, OCAPI, and selected non-Commerce families are eval-validated; coverage on guides, atlas books, and runtime-only errors (5xx, 409) is explicitly out of scope -- the skill hands off honestly rather than fabricating.
