---
name: dsc-scenario
description: Build a multi-call repro plan against a Salesforce API reference published on developer.salesforce.com ("DSC"). Invoke when the user wants to reproduce a customer flow on an instance and needs to know which supporting API calls to make, in what order, with which scopes, and how IDs thread through the chain – examples: "repro a registered shopper adding a promo coupon and checking out", "what do I need to call before `createOrder`", "prerequisites for `createOrder`" (treat "prerequisites" or "prereqs" of a target op as a multi-call request even if the user says just that word), "build me a scenario around this cURL", "chain of calls to get from X to Y". Accepts an operationId, a natural-language goal, or a sample cURL/HTTP request as the target. Runs a type-graph walk (structural dependencies) and composes a linear plan + runnable cURL block. Every step cited to a public developer.salesforce.com URL. Works against any DSC reference `dsc-scrape` can deliver. Not for scraping a reference wholesale (that's `dsc-scrape`), not for one-off "what does this endpoint require" lookups or diagnosing why an existing request is failing (that's `dsc-endpoint-help` – single-endpoint, no ordering), and not for *authoring a runnable demo/repro script* the user will paste into a terminal – even if the subject is a Salesforce API on DSC (that's `stepped-demo-script`; this skill produces the *plan* of calls, not the paste-and-run bash).
---

# DSC Scenario Composer

Produce a plan of SCAPI / OCAPI calls – in order, with scope union, ID threading, and a runnable cURL block – to reach a target state. Every claim backed by a public `developer.salesforce.com` URL.

## When to use

The user is trying to reproduce a customer flow on an instance and needs to know:
- Which API calls must happen *before* the target operation can succeed.
- Which scopes the instance's SLAS/OAuth client must be configured with.
- Where each input to the target (basket IDs, customer IDs, line-item IDs) comes from.

Or the user pastes a cURL command and asks "what else do I need to call to make this work."

## Inputs

Ask for missing bits only when the skill can't proceed:

- **Target** – one of:
  - An operationId (`createOrder`, `shopper-baskets.addItemToBasket`).
  - A natural-language goal ("registered shopper adds a coupon and checks out"). You resolve this to an operationId by matching against `_index.json.title` + Summary prose across cached references; ask the user to confirm before proceeding.
  - A sample request (cURL, raw HTTP). Use `lib/parse-request.js` + `lib/resolve-slug.js` to map it to a slug.
- **Reference URL** – the developer.salesforce.com URL of the reference containing the target. Usually inferrable from the request path or operationId's reference prefix.

**Resolving an OCAPI target you can't name the reference for.** OCAPI reference slugs are not guessable (`ocapi-shop-orders`, `ocapi-data-code-versions` – there is no `ocapi-shop-api`; guessing 404s). When the user gives a `METHOD` + path ("OCAPI shop, `POST /orders`", "submit a basket via `POST /orders`") but not the reference slug, resolve it deterministically with `resolve-target.js` – pass the **area-landing URL** (`https://developer.salesforce.com/docs/commerce/b2c-commerce/references`) plus the method and path; it scans the landing and returns the exact `{reference, slug, referenceUrl}` to hand to `scenario.js`:

```bash
node ~/.claude/skills/dsc-scenario/scripts/resolve-target.js <<'EOF'
{
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/b2c-commerce/references",
  "method": "POST",
  "path": "/orders",
  "cacheRoot": "/Users/<you>/.cache/dsc-scrape"
}
EOF
```

It returns `{area, candidates:[{reference, slug, referenceUrl, ...}]}`. Use `candidates[0]` (most-specific path wins). Empty `candidates` means no match – ask the user for the reference URL; do NOT guess a slug (see "Decline, don't fabricate" below). The area-landing URL itself comes from the OCAPI hint in the user's prompt via the alias map (`_shared/scrape/aliases.js` maps "OCAPI", "/dw/shop", "/dw/data", etc. to the b2c-commerce landing).

## Flow

1. **Resolve target** to `{reference, targetSlug}`. For natural-language goals, match titles + Summary prose and confirm with the user.
2. **Invoke `scenario.js`** – it scrapes/refreshes the cache for you (via the accessor) and runs the type-graph walk locally; you do not warm the cache or read its files first:

   ```bash
   node ~/.claude/skills/dsc-scenario/scripts/scenario.js <<'EOF'
   {
     "target": "createOrder",
     "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders",
     "cacheRoot": "/Users/<you>/.cache/dsc-scrape"
   }
   EOF
   ```

   Omitting `graph` is the default: `scenario.js` runs `walkTypes` itself against the cache it just warmed. For an unusually large or cross-reference-heavy target where you want a sub-agent to do the walk instead, read `scripts/walk-via-agent.md`, pass that prompt to the `Agent` tool, and put its returned `{nodes, edges, externalInputs}` in the `graph` field – but that is the exception, not the routine path, and even then the sub-agent reads the cache `scenario.js` warmed, it does not scrape.

   **Producer choice point (two-pass).** If `scenario.js` returns a `bridgeCandidates` array, the target depends on a resource that has *more than one* operation producing it *from nothing*, and the skill needs you to pick which one belongs in the plan. The candidates are those from-nothing producers. Pick the single canonical **create** – the one that builds the resource fresh, not the ones that derive it from an existing instance (`mergeBasket`/`transferBasket` presuppose an existing basket; `createBasket` does not). Re-run `scenario.js` with `bridgeProducer: "<chosen slug>"` added to the stdin JSON. The second call composes the full plan deterministically – you do not hand-write the producer step. Pick exactly one; do not list the alternatives in the plan.

   This fires in two structurally identical situations, distinguished only by where the producer lives – you handle both the same way (pick one, re-invoke with `bridgeProducer`):
   - **Cross-reference:** the target's *body* is a named resource produced by another reference (e.g. `createOrder` takes a prepared `Basket`, produced by `shopper-baskets-v2.createBasket`).
   - **In-reference:** the target needs an id (e.g. `addPaymentInstrumentToBasket` needs a `basketId`) that several ops in the target's *own* reference produce from nothing (`createBasket`, `transferBasket`, `mergeBasket`). Without a pick the plan would chain all of them as bogus mandatory prerequisites; the candidate list lets you keep only the canonical create.
4. **Layer business-logic ordering.** The structural plan from Step 2 may need reordering based on rules stated in the Summary or endpoint `description` prose. Apply constraints only when they're *quoted* from the docs; otherwise leave the structural order as-is and annotate as "no explicit ordering constraint found – structural only." Never invent constraints.
5. **Honor the submittability advisory (if present).** When `scenario.js` returns a `submittability` object, the produced resource (e.g. a `Basket`) must be *populated* beyond the structural FK-threading minimum for the target to accept it – curated runtime knowledge the spec does not state. Render it per "Submittability registry" below: a populated producer body + the curated business-rule framing. Absent that object, the structural plan is the whole story.
6. **Compose the output** per the template below. Cite only the URLs in `sources[]`; never cite local paths.

## Output composition

scenario.js emits `{plan, runnable, sources, staleness}`. Wrap it for the user like this (and if `staleness` is non-empty, prepend the stale-data warning from "Key invariants" above the `## Scenario:` line):

```
## Scenario: <short NL description of the goal>

Target: <METHOD> <path>   (<reference>.<operationId>)
References involved: <reference list>
Combined scopes required: <plan.combinedScopes>   (mandatory -- always emit this line with the scope names from plan.combinedScopes; never omit or summarize it away, even in a terse answer)

## Plan

1. **<Step title>.** <operationId>.
   - Method/path: <step.method> <step.path>
   - Spec: <step.specUrl>
   - Produces: <producedTypes names / relevant response fields>
   - Why: <one line, quoting structural evidence OR a sentence from Summary/description>

2. ... (one block per step.)

## Run it

<fenced bash block with plan.runnable pasted verbatim -- verbatim means every line: the top fill-in block (connection values with their `:?` guards), the rendered auth preamble (token legs + the `ACCESS_TOKEN` capture), the `# Combined scopes required:` header curl-block.js emits, and every step's curl; do not reflow, trim, paraphrase, or summarize the block>

## Sources
- <url 1>
- <url 2>
```

The auth step(s) appear at the top of the plan list (steps 1, optionally 1a/1b for the two-leg PKCE flow), driven by `plan.authBranch` and `plan.authFlow` from `composePlan`. When `authBranch === 'unknown'`, omit the auth-step block entirely; the plan starts with the target reference's first operation. The "References involved" line includes `auth` (Shopper Login / SLAS) when `authBranch === 'shopper-slas'`; AM auth steps cite the canonical `account.demandware.com/dwsso/oauth2/access_token` URL with a one-line note (see "Account Manager (AM) auth framing" below) -- never a `developer.salesforce.com` URL.

The `## Run it` block is mandatory. The runnable's URL prefix is emitted deterministically by `scenario.js` from each reference's `basePath` (SCAPI `/checkout/<reference>/v<n>/...`, OCAPI Shop `/s/${SITEID}/dw/shop/v<n>/...`, OCAPI Data `/s/-/dw/data/v<n>/...`). OCAPI calls also carry a `?client_id=${CLIENT_ID}` query param (the auth floor); `scenario.js` emits that too. You do not reconstruct any of it.

**The auth preamble is rendered, not composed.** `scenario.js` emits the token-acquisition legs (PKCE setup, the authorize/login/`customers-auth` leg, the token exchange, and the `ACCESS_TOKEN=$(...)` capture) into `plan.runnable`, deterministically, from `plan.authBranch`/`authFlow`/`auth`. Relay the `## Run it` block verbatim – do NOT hand-compose, paraphrase, or "improve" the token legs. This is the same contract as the URL prefix and the `# Combined scopes required:` line: the script composes, you relay. The prose in this section (branch/flow routing, the request contracts, the AM/OCAPI framing below) exists so you can *read and explain* what the rendered preamble does – not so you can rebuild it by hand.

**Extracting a producer id in a hand-composed edge case -- use `jq -r`.** The rendered preamble already captures the token (`ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)`); you do not write that line. The general rule survives for the one place it's still the model's job: threading a producer id through a *hand-composed multi-reference* runnable that the renderer didn't emit (e.g. `basketId` from `createBasket`, `applicableShippingMethods[0].id` from `getShippingMethodsForShipment`). Extract those with `jq -r` -- e.g. `BASKET_ID=$(echo "$BASKET_RESPONSE" | jq -r .basketId)` -- matching the idiom `scripts/curl-block.js` emits. Do NOT hand-roll `node -e "...JSON.parse(d)..."` or `python3 -c "...json.load(...)..."` for this; a 200-character Node stdin-reader is not what a support engineer pastes into a terminal. The renderer already begins the runnable with a `jq` preflight (`command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }`) so a missing `jq` fails loud rather than silently mis-capturing; jq ships with macOS only since Sequoia (15), and Linux / older-macOS users may not have it, which is why that preflight earns its line. Do NOT use the display-context fallback `... || _jq() { cat; }` (as in `stepped-demo-script`): here the value is captured into a shell variable, and falling back to `cat` would stuff the entire JSON blob into a var and break every downstream call.

**The authorization code lives in the `303` `Location` header, never a JSON body.** This is a spec-fidelity fact the rendered preamble already honors, and one you must not "correct" if you're reading the runnable back to the user: both `authorizeCustomer` and `authenticateCustomer` are declared with `303` (redirect) responses only – there is no `200` token-less JSON body, and no `authorizationCode` field anywhere in either operation's response schema. So the rendered capture reads the code from the redirect (`curl ... -w '%{redirect_url}'`, grep `code=`), and any instinct to `... | jq .authorizationCode` or `node -e "...JSON.parse(d).authorizationCode"` against the authorize/login response is a fabrication – that field does not exist.

**`authenticateCustomer` (`POST /oauth2/login`) request contract.** The registered-B2C login leg is easy to get subtly wrong because the spec states its parameters in prose, not in a formal `parameters`/`requestBody` schema (the schema only lists `organizationId`, `Authorization`, `x-slas-client-auth`). The renderer emits this leg from the contract below; keep the contract here so you can verify or explain the rendered `/login` curl, not so you re-assemble it:

- **`Authorization: Basic base64(<shopperUserID>:<shopperPassword>)`** – required header, the *shopper's* own username:password (NOT the client ID/secret; the client goes in the optional `x-slas-client-auth` header when strict client auth is enabled).
- **Required parameters: `code_challenge`, `channel_id`, `client_id`, `redirect_uri`.** Optional: `usid`.
- There is **no** `grant_type` on `/login` (that belongs on the `/token` exchange in `getAccessToken`), and no `response_type`, `channel_type`, `login_id`, `login_password`, or `locale` – those are fabrications. In particular `channel_id` is required and easy to drop; do not omit it, and do not invent `channel_type` in its place.

In the rendered registered-B2C runnable, the `/login` curl carries the shopper Basic-auth header plus exactly those four required params (and `usid` only if one is threaded) – no `grant_type`, no `login_id`/`login_password` form fields substituted for the Basic header. If a rendered `/login` leg ever looks otherwise, that's a renderer bug to report, not something to fix by hand-editing the block.

**The federated browser seam is interactive by design.** The one leg the rendered preamble can *not* capture headlessly is the **registered-federated** flow (`authorizeCustomer` + `hint=<idp-name>`): the shopper authenticates at an external IDP (Okta, Auth0, …), so no single `curl` can return the `303`. The renderer emits exactly the right shape for this – a `# Open this URL in a browser…` instruction plus an `AUTH_CODE` fill-in var (with its `:?` guard in the top block), rather than a headless capture. Relay that as-is and explain *why* it's interactive (the external IDP round-trip can't be scraped); do NOT try to replace it with a headless `curl`, and do NOT insert a `read`/`read -rp` prompt mid-script (that breaks the paste-and-run contract). This is a sanctioned seam, not a defect in the runnable.

