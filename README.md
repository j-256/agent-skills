# claude-code-skills

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) skills -- mostly for working against Salesforce developer documentation, plus a couple of domain-agnostic ones for paste-and-run demo authoring and the GitHub fork-and-PR flow.

## What's in here

A typical question against the Salesforce API references at developer.salesforce.com -- "which scopes does this endpoint need", "why is this 415ing", "what do I need to call before `createOrder`" -- means a five-to-thirty-minute round trip through rendered HTML, embedded `refList` JSON attributes, four different spec formats (OAS 3 YAML, RAML/AMF JSON, Swagger 2, ReDoc), and the engineer's own pattern-recognition. The skills in this repo collapse those round-trips, every answer cited to a public URL the engineer can forward downstream:

| Skill | Solves |
|---|---|
| [`dsc-endpoint-help`](skills/dsc-endpoint-help/) | "What does this one endpoint require, and why is my request failing against it?" -- spec-field lookups (scopes, params, body, response, auth) and failing-request diagnosis (cURL + error body together: scope diff, content-type diff, JWT decode, OCAPI version drift). One skill, two output shapes selected by a runtime branch on the prompt's input shape. |
| [`dsc-scenario`](skills/dsc-scenario/) | "What's the chain of calls I need to reach this target operation?" -- walks the type graph from the target back through every prerequisite call, picks an auth flow from the spec (SLAS / Account Manager / OCAPI multi-scheme), threads IDs through the chain, and emits a runnable bash block. |
| [`dsc-scrape`](skills/dsc-scrape/) | "Give me the structured JSON for this reference (or this whole product area)." Fetch-based scraper -- handles OpenAPI 3 (YAML), RAML (AMF JSON), Swagger 2 (OCAPI), and ReDoc through one pipeline. Unified envelope across all four parsers. |
| [`stepped-demo-script`](skills/stepped-demo-script/) | "Write me a self-contained bash script I can paste into a terminal that walks me through a multi-step demo -- pausing between steps, asserting outcomes." Five-primitive alphabet (`announce`, `section`, `expect`, `pause`, `_jq`) inlined into every script; no sourced helper, no install step for the reader. Domain-agnostic. |
| [`fork-and-pr`](skills/fork-and-pr/) | "Walk me through forking a GitHub repo I don't own and opening a PR back to upstream." Codifies the `gh` + `git` syntax for the standard fork-and-PR flow across four starting states, with a deliberate pause for your edits between branch creation and push. Domain-agnostic. |

The three `dsc-*` skills share a scrape library at `skills/_shared/scrape/` and an on-disk cache at `~/.cache/dsc-scrape/`, so warming the cache from one benefits the others. They're independent at runtime -- you install whichever you need.

