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

   **Cross-reference bridge (two-pass).** If `scenario.js` returns a `bridgeCandidates` array, the target's body is a resource produced by another reference (e.g. `createOrder` takes a prepared `Basket`, produced by `shopper-baskets-v2.createBasket`). The candidates are the operations that produce that resource *from nothing*. Pick the single canonical **create** – the one that builds the resource fresh, not the ones that derive it from an existing instance (`mergeBasket`/`transferBasket` presuppose an existing basket; `createBasket` does not). Re-run `scenario.js` with `bridgeProducer: "<chosen slug>"` added to the stdin JSON. The second call composes the full cross-reference plan deterministically – you do not hand-write the producer step. Pick exactly one; do not list the alternatives in the plan.
4. **Layer business-logic ordering.** The structural plan from Step 2 may need reordering based on rules stated in the Summary or endpoint `description` prose. Apply constraints only when they're *quoted* from the docs; otherwise leave the structural order as-is and annotate as "no explicit ordering constraint found – structural only." Never invent constraints.
5. **Compose the output** per the template below. Cite only the URLs in `sources[]`; never cite local paths.

## Output composition

scenario.js emits `{plan, runnable, sources, staleness}`. Wrap it for the user like this (and if `staleness` is non-empty, prepend the stale-data warning from "Key invariants" above the `## Scenario:` line):

```
## Scenario: <short NL description of the goal>

Target: <METHOD> <path>   (<reference>.<operationId>)
References involved: <reference list>
Combined scopes required: <plan.combinedScopes>

## Plan

1. **<Step title>.** <operationId>.
   - Method/path: <step.method> <step.path>
   - Spec: <step.specUrl>
   - Produces: <producedTypes names / relevant response fields>
   - Why: <one line, quoting structural evidence OR a sentence from Summary/description>

2. ... (one block per step.)

## Run it

<fenced bash block with plan.runnable pasted verbatim>

## Sources
- <url 1>
- <url 2>
```

The auth step(s) appear at the top of the plan list (steps 1, optionally 1a/1b for the two-leg PKCE flow), driven by `plan.authBranch` and `plan.authFlow` from `composePlan`. When `authBranch === 'unknown'`, omit the auth-step block entirely; the plan starts with the target reference's first operation. The "References involved" line includes `auth` (Shopper Login / SLAS) when `authBranch === 'shopper-slas'`; AM auth steps cite the canonical `account.demandware.net/dwsso/oauth2/access_token` URL with a one-line note (see "Account Manager (AM) auth framing" below) -- never a `developer.salesforce.com` URL.

The `## Run it` block is mandatory. The runnable's URL prefix is emitted deterministically by `scenario.js` from each reference's `basePath` (SCAPI `/checkout/<reference>/v<n>/...`, OCAPI `/s/${SITE_ID}/dw/shop/v<n>/...`). You do not reconstruct it.

**PKCE in the runnable.** When the auth flow uses PKCE (any SLAS shopper flow, AM `'public-pkce'`), don't hand-write the `CODE_VERIFIER` / `CODE_CHALLENGE` lines. Run `node ~/.claude/skills/dsc-scenario/scripts/pkce-snippet.js` and paste its stdout into the bash block before the `/oauth2/authorize` (or `/oauth2/login`) call. Hand-rolled snippets drift toward the 32-byte / 43-char minimum-length form; the helper emits the 96-byte / 128-char form (still RFC 7636 compliant, more entropy) consistently.

**Extracting JSON response fields in the runnable -- use `jq -r`.** When a later call needs a field from an earlier call's JSON *response body* (`access_token` from `getAccessToken`, `basketId` from `createBasket`, `applicableShippingMethods[0].id` from `getShippingMethodsForShipment`), extract it with `jq -r` -- e.g. `ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)`. This is the idiom the deterministic renderer (`scripts/curl-block.js`) emits, so a hand-composed multi-reference runnable must match it. Do NOT hand-roll `node -e "...JSON.parse(d)..."` or `python3 -c "...json.load(...)..."` for this -- it's the right answer the renderer already produces, and a 200-character Node stdin-reader is not what a support engineer pastes into a terminal. (This is the inverse case of the redirect rule below: the authorization *code* comes from the 303 `Location` header and must NOT be parsed as JSON; genuine JSON response bodies like the token or basket *are* parsed, with `jq`.) Begin the runnable with a one-line preflight so a missing `jq` fails loud rather than silently mis-capturing -- `command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }`. Note: jq ships with macOS only since Sequoia (15); Linux and older-macOS users may not have it, which is why the preflight earns its line. Do NOT use the display-context fallback `... || _jq() { cat; }` (as in `stepped-demo-script`): here the value is captured into a shell variable, and falling back to `cat` would stuff the entire JSON blob into `ACCESS_TOKEN`/`BASKET_ID` and break every downstream call.