When a step's only evidence is `{kind: 'structural', ...}`, the "Why" line should read: "<consumer> requires <field> in the request; this step's response provides it." When you add a business-logic constraint from prose, quote the relevant sentence and cite the Summary or endpoint URL inline.

**Cross-reference steps go in the same Plan list, not in a separate section.** If `externalInputs[]` includes `{reference: "auth", ...}`, the "References involved" line names `auth` (the SLAS reference's URL slug; the title on DSC is "Shopper Login (SLAS)") alongside the others, and the SLAS step (or steps – usually `authorizeCustomer` + `getAccessToken`) appears as numbered step(s) in the main Plan with their own `Spec:` URL. Don't write "external input – not part of either reference"; that prose is wrong (the input *is* part of a DSC reference). Auth steps in particular are mandatory expansions – see "Cross-reference walks" below. The "References involved" line and the Plan must include the auth steps even when the rest of the scenario is scoped to one reference.

## Submittability registry – populating the produced resource

The structural walk plans the FK-threading minimum: enough to make the *type graph* resolve. For some targets that minimum is *not enough for the target to accept the produced resource*. The canonical case: `createOrder`'s only structural input is `basketId`, so the walk emits a `createBasket` with an empty `{}` body – but `createOrder` rejects an unpopulated basket at submit (400). The set of fields the basket must carry to be *submittable* is in **neither** the machine-readable spec (`Basket.required` is `null`) **nor** the basket-prep prose (it states no hard required-set). It is curated runtime knowledge, encoded in `scripts/submittability.json` and folded in deterministically by `scenario.js` – the same category of encoded fact as the SLAS auth-routing table, **not** model fabrication.

When `scenario.js` returns a `submittability` object, it means the target's body type has a registry entry. The object carries `{typeName, note, submittableVia, needed, bodyContents:[{field, why}], provenance, confidence:"curated", producerSlug}`. `note` is a one-line plain-language summary of the rule (surface it verbatim if you want a quick framing sentence); `submittableVia` is `"producer-body"` when the minimum is populated in the producer's request body (today's only shape); `needed` is the list of *separate* ops required (empty for body-content entries like `Basket`). Render it like this:

- **Populate the producer step's body** (the `producerSlug` step – e.g. `createBasket`) with the `bodyContents` fields, showing a *realistic* example body (a line item, a shipping method + address, a billing address, a payment instrument), not the empty `{}` and not opaque `<field>` placeholders. The runnable from `scenario.js` carries these fields and a banner; flesh the body out to something a support engineer can actually paste, keeping the field set to exactly what `bodyContents` lists.
- **Frame every populated field as a curated checkout business-rule, never as spec.** The producer step gets one extra line under its "Why": *"The basket must be populated before `createOrder` accepts it – this is a checkout business-rule (curated), not stated in the spec. See <provenance>."* Each `bodyContents[].why` is the per-field reason (the exact 400 it prevents); surface them as the justification, attributed to the curated provenance, **not** to the `createBasket` spec page.
- **Do NOT expand the populate work into separate numbered API steps.** The whole point of the body-content shape is that a prepared basket carries items/shipping/billing/payment *in the single `createBasket` body* (the maintainer's preferred, performant single-call shape). `addItemToBasket` / `updateShippingMethodForShipment` / `updateBillingAddressForBasket` / `addPaymentInstrumentToBasket` as separate steps is over-decomposition – the basket-prep belongs in the create body. (If a future registry entry sets a non-empty `needed[]`, *those* ops are justified separate steps; the `Basket` entry's `needed` is `[]`.)
- **The plan stays minimal.** For `createOrder` the corrected plan is still 4 steps (SLAS leg 1, SLAS leg 2, `createBasket` *with a populated body*, `createOrder`) – it fills the body, it does not add steps.

## Cross-reference walks

If the sub-agent returns `externalInputs: [...]`, every entry has a `reference` field naming the DSC reference the input originates in (e.g. `{name: "access_token", likelyOrigin: "SLAS", reference: "auth"}` – `auth` is the URL slug DSC publishes the SLAS reference under; its title on the page is "Shopper Login (SLAS)"). **That reference is part of DSC** – not something outside this skill's universe. Cite it as a reference like any other, with its actual URL slug.

Cross-reference deps split into two categories with different handling rules:

### Auth routing -- spec-driven branch + flow choice

Auth steps are always part of the plan when the target's identity resolves to an auth branch this skill recognizes. `scenario.js` resolves the branch deterministically (via the auth-provider registry in `_shared/auth-providers.js` + B2C's provider set in `_shared/b2c-auth-providers.js`) and returns it as `plan.authBranch` plus a `plan.auth` object carrying the resolved tier, token flow, request-auth shape, and per-branch prerequisites. **You never pick the branch; render what `plan.auth` says.**

**Spec corrections in `plan.auth.prerequisites`.** Some entries in `plan.auth.prerequisites` are *corrections* – curated facts that OVERRIDE what a spec's `security[]`/schema declares (the skill knows them from live verification, not from the spec). A correction is any prerequisite carrying a `status` field; each renders per its status:

- **`status: 'active'`** – render the `claim` **verbatim** (do NOT paraphrase – these are precise, and a reworded claim can invert its meaning). Follow it with the `scope` bounds line (what the evidence covers, and what it does not), a "verified" line summarizing `verifiedOn` (dates + coordinates, shown as-is – do not compute an age or convert a date to a relative phrase), and the `cite` URL. When `cite` is `null`, the claim itself is the citation contract (same rule as AM auth): say the fact is verified-not-documented rather than inventing a `developer.salesforce.com` URL.
- **`status: 'drifted'`** – do NOT present the `claim` as current fact. Render a re-verify banner: "This curated correction predates a spec change – re-verify before relying on it. It asserted: `<claim>`. The spec field `<drift.field>` no longer matches what it was recorded against." Show `drift.saw` (what we recorded) against `drift.now` (what the spec says now). The safe action is the same whether the spec converged toward our correction or moved elsewhere: surface it, do not silently apply the override.

Never suppress a `drifted` note silently – surfacing the drift IS the point (a stale override trusted blindly is the confidently-wrong failure this skill exists to prevent). Corrections render wherever the branch's prerequisites render; a correction may apply even on the `unknown` branch (it rides `plan.auth.prerequisites` regardless of routing).

**Prerequisites without a `status` field are provider prerequisites** – render them as before (`text` + `cite`). These are the existing `{kind, text, cite}` entries (the AM tenant-scope note, the OCAPI-settings allowlist note): surface the `text` line, then the `cite` URL, or – when `cite` is `null` – the note itself as the citation contract (same as AM). Both shapes coexist in the one `prerequisites` array; the presence of `status` is what tells a correction apart from a provider prerequisite, so don't expect every entry to carry a `claim`/`status`.

**Stale-spec caveat on a correction.** A correction's drift check runs against whatever spec `scenario.js` read – and when a refresh fails, that is the last-good cached copy (the top-level `staleness` array names each reference served stale; see "Staleness warning" under Key invariants). So if the target's reference appears in `staleness`, the correction's anchor was evaluated against STALE spec data: append to the note – whether it rendered `active` or `drifted` – a caveat like "checked against stale spec data – refresh failed; re-verify." A stale-backed `active` is the dangerous case: it reassures the reader that the override still matches the spec when the drift check never saw the live spec – exactly the confidently-wrong reassurance this layer exists to catch.

Routing keys on the target's **reference family first, then its declared scheme** -- because SCAPI keys off the scheme but OCAPI does NOT (OCAPI Shop and OCAPI Data declare the *same* schemes, so the scheme can't disambiguate them):

