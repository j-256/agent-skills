# claude-code-skills

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) skills -- mostly for working against Salesforce developer documentation, plus a couple of domain-agnostic ones for paste-and-run demo authoring and the GitHub fork-and-PR flow.

## What's in here

A typical question against the Salesforce API references at developer.salesforce.com -- "which scopes does this endpoint need", "why is this 415ing", "what do I need to call before `createOrder`" -- means a five-to-thirty-minute round trip through rendered HTML, embedded `refList` JSON attributes, four different spec formats (OAS 3 YAML, RAML/AMF JSON, Swagger 2, ReDoc), and the engineer's own pattern-recognition. The skills in this repo collapse those round-trips, every answer cited to a public URL the engineer can forward downstream:

| Skill | Solves |
|---|---|
| [`dsc-scenario`](skills/dsc-scenario/) | "What's the chain of calls I need to reach this target operation?" -- walks the type graph from the target back through every prerequisite call, routes an auth flow from the target's identity (SLAS / Account Manager / OCAPI Shop / OCAPI Data), threads IDs through the chain, and emits a runnable bash block. |
| [`dsc-scrape`](skills/dsc-scrape/) | "Give me the structured JSON for this reference (or this whole product area)." Fetch-based scraper -- handles OpenAPI 3 (YAML), RAML (AMF JSON), Swagger 2 (OCAPI), and ReDoc through one pipeline. Unified envelope across all four parsers. |
| [`dsc-endpoint-help`](skills/dsc-endpoint-help/) | "What does this one endpoint require, and why is my request failing against it?" -- spec-field lookups (scopes, params, body, response, auth) and failing-request diagnosis (cURL + error body together: scope diff, content-type diff, JWT decode, OCAPI version drift). One skill, two output shapes selected by a runtime branch on the prompt's input shape. |
| [`stepped-demo-script`](skills/stepped-demo-script/) | "Write me a self-contained bash script I can paste into a terminal that walks me through a multi-step demo -- pausing between steps, asserting outcomes." Five-primitive alphabet (`announce`, `section`, `expect`, `pause`, `_jq`) inlined into every script; no sourced helper, no install step for the reader. Domain-agnostic. |
| [`fork-and-pr`](skills/fork-and-pr/) | "Walk me through forking a GitHub repo I don't own and opening a PR back to upstream." Codifies the `gh` + `git` syntax for the standard fork-and-PR flow across four starting states, with a deliberate pause for your edits between branch creation and push. Domain-agnostic. |

The three `dsc-*` skills share a scrape library at `skills/_shared/scrape/` and an on-disk cache at `~/.cache/dsc-scrape/`, so warming the cache from one benefits the others. They're independent at runtime -- you install whichever you need.

[Skills](https://docs.claude.com/en/docs/claude-code/skills) are self-contained capability packages that Claude Code discovers and invokes on demand. Each directory under [`skills/`](skills/) is one skill -- its own `SKILL.md`, supporting scripts, tests, and documentation.

## Why the auth answers hold up

The auth routing in `dsc-scenario` and `dsc-endpoint-help` isn't derived from the machine-readable specs -- it's derived from a live B2C Commerce sandbox, by minting each token type and calling each plane. That distinction is load-bearing: on B2C Commerce **a spec's `security[]` array describes intent, not enforced behavior** -- proven three independent ways (an OCAPI endpoint that lists `client_id` as sufficient yet 401s without a shopper token; a read/write tier boundary that isn't in the array at all; a control-plane API that declares SLAS-admin roles but actually enforces a different one). Three things follow:

- **Runtime-verified, not spec-guessed.** The gotchas a spec won't tell you are encoded and emitted: the Account Manager token host is `account.demandware.com` (the `.net` variant doesn't resolve); its scope needs the `:<tenant>` suffix or the call 403s; OCAPI's create-body payment card wants `masked_number` and rejects a raw `number`; the Business Manager User Grant is a distinct auth tier minted from the *instance* (not Account Manager) with a three-part Basic header. Each is an afternoon an engineer doesn't lose.
- **Deterministic, least-privilege auth.** The skill emits the *lightest sufficient* auth tier for the target -- never under-auth (which fails), never over-auth (a read-only product lookup does not get a full SLAS PKCE flow). Branch, tier, token URL, and request shape are all metadata rendered verbatim; the model chooses nothing, so the same target always yields the same runnable.
- **Corrections that expire themselves.** A curated fact that *overrides* the spec is trusted more than the spec -- so a stale override would fail confidently, which is worse than declining. Each correction records the spec field it overrides and what that field said when it was written, and every run re-checks it. If the spec has since drifted, the skill surfaces "this correction predates a spec change -- re-verify" and stops applying the override, instead of silently shipping a wrong answer.