**Capturing the authorization code in the runnable.** The SLAS authorization-code legs answer with a `303` whose `Location` header carries the code – `authorizeCustomer` ("The authorization code was successfully added to the `redirect_uri`") and `authenticateCustomer` (the code and `usid` are added to the location header and returned as query params). The guest leg (`authorizeCustomer` + `hint=guest` + public client) and the registered-B2C leg (`authenticateCustomer` + a Basic-auth `shopperUserID:shopperPassword` header) are both **non-interactive**: a single `curl` returns the 303, and the runnable must capture the code straight from the redirect. Either idiom is correct: `curl -sS -o /dev/null -w '%{redirect_url}'` then parse `code=` out of the captured URL, or `curl -sS -D -` (dump headers) then `grep -i '^location:'` and `sed` the `code=` value out. Do NOT emit a manual "open this URL in a browser and paste the code" step for these flows (and never a `read`/`read -rp` prompt mid-script); a human hand-off in the middle of the script breaks the paste-and-run contract exactly like a bare spec path does.

**The code is in the `Location` header, never a JSON response body.** Both legs are declared with `303` (redirect) responses only – there is no `200` with a JSON token-less body, and no `authorizationCode` field anywhere in either operation's response schema. Do NOT write `... | node -e "...JSON.parse(d).authorizationCode"` or `python3 -c "...json.load(...)['authorizationCode']"` against the authorize/login response – that field is fabricated; the spec returns the code via the redirect `Location`, so the runnable must read it from there. Parsing a JSON body off the authorize/login call is a spec-fidelity bug, not a style choice.

The lone genuine exception to the non-interactive rule is the **registered-federated** leg (`authorizeCustomer` + `hint=<idp-name>`): there the shopper authenticates at an external IDP (Okta, Auth0, …), so that one call is inherently interactive – keep the browser step and say why, rather than pretend the code can be scraped headlessly.

**`authenticateCustomer` (`POST /oauth2/login`) request contract.** The registered-B2C login leg is easy to get subtly wrong because the spec states its parameters in prose, not in a formal `parameters`/`requestBody` schema (the schema only lists `organizationId`, `Authorization`, `x-slas-client-auth`). Take the contract from the description verbatim:

- **`Authorization: Basic base64(<shopperUserID>:<shopperPassword>)`** – required header, the *shopper's* own username:password (NOT the client ID/secret; the client goes in the optional `x-slas-client-auth` header when strict client auth is enabled).
- **Required parameters: `code_challenge`, `channel_id`, `client_id`, `redirect_uri`.** Optional: `usid`.
- There is **no** `grant_type` on `/login` (that belongs on the `/token` exchange in `getAccessToken`), and no `response_type`, `channel_type`, `login_id`, `login_password`, or `locale` – those are fabrications. In particular `channel_id` is required and easy to drop; do not omit it, and do not invent `channel_type` in its place.

When you compose the registered-B2C runnable, the `/login` curl carries the shopper Basic-auth header plus exactly those four required params (and `usid` only if you have one to thread). Don't add a `grant_type` to it; don't substitute `login_id`/`login_password` form fields for the Basic header.

When a step's only evidence is `{kind: 'structural', ...}`, the "Why" line should read: "<consumer> requires <field> in the request; this step's response provides it." When you add a business-logic constraint from prose, quote the relevant sentence and cite the Summary or endpoint URL inline.

