# dsc-scenario

A Claude Code skill that turns "I need to repro this Salesforce API workflow" into a runnable, paste-and-go shell script -- every step grounded in the spec, every URL forwardable downstream.

## What it does

- **Walks the type graph** from any target operation back through every prerequisite call -- recursively, until it hits primitives or auth material.
- **Routes auth from the spec.** Detects whether the target needs SLAS (Shopper Login), Account Manager, or none, and picks the right flow (guest + PKCE / registered-with-platform-IDP / federated / TSOB / AM client_credentials).
- **Computes a least-privilege scope set.** Dedupes the OR-listed `<scope>` / `<scope>.rw` alternatives the SCAPI specs declare, drops redundant entries across the plan, suggests `sfcc.shopper-standard` only when it's a strict superset of the actual needs.
- **Threads IDs through the chain.** Identifies which step's response produces the `basketId` / `customerId` / `shipmentId` etc. that the next step needs as input.
- **Emits a paste-and-run bash block** with placeholders for instance-specific values, plus prose plan with every step cited to a public `developer.salesforce.com` URL.
- **Defaults to minimal instance setup.** Guest + public client + PKCE -- two scriptable curls, no client secret, no IDP configuration, no browser redirect handling. The user can swap to registered or TSOB by saying so in the prompt.
- **Stays honest on non-Commerce families.** Composes plans for Marketing Cloud / Data 360 / FSC / etc. without fabricating auth steps for schemes the skill doesn't have flow logic for.

## Not for

- **Single-endpoint questions** ("what scopes does X need", "why is this 403ing"). That's [`dsc-endpoint-help`](../dsc-endpoint-help/) -- one endpoint, no ordering, faster.
- **Scraping a reference wholesale.** That's [`dsc-scrape`](../dsc-scrape/) -- raw JSON dump, no synthesis.
- **Authoring a paste-and-run demo script** the reader walks through interactively (announce / pause / expect). That's [`stepped-demo-script`](../stepped-demo-script/) -- this skill emits the *plan* of calls plus a bash block, not a stepped narration.
- **Running the plan against your instance.** Output is text; you execute it. The cURL block has placeholders (`BASE_URL`, `ORG_ID`, `SITE_ID`, `CLIENT_ID`) -- you fill them in.
- **Inventing ordering constraints.** If the type graph has no edge and the spec prose has no ordering statement, the plan emits the structural order and labels it as such -- it doesn't guess.

## Why you'd want this

Salesforce API references at developer.salesforce.com are machine-readable per endpoint, but you reproduce *flows*, not single endpoints. Going from one to the other is mechanical but tedious -- and surprisingly hard to get right the first time. You can crank out a runnable repro in 15-30 minutes for a flow you've seen before; for an unfamiliar flow, longer. This skill collapses that to seconds, and gets the parts that trip people up correct on the first attempt.

A reasonable assumption is that the spec covers everything. It doesn't. Three places it falls short, and what doing this manually actually costs:

**Auth routing isn't in the operation spec.** SCAPI Shopper specs declare `ShopperToken`, but *which SLAS flow* you should use depends on whether the user said "registered shopper" (`/oauth2/login` via `authenticateCustomer`) or named a specific IDP like Okta (`/oauth2/authorize` via `authorizeCustomer` with `hint=`) or said nothing (`hint=guest`, two-leg PKCE, no client secret). The spec lists endpoints but doesn't pick between them. SCAPI Admin endpoints declare `AmOAuth2`, which routes to **Account Manager** -- and AM is *deliberately* undocumented on developer.salesforce.com (no reference page, no "how to get a token" guide there); the canonical URL is `https://account.demandware.com/dwsso/oauth2/access_token`, hardcoded with a citation contract that prevents the model from inventing a fake DSC URL. OCAPI Shop endpoints declare *three* accepted schemes (`customers_auth`, `oauth2_application`, `client_id`) -- the skill picks SLAS as the migration-forward default while honoring the spec's flexibility.