The full model -- four API planes, the OCAPI Shop three-tier ladder, the four OAuth grant types, and the traps that look one way from the spec and resolve the other -- is in [`docs/commerce-auth-matrix.md`](docs/commerce-auth-matrix.md), every claim traceable to a runtime observation.

## Picking a skill

For DSC questions, the verb usually tells you which fires:

| User says... | Skill |
|---|---|
| "what do I need to call before X" / "prereqs for X" | `dsc-scenario` |
| "chain of calls to reach / produce Y" | `dsc-scenario` |
| "scrape / mirror / fetch reference X" | `dsc-scrape` |
| "what scopes / params / body / response does X have" | `dsc-endpoint-help` |
| "what auth scheme is on X" / "what method is X" | `dsc-endpoint-help` |
| "why is this request failing" + a failing request + an error | `dsc-endpoint-help` |
| "what scope is missing" + an error body or decoded JWT | `dsc-endpoint-help` |

The synthesis skills warm the cache themselves on miss (via the shared scrape library) -- you rarely need to invoke `dsc-scrape` explicitly unless you want the raw JSON dump.

For the design rationale behind the three-skill DSC family (layers, boundaries, extension guidance) and the per-skill / per-family coverage matrix, see [`docs/dsc-skills.md`](docs/dsc-skills.md).

## Examples

Real prompts run against the skills, the answers verbatim from the `synthesis-eval.py` harness against the installed skills (and from the trigger-eval transcripts for `fork-and-pr`, where the skill's pause-mid-flow shape doesn't fit synthesis-eval -- see [`evals/fork-and-pr/iteration-synthesis-pause-mismatch.md`](evals/fork-and-pr/iteration-synthesis-pause-mismatch.md)). Two are inlined below for cold readers; four more live under [`docs/examples/`](docs/examples/) -- see the catalog at the end of this section.

### `dsc-scenario`: "what do I need to call before createOrder"

Prompt:

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from? give me a concrete plan with cURL i can run.

Answer (condensed -- the plan is 7 numbered steps (with SLAS as step 1, two-leg) plus a paste-and-run bash block; the full version is in the transcript):