| Target identity | Auth branch | Default within branch |
|---|---|---|
| scheme `ShopperToken` | `shopper-slas` | SLAS flow chosen by `flowSignal` (guest + public-client PKCE default) |
| scheme `AmOAuth2`, or `BearerToken` with `SLAS_*` scopes | `am` | Private client + `client_credentials` against `https://account.demandware.com/dwsso/oauth2/access_token`, scope `SALESFORCE_COMMERCE_API:<tenant>` + the API scopes |
| reference family `ocapi-shop-*` | `ocapi-shop` | Lightest sufficient tier (see "OCAPI Shop auth" below): `client_id`-only for the curated public reads, an OCAPI-native `customers/auth` shopper token for everything else |
| reference family `ocapi-data-*` | `ocapi-data` | AM app token (same `dwsso/oauth2/access_token`, `client_credentials`) + the Data request shape |
| anything else | `unknown` | No fabricated auth-step block. Plan still composes with the target reference's calls + the spec-declared scope union; the pre-target auth-step block is omitted (this skill has no flow logic for non-Commerce schemes -- Marketing Cloud, Data 360, FSC, Healthcare, etc.) |

The skill resolves `authBranch` from the target automatically; you don't ask the user. Within the SCAPI branches, `flowSignal` (read from the user's prompt) selects which flow data to render; the OCAPI branches carry their token flow on `plan.auth.token` instead.