**Scope output is over-permissive if you naively union.** SCAPI specs list both bare `<scope>` and `<scope>.rw` on read operations because either token would pass -- the spec is saying "these are alternatives," not "these are co-required." A naive Set union over every operation's `security[].scopes` produces output that tells the user to configure both, plus the meta-scope `sfcc.shopper-standard`, all redundantly. The skill applies a two-layer dedup: per-operation, prefer the bare scope when both are listed (least privilege within one call); cross-operation, drop the bare when `.rw` is independently in the union (the `.rw` covers reads anyway). `sfcc.shopper-standard` is suggested as an ergonomic alternative when the deduped set is a strict subset of its 20-scope expansion -- never as a replacement.

**The default setup uses the platform itself as the IDP -- and the spec doesn't make that obvious.** When a registered shopper logs in with credentials stored in B2C Commerce (the default setup -- no SSO, no Okta, no Auth0), there's a separate operation for it: `authenticateCustomer` (`POST /oauth2/login`). The federation operation `authorizeCustomer` (`GET /oauth2/authorize`) is for the other case -- where the instance has been explicitly wired up to an external IDP. Both are spec-correct; you pick based on whether federation is configured. The trap: AI assistants and casual readers tend to reach for `authorizeCustomer` for any "registered shopper" prompt, because it's the more spec-prominent shopper-auth endpoint and its description ("after authenticating against an identity provider (IDP)") sounds like the generic shopper-login path. For most instances -- where the SLAS Admin UI is empty under "IDPs" because no federation has been set up -- that produces a plan that doesn't match the customer's reality, and the customer correctly rejects it ("we don't have an IDP, why are you sending us through one?"). The skill defaults registered shoppers to `authenticateCustomer` and adds a one-line primer when relevant ("this is the right call for the default setup where B2C Commerce holds the shopper credentials; if your instance has custom IDP federation configured, swap to `authorizeCustomer` with `hint=<idp-name>` instead"). The distinction doesn't appear in any single spec page but is load-bearing.

### Curated corrections that expire themselves

Where a Salesforce spec's machine-readable declaration disagrees with what the platform actually enforces, `dsc-scenario` carries a curated correction – and every such correction records a snapshot of the exact spec field it overrides. On each run the skill re-checks that field against the freshly-scraped spec: if the spec still says what the correction was written against, the correction applies; if the spec has drifted, the skill flags the correction "re-verify" instead of asserting a stale override. A curated override is trusted more than the spec, so this is the difference between a correction that ages gracefully and one that fails confidently. The verifier is product-neutral (it lives in the shared auth layer); B2C Commerce is simply the first product to register corrections against it.

## Tested

The synthesis-eval carries ten fixtures, run strict on Sonnet (every run must pass every assertion, five runs each). Each fixture guards a specific regression class:

| Fixture | What it guards |
|---|---|
| `synthesis-scenario-add-coupon-checkout` | Multi-call SCAPI plan with coupon application, basket-id threading, scope union, full SLAS expansion |
| `synthesis-scenario-ocapi-submit-basket` | OCAPI multi-scheme target – verifies the 3-accepted-auth-paths handling, the OCAPI-native `customers/auth` shopper token, and the `masked_number` create-body payment shape |
| `synthesis-scenario-createorder-basketid-threading` | Cascade-order analysis (basketId producer-consumer relationship), guest-flow shape (`hint=guest` required), and the submittability-registry payment minimum |
| `synthesis-scenario-inreference-producer-pick` | In-reference producer choice point picks the canonical `createBasket`, not `transferBasket`/`mergeBasket` |
| `synthesis-scenario-registered-silent` | "Registered shopper" with NO IDP signal must default to platform-IDP (`authenticateCustomer`), not federation |
| `synthesis-scenario-registered-b2c-primed` | Explicit "no SSO / B2C credentials" routes the same as silent |
| `synthesis-scenario-registered-federated` | Explicit "Okta SSO" routes to federation (`authorizeCustomer` + `hint=`) |
| `synthesis-scenario-am-admin-orders` | SCAPI Admin (AM-routed); plan must cite the canonical AM URL with no DSC fabrication |
| `synthesis-scenario-ocapi-data-code-versions` | OCAPI Data routes to the AM app-token flow (not the Shop shopper token), on the `/dw/data` path |
| `synthesis-scenario-am-admin-corrected-gate` | Renders the ACTIVE auth-admin spec-correction: the enforced gate is the "Sandbox API User" role (CCDX_SBX_USER), NOT the SLAS_*_ADMIN roles the spec's `security[]` declares, cited to the admin-auth guide – and never inverts the claim |