**Cross-reference steps go in the same Plan list, not in a separate section.** If `externalInputs[]` includes `{reference: "auth", ...}`, the "References involved" line names `auth` (the SLAS reference's URL slug; the title on DSC is "Shopper Login (SLAS)") alongside the others, and the SLAS step (or steps – usually `authorizeCustomer` + `getAccessToken`) appears as numbered step(s) in the main Plan with their own `Spec:` URL. Don't write "external input – not part of either reference"; that prose is wrong (the input *is* part of a DSC reference). Auth steps in particular are mandatory expansions – see "Cross-reference walks" below. The "References involved" line and the Plan must include the auth steps even when the rest of the scenario is scoped to one reference.

## Cross-reference walks

If the sub-agent returns `externalInputs: [...]`, every entry has a `reference` field naming the DSC reference the input originates in (e.g. `{name: "access_token", likelyOrigin: "SLAS", reference: "auth"}` – `auth` is the URL slug DSC publishes the SLAS reference under; its title on the page is "Shopper Login (SLAS)"). **That reference is part of DSC** – not something outside this skill's universe. Cite it as a reference like any other, with its actual URL slug.

Cross-reference deps split into two categories with different handling rules:

### Auth routing -- spec-driven branch + flow choice

Auth steps are always part of the plan when the target's spec declares an auth scheme this skill recognizes. Branch is picked from the target endpoint's `security[].scheme`:

| Target endpoint declares | Auth branch | Default flow within branch |
|---|---|---|
| `ShopperToken` | SLAS shopper | Guest + public client + PKCE: `authorizeCustomer` (`hint=guest`) + `getAccessToken` (`grant_type=authorization_code_pkce`) |
| `AmOAuth2` | AM | Private client + `client_credentials` against `https://account.demandware.net/dwsso/oauth2/access_token` |
| `BearerToken` with `SLAS_*` scopes | AM | Same AM flow; scopes are `SLAS_SERVICE_ADMIN` / `SLAS_ORGANIZATION_ADMIN` (the AM client must be configured with those) |
| `customers_auth` / `oauth2_application` / `client_id` (OCAPI multi-scheme) | SLAS shopper | Same SLAS guest-PKCE default; OCAPI's `customers_auth` and AM mentioned as alternatives in prose |
| Anything else | unknown | No fabricated auth-step block. Plan still composes normally with the target reference's calls and the spec-declared scope union; the explicit pre-target auth-step block is omitted because this skill doesn't have flow logic for non-Commerce auth schemes (Marketing Cloud, Data 360, FSC, Healthcare, etc.) |

The skill picks `authBranch` from the target's spec automatically; you don't need to ask the user. Within a branch, `flowSignal` (read from the user's prompt) selects which flow data to render.

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

AM is undocumented on developer.salesforce.com by deliberate Salesforce decision (not a scrape gap). When the auth branch is `'am'`, render the auth step with the canonical token URL and a one-line note in the plan output:

```text
Step 1 -- Obtain an Account Manager (AM) access token
- Method/path: POST https://account.demandware.net/dwsso/oauth2/access_token
- grant_type=client_credentials
- Basic auth: AM_CLIENT_ID:AM_CLIENT_SECRET
- scope=<from the target endpoint's spec>
- Note: AM has no DSC reference page (deliberate by Salesforce); see the auth guide on the consuming SCAPI/OCAPI reference for setup details.
```

Never fabricate a `developer.salesforce.com` URL for AM; the `Note:` line is the citation contract.

### Non-auth cross-reference deps – mode choice still applies

Other cross-reference deps (e.g. a Shopper Orders scenario that needs a customer ID producible by Shopper Customers `getCustomer`, but the user might already have one) have two legitimate handling modes; pick based on what the user asked for:

1. **Expansion (preferred when the user wants a runnable end-to-end repro).** Warm the cache for the named reference (via `scrapeRefresh`), re-run the scenario, and integrate the dependency's calls as numbered steps in the main plan. Each integrated step gets the same `Spec:` URL line as native steps, citing the cross-reference's public DSC URL.

2. **Surfacing (preferred when the user is asking a focused question scoped to one reference, or has already obtained the value).** Keep the cross-reference dep as a numbered step labelled by its source reference, and tell the user explicitly: "this step belongs to the `<reference>` reference; say the word and I'll re-run with `<reference>` warmed and chain the full sub-flow in." Cite the cross-reference's public DSC URL in the step.

The mode choice never applies to auth – that's the auth subsection's job.

What never to write, in either category: "external input – not part of either reference," or "external dep, not in scope" – the input *is* part of a DSC reference (the one named in `externalInputs[].reference`); calling it "external" or "out of scope" misrepresents the skill's universe to the user. Always name the source reference and its DSC URL.

## What this skill doesn't do

- **Doesn't run the plan.** Output is a plan + runnable snippet; the engineer executes it in their instance.
- **Doesn't invent ordering constraints.** If the type graph has no edge and the prose has no ordering statement, the skill emits the structural order and annotates it as such.
- **Doesn't resolve environment-specific values** (site-ID, client-ID, auth flavor). Those become placeholders in the cURL block; the legend at the bottom names each.
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