[Skills](https://docs.claude.com/en/docs/claude-code/skills) are self-contained capability packages that Claude Code discovers and invokes on demand. Each directory under [`skills/`](skills/) is one skill -- its own `SKILL.md`, supporting scripts, tests, and documentation.

## Picking a skill

For DSC questions, the verb usually tells you which fires:

| User says... | Skill |
|---|---|
| "what scopes / params / body / response does X have" | `dsc-endpoint-help` |
| "what auth scheme is on X" / "what method is X" | `dsc-endpoint-help` |
| "why is this request failing" + a failing request + an error | `dsc-endpoint-help` |
| "what scope is missing" + an error body or decoded JWT | `dsc-endpoint-help` |
| "what do I need to call before X" / "prereqs for X" | `dsc-scenario` |
| "chain of calls to reach / produce Y" | `dsc-scenario` |
| "scrape / mirror / fetch reference X" | `dsc-scrape` |

The synthesis skills warm the cache themselves on miss (via the shared scrape library) -- you rarely need to invoke `dsc-scrape` explicitly unless you want the raw JSON dump.

For the design rationale behind the three-skill DSC family (layers, boundaries, extension guidance) and the per-skill / per-family coverage matrix, see [`docs/dsc-skills.md`](docs/dsc-skills.md).

## Examples

Real prompts run against the skills, the answers verbatim from the `synthesis-eval.py` harness against the installed skills (and from the trigger-eval transcripts for `fork-and-pr`, where the skill's pause-mid-flow shape doesn't fit synthesis-eval -- see [`evals/fork-and-pr/iteration-synthesis-pause-mismatch.md`](evals/fork-and-pr/iteration-synthesis-pause-mismatch.md)). Two are inlined below for cold readers; four more live under [`docs/examples/`](docs/examples/) -- see the catalog at the end of this section.

### `dsc-endpoint-help`: "why is this 415ing"

Prompt:

> customer's checkout integration is returning 415 from shopper-baskets on createBasket. here's the exact request and response:
>
> ```
> curl -X POST 'https://zzrf-001.dx.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/f_ecom_zzrf_001/baskets?siteId=RefArch' \
>   -H 'Authorization: Bearer eyJ2ZXIi...' \
>   -H 'Content-Type: text/plain' \
>   -d '{"currency":"USD"}'
> ```
>
> response: HTTP 415
> body: `{"type":"/error-types/unsupported-media-type","title":"Unsupported Media Type","detail":"The Content-Type header value 'text/plain' is not supported by this resource."}`
>
> what's wrong here? diff against the spec.

Answer:

> ## Diagnosis
>
> The 415 is caused by a wrong `Content-Type` header. The spec requires `application/json` for `createBasket`'s request body; the integration is sending `text/plain`. The fix is a one-header change: replace `-H 'Content-Type: text/plain'` with `-H 'Content-Type: application/json'`.
>
> ## Diff
>
> ### Request shape
> - **Content-Type mismatch** -- sent `text/plain`, spec requires `application/json`
>
> ## Sources
> - https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket

The "spec requires `application/json`" claim isn't the model reading it off the error body -- the bundled triage script returns a structured `wrong-content-type` finding with `expected: ["application/json"]` extracted from the spec's `requestBody.content` and `actual: "text/plain"` from the customer's header. The prose layer renders that. Same machinery handles missing scopes (decoding the JWT in the `Authorization` header), missing required body fields, wrong HTTP method, and OCAPI version drift, with a hands-off branch for failures the spec can't explain (5xx, 404 resource-missing, 409 conflicts).

Full answer: [`docs/examples/diff-content-type-415.md`](docs/examples/diff-content-type-415.md).

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

### More examples

| Skill | Scenario | Worked example |
|---|---|---|
| `dsc-scrape` | Catalog-miss alias-cascade trace for an unindexed product | [`docs/examples/scrape-agentforce-references.md`](docs/examples/scrape-agentforce-references.md) |
| `dsc-scenario` | Registered shopper adds promo coupon and checks out (multi-reference plan with SLAS, scope union, runnable cURL) | [`docs/examples/scenario-add-coupon-checkout.md`](docs/examples/scenario-add-coupon-checkout.md) |
| `stepped-demo-script` | Demo that `find -delete` is silent and prompt-free, in a self-cleaning workspace | [`docs/examples/demo-find-delete-no-prompt.md`](docs/examples/demo-find-delete-no-prompt.md) |
| `fork-and-pr` | The standard fork-and-PR flow on GitHub -- `gh repo fork`, branch, push, PR | [`docs/examples/fork-and-pr-standard-flow.md`](docs/examples/fork-and-pr-standard-flow.md) |

## Install

Claude Code discovers skills from `~/.claude/skills/<skill-name>/`. To install a skill from this repo, symlink its directory in:

```bash
git clone <repo-url>
cd claude-code-skills
ln -s "$PWD/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
ln -s "$PWD/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
ln -s "$PWD/skills/stepped-demo-script" ~/.claude/skills/stepped-demo-script
ln -s "$PWD/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
```

**Note:** skills in this repo share utilities via `skills/_shared/`, which each skill references through a relative `lib -> ../_shared/` symlink committed to the repo. Clone the whole repo (as above) rather than copying a single skill directory -- cherry-picking one skill dir will break its `lib/` symlink.

Copying instead of symlinking also works, but you lose the ability to pull updates with `git pull`.

Each skill has its own `README.md` covering prerequisites (Node version, external tools, MCP servers, etc.) and usage. Check the skill's README before first use.

## Eval harness

This repo ships a working trigger-accuracy + synthesis-behavior eval harness with a live dashboard, used to validate the skills here. It works against any skill installed under `~/.claude/skills/` and can be lifted into other repos.

The harness was built because `skill-creator:run_eval.py` produces misleading numbers on this machine (registers skills as UUID-suffixed slash commands that don't reach the `Skill` tool). See [`tools/README.md`](tools/README.md) for the full architecture, fixture schemas, and dashboard documentation.

Quick start:

```bash
# trigger-eval: did the right skill fire?
python3 tools/trigger-eval.py \
    --eval evals/dsc-endpoint-help/trigger-eval.json \
    --skill-name dsc-endpoint-help \
    --runs 3 --workers 4 \
    --out evals/dsc-endpoint-help/runs/iteration-N/results.json

# synthesis-eval: did the answer hold up to typed assertions?
python3 tools/synthesis-eval.py \
    --eval evals/dsc-scrape/synthesis-eval.json \
    --runs 5 --workers 4 \
    --out evals/dsc-scrape/runs/iteration-N/results.json

# live HTML dashboard at http://localhost:8765
python3 tools/eval-monitor.py serve --open
```

## License

[MIT](LICENSE).