The registered-flow triangle (silent / B2C-primed / federated) prevents a router from passing all three by always picking the same flow – each prompt-shape exercises a distinct routing decision. The AM-admin negative assertions prevent the model from inventing `developer.salesforce.com/.../account-manager` URLs for AM auth. The corrected-gate fixture is the model-facing companion to the deterministic drift coverage in `tests/test-compose.js`: the fixture asserts the ACTIVE correction renders (and never inverts) in the composed answer, while the test asserts a drifted anchor flips the same note to its re-verify state.

There's also a network-required test that fetches the live `sfcc.shopper-standard` guide page and asserts the bundled 20-scope snapshot still matches -- Salesforce shipping a new shopper scope catches CI loudly. Skips gracefully when the page is unreachable so transient outages don't break the suite.

See [`tests/`](tests/) for the test layout and [`evals/dsc-scenario/`](../../evals/dsc-scenario/) for the eval fixtures and per-iteration result notes.

## What it produces

For a target like `shopper-orders.createOrder`, with no flow signal in the prompt:

```text
## Scenario: Guest shopper creates an order from a basket

**Target:** POST /organizations/{organizationId}/orders -- shopper-orders.createOrder
**References involved:** auth (Shopper Login / SLAS), shopper-baskets, shopper-orders

**Combined SLAS client scopes required:**
  sfcc.shopper-baskets-orders.rw
Alternatively, configure your SLAS client with `sfcc.shopper-standard` -- a meta-scope that
expands to include this scope plus 19 others. Simpler setup, broader permissions.

## Plan

Step 1 -- Obtain a SLAS guest access token. (auth.authorizeCustomer + auth.getAccessToken)
  - 1a. GET /oauth2/authorize?hint=guest&...&code_challenge=... -> code
  - 1b. POST /oauth2/token grant_type=authorization_code_pkce -> access_token
  - Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
  - Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken

Step 2 -- Create a basket. (shopper-baskets.createBasket)
  - POST /organizations/{organizationId}/baskets
  - Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
  - Produces: basketId

[... steps 3-N ...]

Step N -- Submit the order. (shopper-orders.createOrder)
  - POST /organizations/{organizationId}/orders
  - Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
  - Body: { "basketId": "<from Step 2>" }
```

Followed by a paste-and-run bash block, with instance-specific placeholders (`BASE_URL`, `ORG_ID`, `SITE_ID`, `CLIENT_ID`) called out in a legend at the bottom.

Three complete worked examples checked into the repo as captured transcripts:
- [`docs/examples/scenario-createorder-prereqs.md`](../../docs/examples/scenario-createorder-prereqs.md) -- guest shopper, minimal instance setup
- [`docs/examples/scenario-add-coupon-checkout.md`](../../docs/examples/scenario-add-coupon-checkout.md) -- registered shopper, platform built-in IDP (the most common OOTB case)
- [`docs/examples/scenario-inreference-prereq.md`](../../docs/examples/scenario-inreference-prereq.md) -- prerequisites of a single in-reference op (`addPaymentInstrumentToBasket`); the producer choice point picks `createBasket`, not `transferBasket`/`mergeBasket`

## Install

```bash
git clone <repo-url>
cd claude-code-skills
ln -s "$PWD/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
```

That's it. dsc-scenario uses the shared scrape library directly (in `skills/_shared/scrape/`, reached via the `lib/` symlink), so there's no separate `dsc-scrape` skill installation required at runtime -- the scrape library invokes the same code path either way and writes to / reads from `~/.cache/dsc-scrape/`.

If you also want `dsc-scrape` available as a standalone skill (for raw-dump scraping invoked directly by name), install it the same way:

```bash
ln -s "$PWD/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
```

No `npm install`, no global state. The `lib/` dir in each skill is a symlink to `skills/_shared/`, so cloning the repo and symlinking the skill(s) you want is the entire setup.

## How it works

When invoked, the skill:

1. **Resolves the target** -- operationId, natural-language goal, or a sample cURL -- to a concrete `(reference, slug)` pair, scraping the reference if it's not in the cache yet.
2. **Walks the type graph** -- recursively, from the target's required inputs back through producer operations until it hits primitives or auth material. Handled either by a sub-agent (preferred at scale, keeps JSON reads out of the main conversation's context) or in-process for testing. See [`scripts/walk-via-agent.md`](scripts/walk-via-agent.md) for the sub-agent prompt.
3. **Picks the auth branch from the target's spec `security[].scheme`** -- `ShopperToken` -> SLAS shopper, `AmOAuth2` or `BearerToken` with `SLAS_*` scopes -> AM, OCAPI multi-scheme -> SLAS as default, anything else -> "unknown" (composes a plan without an auth-step block; the skill stays useful on non-Commerce families without fabricating).
4. **Selects the flow** -- within SLAS shopper: `guest` (default), `registered-b2c`, `registered-federated`, or `tsob`, mapped from prompt-keyword phrases via a small table in [`SKILL.md`](SKILL.md). Within AM: `private-cc` (default) or `public-pkce`.
5. **Composes the plan** -- topological sort of the prerequisite operations, scope dedup (per-op narrow + cross-op combine), ID-passing map (which step's response field threads into which downstream call's body or path), and a runnable bash block.
6. **Cites every step** to its public `developer.salesforce.com` URL.

The two pure-function modules -- [`lib/dedupe-scopes.js`](../_shared/dedupe-scopes.js) (`narrowOperationScopes` + `combinePlanScopes`) and [`lib/slas-flows.js`](../_shared/slas-flows.js) (`pickAuthBranch` + flow tables) -- have direct unit-test coverage, so the deterministic logic is locked in independently of the model's prose composition.

## Sub-agent dispatch

For production, the outer Claude conversation should dispatch a sub-agent for the type-graph walk (keeps JSON reads out of its context). The prompt template is in [`scripts/walk-via-agent.md`](scripts/walk-via-agent.md); `scripts/walk-types.js` exposes `walkViaAgentPrompt({targetSlug, reference, cacheRoot})` for parameter substitution. Pass the sub-agent's returned graph as the `graph` field in `scenario.js`'s input.

For local runs and tests, `scenario.js` falls back to running `walkTypes` in-process.

## Usage

See [`SKILL.md`](SKILL.md) for the full agent-facing flow. Quick shape for direct invocation:

```bash
node ~/.claude/skills/dsc-scenario/scripts/scenario.js <<'EOF'
{
  "target": "createOrder",
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders",
  "flowSignal": "registered-b2c"
}
EOF
```

The `flowSignal` is optional; default is `'guest'`. `cacheRoot` defaults to `~/.cache/dsc-scrape/`.

## Tests

```bash
cd ~/.claude/skills/dsc-scenario && bash tests/run.sh
```

The suite runs offline by default. Two files reach the network only when opted in or when the page is reachable, and neither breaks CI: `test-scope-meta-fresh.js` fetches the live SCAPI scope-catalog guide and skips gracefully if it's unreachable, and `test-corrections-live.js` re-probes each spec-correction anchor against the live spec but is skipped unless `DSC_LIVE_TESTS=1` is set. Everything else – the walker, compose, scope dedup, submittability, curl rendering, the correction verifier, and the drifted-through-compose case – is deterministic and offline.

## Companion skills

- [`dsc-scrape`](../dsc-scrape/) -- standalone skill for raw-dump scraping of any DSC reference, useful when you want the parsed JSON without composing a plan. Shares the on-disk cache (`~/.cache/dsc-scrape/`) and the same scrape library that dsc-scenario uses internally; installing dsc-scrape is optional from dsc-scenario's perspective.
- [`dsc-endpoint-help`](../dsc-endpoint-help/) -- single-endpoint spec lookup and failing-request diagnosis. The complementary skill: `dsc-endpoint-help` answers "what does this one endpoint require?", `dsc-scenario` answers "what's the chain to reach this endpoint?".

## Coverage and known gaps

See [`docs/dsc-skills.md`](../../docs/dsc-skills.md) for the per-family matrix. SCAPI, OCAPI, and SLAS are eval-validated; non-Commerce families (Marketing Cloud, Data 360, FSC, Healthcare, etc.) are marked `❓` (untested) -- chain shape is plausible based on spec surface but no fixture has been constructed yet. The `'unknown'` auth branch ensures the skill composes plans for those families without fabricating auth steps; full eval coverage is a follow-up iteration.