**Never route OCAPI on the declared scheme.** An OCAPI op's `security[]` (`customers_auth` / `oauth2_application` / `client_id`) does not tell you Shop vs Data -- the reference family does. `scenario.js` already routes on family; don't second-guess it by reading the scheme yourself.

**SLAS reference URL (canonical citation form).** Every SLAS operation cites the SLAS reference at this exact URL shape, with the URL slug `auth` (NOT `shopper-login` -- that's the page title, but the URL slug is `auth`; `/references/shopper-login` 404s):

- `https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer`
- `https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer`
- `https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken`
- `https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getTrustedSystemAccessToken`

Cite with the `auth` slug verbatim. Do not derive a slug from the page title.

### Flow signals -- which prompt phrase maps to which flow

Within the SLAS shopper branch, four signals (default = `'guest'`):

| Signal | Slugs | Trigger phrases (any one matches) |
|---|---|---|
| `'guest'` (default when no signal detected) | `authorizeCustomer` (`hint=guest`) + `getAccessToken` | none -- this fires when the prompt doesn't specify a registered/TSOB scenario |
| `'registered-b2c'` | `authenticateCustomer` (`POST /oauth2/login`) + `getAccessToken` | "registered shopper", "logged-in shopper", "B2C credentials", "username/password login" |
| `'registered-federated'` | `authorizeCustomer` (`hint=<idp-name>`) + `getAccessToken` | "federated", "custom IDP", named IDP ("Okta", "Auth0", etc.), "SSO" |
| `'tsob'` | `getTrustedSystemAccessToken` | "trusted system on behalf of", "TSOB", "shopper context as service" |

If multiple signals match, the more-specific wins (e.g. "Okta-federated registered shopper" -> `'registered-federated'`, not `'registered-b2c'`).

**Important default**: when the prompt names a registered shopper but doesn't mention federation, default to `'registered-b2c'`. Federation is opt-in setup; assume the OOTB platform-IDP path. Customers who use federation almost always say so explicitly; customers who don't, won't volunteer "and we don't have SSO" because they may not know it matters.

Within the AM branch, two signals (default = `'private-cc'`):

| Signal | Default | Trigger phrases |
|---|---|---|
| `'private-cc'` (default) | Private client + `client_credentials` against `dwsso/oauth2/access_token` | none -- this fires by default for AM-routed targets |
| `'public-pkce'` | Public client + PKCE against the same endpoint | "public AM client", "AM with PKCE", "AM public-client + PKCE" |

The AM `'public-pkce'` flow is recognized as an option (Salesforce shipped public-client AM support recently) but never the default; private + `client_credentials` is the conventional setup for back-end / admin work.

Pass the chosen `flowSignal` to `scenario.js` in the stdin JSON alongside `target` and `referenceUrl`.

**Don't narrate the alternatives.** Once the flow signal is decided, the plan emits *that flow's* steps and *only* those steps. Don't add a "if you weren't federated, you'd use `authenticateCustomer` instead" footnote, or "if you wanted guest, you'd add `hint=guest`" -- that's the opposite of what the user asked. Those alternatives are documented *here* in SKILL.md so future plans can pick differently; they don't belong in any single plan's output. Exception: the IDP-framing one-liner on registered plans (see "IDP framing" below) is a single sentence that names the federated alternative; that's a deliberate, scoped exception because the OOTB-vs-federated distinction is a known customer trip-hazard.

**Stay on the user's chosen API family.** When the user asks about OCAPI, the plan answers in OCAPI -- don't volunteer a comparison to SCAPI, a "migration footprint," or a "you should consider SCAPI for new work" note. OCAPI is deprecated but still real; the customer is using it for a reason (existing integration, fastest-path repro, AM-token compatibility). Same direction the other way: a SCAPI question gets a SCAPI answer, no detour through OCAPI's history. The skill's job is to deliver a working plan in the API the user named, not to advocate for a different one. (The migration-direction memory: customers migrate OFF OCAPI to SCAPI, never the reverse -- so even when you do get asked for migration help, the direction is one-way.)

**Prefer the latest reference version.** Some references are published in multiple versions side by side -- e.g. `shopper-baskets` (Shopper Baskets V1) and `shopper-baskets-v2` (Shopper Baskets V2). `scenario.js` handles this for you: it scrapes the reference first (which writes the area landing), then bumps a bare reference to its newest sibling automatically and threads the bumped slug through the citations and the runnable's path prefix. You don't run the exposer or rewrite the slug yourself for routine prefer-latest -- the bump is deterministic in code regardless of what order you ran your steps.

Your only job is the one judgment: **did the user explicitly pin a version?** If they did -- a `-v<N>` in a pasted `.../references/shopper-baskets-v2` URL, prose like "shopper-baskets v1" or "the V1 basket API", or an operationId they tie to a specific version -- pass `pinVersion: true` in the `scenario.js` stdin JSON (alongside `target` and `referenceUrl`). That suppresses the bump and honors the exact version they named. Absent that signal, leave `pinVersion` out and let the bump pick latest.

The shared exposer (`reference-versions.js`) still exists if a user asks "what versions are there?" and you want to enumerate siblings:

```bash
echo '{"reference":"shopper-baskets"}' | node ~/.claude/skills/dsc-scenario/lib/scrape/reference-versions.js
```

It returns `{requested, requestedIsVersioned, latest, versions:[{id, version, basePath}], hasMultipleVersions}` -- but it is **not** required for prefer-latest anymore; that decision lives in `scenario.js`. Note that the id `shopper-baskets-v2` maps to the REST path segment `shopper-baskets/v2` (from its `basePath`), not `shopper-baskets-v2/v1` -- the runnable already accounts for this because each version's endpoints carry their own `basePath`.

### Scope output -- least-privilege deduped, with meta-scope alternative

`composePlan` returns `combinedScopes` already deduped by `combinePlanScopes`:

- For each operation, the bare `<scope>` is preferred over `<scope>.rw` when both are listed in the spec's accepted-scope OR-list (least privilege within one operation).
- Across operations, the union drops bare `<scope>` when `<scope>.rw` is independently in the union (`.rw` covers reads -- configuring both is redundant).
- `metaScopeSuggested` is `true` when the deduped union is a strict subset of `sfcc.shopper-standard`'s 20-scope expansion.

Render the scope block in the plan output like this:

```text
Combined SLAS client scopes required:
  <deduped, comma-separated>

(if metaScopeSuggested) Alternatively, configure your SLAS client with `sfcc.shopper-standard` -- a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.
```

Never replace the explicit list with the meta-scope; always show both when applicable. Never list bare and `.rw` together for the same family in the deduped output (the dedup helper enforces this; if you see both, file a bug against `lib/dedupe-scopes.js`).

### IDP framing -- only on registered-b2c plans

- **Guest plans**: say nothing about IDP. `hint=guest` documents itself as bypassing IDP selection; users running the default guest flow don't need to know the platform IDP exists.
- **`registered-b2c` plans**: include one line of IDP framing immediately after step 1's title. Example:

  > This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, Google, etc.) -- if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.

  This corrects the assumption that "I don't have an IDP" means platform-IDP doesn't apply -- the platform itself is the IDP unless federation is explicitly configured. Customers who hear "IDP" and think "I don't have one" need this primer; the spec's own `authorizeCustomer` description ("after authenticating a user against an identity provider (IDP)") is technically accurate but actively misleading for the no-federation case.