> ## Scenario: Guest shopper creates an order from a basket
>
> **Target:** `POST /organizations/{organizationId}/orders` -- `shopper-orders.createOrder`
> **References involved:** `auth` (Shopper Login / SLAS), `shopper-baskets`, `shopper-orders`
> **Combined scopes required:** `sfcc.shopper-baskets-orders.rw` (covers both APIs)
>
> The spec states: *"The only considered value from the request body is `basketId`."* So the entire prerequisite chain is about building a basket that's ready to submit.
>
> 1. Obtain a shopper access token from the `auth` reference (Shopper Login / SLAS) -- `authorizeCustomer` + `getAccessToken`. See [Shopper Login (SLAS) reference](https://developer.salesforce.com/docs/commerce/commerce-api/references/auth).
> 2. `shopper-baskets.createBasket` -> produces `basketId`.
> 3. `shopper-baskets.addItemToBasket` <- `basketId`.
> 4. `shopper-baskets.updateBillingAddressForBasket`.
> 5. `shopper-baskets.updateShippingMethodForShipment` (use `getShippingMethodsForShipment` to discover IDs first).
> 6. `shopper-baskets.addPaymentInstrumentToBasket`.
> 7. `shopper-orders.createOrder` <- `{"basketId": "<from step 2>"}`.
>
> ## Run it
>
> ```bash
> #!/usr/bin/env bash
> set -euo pipefail
>
> # Placeholders: BASE_URL, SHORT_CODE, ORG_ID, SITE_ID, ACCESS_TOKEN,
> #               PRODUCT_ID, SHIPPING_ID -- set before running.
> API="https://${SHORT_CODE}.api.commercecloud.salesforce.com"
>
> # --- Step 2: Create basket ---
> BASKET=$(curl -sS -X POST \
>   "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
>   -H "Authorization: Bearer ${ACCESS_TOKEN}" \
>   -H "Content-Type: application/json" \
>   -d '{"customerInfo": {"email": "shopper@example.com"}}')
> BASKET_ID=$(echo "$BASKET" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).basketId))")
>
> # --- Step 3: Add a product ---
> curl -sS -X POST \
>   "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
>   -H "Authorization: Bearer ${ACCESS_TOKEN}" \
>   -H "Content-Type: application/json" \
>   -d "[{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 1}]"
>
> # ... (steps 4-6: billing address, shipping method, payment instrument)
>
> # --- Step 7: Create order ---
> curl -sS -X POST \
>   "${API}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
>   -H "Authorization: Bearer ${ACCESS_TOKEN}" \
>   -H "Content-Type: application/json" \
>   -d "{\"basketId\": \"${BASKET_ID}\"}"
> ```
>
> ## Sources
>
> *(eight `developer.salesforce.com/docs/commerce/commerce-api/references/...?meta=...` URLs, one per step plus the shopper-baskets Summary -- elided here; full list in the transcript)*

The skill traced the prerequisite chain by walking the type graph: `createOrder`'s spec body schema declares `basketId` as the load-bearing input, so the planner recursed into `shopper-baskets` to find what produces a `basketId` (`createBasket`), then expanded the basket setup into the spec-required fields (billing address, shipping method, payment instrument) for a basket to be checkout-ready. The bash block threads `${BASKET_ID}` through every downstream call. SLAS shows up as one of the references involved (`auth`, page title "Shopper Login (SLAS)") -- the planner integrates `authorizeCustomer` + `getAccessToken` as the first two steps when the cache is warm, so the access token's origin is visible in the same plan list rather than handed off as a precondition the user has to satisfy themselves.

Full answer: [`docs/examples/scenario-createorder-prereqs.md`](docs/examples/scenario-createorder-prereqs.md).

### `dsc-endpoint-help`: "what scope is the JWT missing"

Prompt:

> this is failing on a customer's instance. their getCustomer call is 403ing -- here's the request, response, and the bearer JWT they're sending. can you decode the scopes from the token and tell me what's missing for shopper-customers getCustomer?
>
> request:
> ```
> curl -X GET 'https://zzrf-001.dx.commercecloud.salesforce.com/checkout/shopper-customers/v1/organizations/f_ecom_zzrf_001/customers/abc12345' \
>   -H 'Authorization: Bearer eyJ2ZXIiOiIxLjAiLCJqa3UiOiJzbGFzL3Byb2QvenpyZl8wMDEi...<truncated>...signature'
> ```
>
> response: HTTP 403
> body: `{"type":"/error-types/insufficient-scope-error","title":"Insufficient Scope"}`
>
> which scope do they need to add?

Answer:

> ## Diagnosis
>
> The token's scopes are completely wrong for this call. It was issued for baskets/orders (`sfcc.shopper-baskets.rw`, `sfcc.shopper-orders`) -- none of those cover `getCustomer`. The spec requires one of: `sfcc.shopper-myaccount`, `sfcc.shopper-myaccount.rw`, or `sfcc.shopper-standard`. The customer needs to re-request a token with at least `sfcc.shopper-myaccount` (read-only access is sufficient for `getCustomer`). There's also a separate shape issue -- `siteId` is a required query param and it's missing from the request entirely.
>
> Confidence: **high** -- scopes decoded directly from the JWT `scp` claim.
>
> ## Diff
>
> ### Scopes
> - Required: `sfcc.shopper-myaccount`, `sfcc.shopper-myaccount.rw`, `sfcc.shopper-standard` (any one)
> - Provided: `sfcc.shopper-baskets.rw`, `sfcc.shopper-orders`
> - Missing: all three required scopes
>
> ### Request shape
> - `siteId` query param is required but absent -- add `?siteId=<site-id>` to the URL
>
> ## Sources
> - https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-customers?meta=getCustomer

The scope diff isn't the model eyeballing the token -- the bundled `decode-token.js` script base64url-decodes the JWT payload and pulls `scp`, then `triage.js` cross-references that against the spec's `securityRequirements` for `getCustomer` and emits a structured `insufficient-scope` finding. The "Provided / Required / Missing" three-list shape comes straight from the script's output; the prose layer renders it. The model also caught a *second*, unrelated problem -- `siteId` is a required query parameter and was absent -- because the same triage pass also runs the spec's required-parameter check against the cURL. The 403 was masking what would have surfaced as a 400 next; the answer flags both fixes. Same machinery handles content-type mismatches (415s), wrong HTTP methods, OCAPI version drift, and missing required body fields, with a hands-off branch for failures the spec can't explain (5xx, 404 resource-missing, 409 conflicts).

Full answer: [`docs/examples/diff-jwt-scope-decode.md`](docs/examples/diff-jwt-scope-decode.md).

### More examples

| Skill | Scenario | Worked example |
|---|---|---|
| `dsc-scenario` | Registered shopper adds promo coupon and checks out (multi-reference plan with SLAS, scope union, runnable cURL) | [`docs/examples/scenario-add-coupon-checkout.md`](docs/examples/scenario-add-coupon-checkout.md) |
| `dsc-scenario` | OCAPI-native guest basket submit (single-call populated basket + order, `payment_card.masked_number`, client_id floor) | [`docs/examples/scenario-ocapi-submit-basket.md`](docs/examples/scenario-ocapi-submit-basket.md) |
| `dsc-scenario` | Prerequisites of a single in-reference op (`addPaymentInstrumentToBasket`); producer choice point picks `createBasket`, and the skill emits the op's runtime-required payment body deterministically | [`docs/examples/scenario-inreference-prereq.md`](docs/examples/scenario-inreference-prereq.md) |
| `dsc-scrape` | Catalog-miss alias-cascade trace for an unindexed product | [`docs/examples/scrape-agentforce-references.md`](docs/examples/scrape-agentforce-references.md) |
| `stepped-demo-script` | Demo that `find -delete` is silent and prompt-free, in a self-cleaning workspace | [`docs/examples/demo-find-delete-no-prompt.md`](docs/examples/demo-find-delete-no-prompt.md) |
| `fork-and-pr` | The standard fork-and-PR flow on GitHub -- `gh repo fork`, branch, push, PR | [`docs/examples/fork-and-pr-standard-flow.md`](docs/examples/fork-and-pr-standard-flow.md) |

## Install

Claude Code discovers skills from `~/.claude/skills/<skill-name>/`. To install a skill from this repo, symlink its directory in:

```bash
git clone <repo-url>
cd claude-code-skills
ln -s "$PWD/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
ln -s "$PWD/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
ln -s "$PWD/skills/stepped-demo-script" ~/.claude/skills/stepped-demo-script
ln -s "$PWD/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
```

**Note:** skills in this repo share utilities via `skills/_shared/`, which each skill references through a relative `lib -> ../_shared/` symlink committed to the repo. Clone the whole repo (as above) rather than copying a single skill directory -- cherry-picking one skill dir will break its `lib/` symlink. No `npm install` or build step is needed: the shared scrape library vendors its one dependency (a YAML parser) under `skills/_shared/vendor/`.

Copying instead of symlinking also works, but you lose the ability to pull updates with `git pull`.

Each skill has its own `README.md` covering prerequisites (Node version, external tools, MCP servers, etc.) and usage. Check the skill's README before first use.

## Eval harness

The eval harness lives in [`stream-eval`](<stream-eval-url>), consumed here as a git submodule mounted at `harness/`. It was built because `skill-creator:run_eval.py` produces misleading numbers on this machine (registers skills as UUID-suffixed slash commands that don't reach the `Skill` tool).

First-time setup:

```bash
git submodule update --init harness
python3 -m venv .venv && source .venv/bin/activate
pip install -e ./harness
```

Quick start:

```bash
# trigger-eval: did the right skill fire?
stream-eval trigger \
    --skill-path skills/dsc-endpoint-help \
    --eval evals/dsc-endpoint-help/trigger-eval.json \
    --runs 3 --workers 4 \
    --out evals/dsc-endpoint-help/runs/iteration-N/results.json

# synthesis-eval: did the answer hold up to typed assertions?
stream-eval synthesis \
    --skill-path skills/dsc-scrape \
    --eval evals/dsc-scrape/synthesis-eval.json \
    --runs 5 --workers 4 \
    --out evals/dsc-scrape/runs/iteration-N/results.json

# live HTML dashboard at http://localhost:8765
stream-eval monitor serve --open
```

See [`harness/README.md`](harness/README.md) for the full architecture, fixture schemas, exit codes, profile semantics, and dashboard reference.

## License

[MIT](LICENSE).