- **`registered-federated` plans**: NO IDP framing. The user already specified federation (Okta, Auth0, etc.) -- their plan uses `authorizeCustomer` with `hint=<idp-name>` and the prose stays focused on that flow. Do not add a "if you weren't federated, you'd use `authenticateCustomer`" footnote; that's the kind of alternative-narration the "Don't narrate the alternatives" rule above specifically prohibits. This applies **especially inside the browser-step explanation**: it is correct and useful to explain *why the federated step needs a real browser* (the shopper authenticates at the external IDP, so the `303`/code can't be captured headlessly), but explain that using only the federated mechanism itself -- do NOT reach for the B2C contrast to make the point ("...whereas if you weren't federated, `authenticateCustomer` / `POST /oauth2/login` returns a 303 you could capture headlessly"). Naming `authenticateCustomer` or `/oauth2/login` anywhere in a federated plan -- even as a "headless alternative" aside in an otherwise-correct note -- is the prohibited narration. The federated plan never mentions the B2C login op at all; if you're tempted to write "the alternative is..." or "if not federated...", delete that clause.

### Account Manager (AM) auth framing

AM is undocumented on developer.salesforce.com by deliberate Salesforce decision (not a scrape gap). When the auth branch is `'am'`, the rendered preamble emits the AM token leg (a `client_credentials` POST to the canonical `account.demandware.com/dwsso/oauth2/access_token` host, `AM_CLIENT_ID`/`AM_CLIENT_SECRET` in a Basic header, scope from `combinedScopes` + the tenant role); you relay it verbatim. Your job is the matching **Plan-list** step, which describes that leg so the reader knows what the runnable is doing. That step renders like this:

```text
Step 1 -- Obtain an Account Manager (AM) access token
- Method/path: POST https://account.demandware.com/dwsso/oauth2/access_token
- grant_type=client_credentials
- Basic auth: AM_CLIENT_ID:AM_CLIENT_SECRET
- scope=<from the target endpoint's spec, plus the tenant role -- see below>
- Note: AM has no DSC reference page (deliberate by Salesforce); see the auth guide on the consuming SCAPI/OCAPI reference for setup details.
```

Never fabricate a `developer.salesforce.com` URL for AM; the `Note:` line is the citation contract, and it's the same contract the rendered AM leg honors (the preamble contributes no source for AM).

**AM scope must carry the tenant.** The AM token request's `scope` must include `SALESFORCE_COMMERCE_API:<tenant>` (the realm, e.g. `abcd_001`) *in addition to* the API scopes, space-separated -- e.g. `scope=SALESFORCE_COMMERCE_API:abcd_001 sfcc.orders`. A bare `SALESFORCE_COMMERCE_API` role is accepted as a scheme but denied at the resource (403); the tenant suffix flips it to 200 (verified live -- same class of runtime-vs-spec defect as the AM `.net`->`.com` host fix). The rendered AM leg emits the tenant as an `${AM_TENANT}` fill-in var (surfaced in the top fill-in block with a `:?` guard), because the realm isn't known at render time; the reader supplies it -- it's derivable from the org id `f_ecom_<realm>` (so `f_ecom_abcd_001` -> `abcd_001`). `scenario.js` surfaces this as an `am`-branch prerequisite note; render it on the AM auth Plan step so the reader knows what `${AM_TENANT}` is for.

### OCAPI Shop auth (`authBranch === 'ocapi-shop'`)

OCAPI Shop is a three-tier auth ladder; `scenario.js` returns the resolved tier on `plan.auth.tier`. Render exactly that tier -- do not add the others:

- **`plan.auth.tier === 'client-id'`** (the curated proven-public reads: single-product / category / site GETs). No token at all -- the call carries only `?client_id=<id>`. The rendered runnable omits the `Authorization` header for these and emits no token leg; there is no auth *step*, just the `CLIENT_ID` fill-in var in the top block.
- **`plan.auth.tier === 'shopper'`** (everything else -- baskets, orders, any write). The call needs a shopper-identity bearer *and* `?client_id=`. The default token flow is **OCAPI-native `customers/auth`** (`plan.auth.token.flow === 'ocapi-customers-auth'`): the rendered preamble emits a `POST /customers/auth` leg on the `ocapi-shop-customers` reference with a `{"type":"guest"}` body, and captures the JWT from the response `Authorization` header (the token comes back as a response header, not a JSON body, so the rendered capture dumps headers and greps rather than using `jq`). Cite `customers/auth` at its `ocapi-shop-customers` reference URL. The Plan step describes this leg; you relay the rendered curl.

**The OCAPI registered-shopper credentials seam.** For a registered (not guest) OCAPI shopper, the rendered guest `customers/auth` leg carries an adjustment comment: swap `{"type":"guest"}` -> `{"type":"credentials"}` and add the shopper Basic header (`Authorization: Basic base64(<user>:<pass>)`). This is the one sanctioned model adjustment on the OCAPI branch – the renderer emits the guest shape by default and flags the swap inline, so make it only when the user's scenario is a registered shopper. (Fuller registered-OCAPI support is a deferred follow-up; today this comment-guided swap is the whole seam.)

The `client_id` query param is the OCAPI floor -- `scenario.js` puts it on every OCAPI call in the runnable, and `CLIENT_ID` is a fill-in var in the top block. Don't remove it; a bare OCAPI call (no `client_id`) 400s.

**SLAS is a prose migration alternative only, never the emitted OCAPI runnable.** A SLAS shopper token *does* work against OCAPI Shop when the client is allowlisted, but the person asking about OCAPI already has an OCAPI client -- defaulting to SLAS would force a second client (or UUID reuse, bad practice). Emit the OCAPI-native flow; you may mention SLAS in one sentence as the migration-forward alternative, but don't render its steps.

`scenario.js` returns the OCAPI-settings allowlist prerequisite on `plan.auth.prerequisites`; surface it as a note (it's an instance-config fact the skill can't verify -- the client must be enabled in Business Manager's Open Commerce API Settings).

### OCAPI Data auth (`authBranch === 'ocapi-data'`)

OCAPI Data gates on a valid **AM app token** -- the same `dwsso/oauth2/access_token` + `client_credentials` flow as SCAPI Admin (`plan.auth.token.flow === 'am-app-token'`). Render the AM auth step exactly as in "Account Manager (AM) auth framing" above (canonical token URL, no fabricated DSC URL). The Data call carries `?client_id=` (the floor) + the AM bearer, against the Data request shape `/s/-/dw/data/v<ver>/...` (literal `-`, no site id -- `scenario.js` emits this from the reference `basePath`). Surface the OCAPI-settings prerequisite on `plan.auth.prerequisites` the same way. Note: an AM Data token needs no `SALESFORCE_COMMERCE_API` tenant scope (that's the SCAPI-Admin rule); OCAPI authorization is the Business Manager allowlist, and the token's scopes are placeholders.

### Decline, don't fabricate, when the target won't resolve

If you cannot resolve the target to a real `{reference, slug}` -- the reference isn't in the area landing, `scenario.js` errors, or `resolve-target.js` returns no candidates -- **say so and ask the user for the reference URL.** Do NOT invent a slug, and NEVER cite a non-`developer.salesforce.com` host. In particular do not fall back to `documentation.b2c.commercecloud.salesforce.com`, `salesforcecommercecloud.github.io`, an SFCC "OCAPI documentation" host, or any other non-DSC domain -- every citation in this skill's output is a `developer.salesforce.com` URL (AM's `Note:` line is the sole documented exception, and it cites `account.demandware.com`, an auth host, not a docs host). A fabricated slug or an off-domain citation is the confidently-wrong failure this family exists to prevent; an honest "I couldn't resolve `<x>` -- paste the reference URL" is always the better answer.

### Non-auth cross-reference deps – mode choice still applies

Other cross-reference deps (e.g. a Shopper Orders scenario that needs a customer ID producible by Shopper Customers `getCustomer`, but the user might already have one) have two legitimate handling modes; pick based on what the user asked for:

1. **Expansion (preferred when the user wants a runnable end-to-end repro).** Warm the cache for the named reference (via `scrapeRefresh`), re-run the scenario, and integrate the dependency's calls as numbered steps in the main plan. Each integrated step gets the same `Spec:` URL line as native steps, citing the cross-reference's public DSC URL.

2. **Surfacing (preferred when the user is asking a focused question scoped to one reference, or has already obtained the value).** Keep the cross-reference dep as a numbered step labelled by its source reference, and tell the user explicitly: "this step belongs to the `<reference>` reference; say the word and I'll re-run with `<reference>` warmed and chain the full sub-flow in." Cite the cross-reference's public DSC URL in the step.

The mode choice never applies to auth – that's the auth subsection's job.

What never to write, in either category: "external input – not part of either reference," or "external dep, not in scope" – the input *is* part of a DSC reference (the one named in `externalInputs[].reference`); calling it "external" or "out of scope" misrepresents the skill's universe to the user. Always name the source reference and its DSC URL.

## What this skill doesn't do

- **Doesn't run the plan.** Output is a plan + runnable snippet; the engineer executes it in their instance.
- **Doesn't invent ordering constraints.** If the type graph has no edge and the prose has no ordering statement, the skill emits the structural order and annotates it as such.
- **Doesn't resolve environment-specific values** (site-ID, client-ID, auth flavor). Those become fill-in vars in the block at the TOP of the runnable, each with a `:?` preflight that fails loud if unset.
- **Doesn't cite local cache paths.** `sources[]` only.
- **Doesn't auto-scrape cross-reference dependencies on a cold cache.** If the walk surfaces an `externalInputs` entry (e.g. SLAS for `access_token`) and the named reference isn't cached yet, the skill warms the cache via `scrapeRefresh` then re-runs the scenario with the dependency expanded; it doesn't try to walk an unscraped reference. The skill *does* expand cross-reference deps into multi-reference plans once the cache is warm – see "Cross-reference walks" above.

## Prerequisites

Same as `dsc-endpoint-help`: `~/.cache/dsc-scrape/` writable, Node.js. The shared scrape library ships with this skill via `lib -> ../_shared`.

## Key invariants

- **`scenario.js` owns all cache access; you never touch the cache yourself.** `scenario.js` obtains and refreshes the spec data it needs through the blind-ingress accessor (`lib/scrape/cache-access.js`) – it scrapes when data is absent or stale, serves the last good copy if a refresh fails, and reads the cached JSON for you. You do **not** run the scrape library, `curl`, or `WebFetch` against a `developer.salesforce.com` URL, and you do **not** `cat`, `Read`, `grep`, or otherwise open files under `~/.cache/dsc-scrape/` to assemble a plan – pass the target and reference URL to `scenario.js` and let it return the structured plan. Hand-reading cache files is the failure mode this skill is built to avoid: it bypasses freshness/staleness handling and produces nondeterministic, hand-assembled plans. If `scenario.js` can't resolve a target, that's a signal to fix the inputs (or report the gap), not to spelunk the cache.
- **Staleness warning (mandatory when present).** `scenario.js` emits a `staleness` array. When it is non-empty, a refresh failed and the plan was built from cached spec data – you MUST open your answer, immediately above the `## Scenario:` heading, with:

  > **⚠ Stale spec data.** Could not refresh `<reference>`; this plan was built from cache last scraped `<scrapedAt>`. Verify against the live reference before relying on it.

  Use the absolute `<scrapedAt>` date verbatim from the `staleness` entry (it is `YYYY-MM-DD…`); never convert it to a relative phrase ("3 days ago"). If multiple references are stale, keep one `**⚠ Stale spec data.**` lead and list each reference + its `scrapedAt` as a bullet. A stale-backed plan that doesn't say so is the confidently-wrong-answer failure this skill exists to prevent.
- **The two judgments that remain yours** (everything else is `scenario.js`'s deterministic job): resolving a natural-language goal to an operationId (Flow step 1), and layering business-logic ordering constraints *quoted* from Summary/`description` prose (Flow step 4). Don't push these into the script, and don't let the script's determinism tempt you to invent either one.
- Cite only the public DSC URLs in `sources[]`; never cite local cache paths.
