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
2. **Run the type-graph walk.** You have two options:
   - **Preferred (sub-agent):** read `scripts/walk-via-agent.md` and pass the parameterized prompt to Claude's `Agent` tool. The sub-agent returns `{nodes, edges, externalInputs}`. Pass that as `graph` in the scenario.js input.
   - **Fallback (local):** omit `graph` – `scenario.js` will run `walkTypes` locally. Same algorithm, but the JSON reads happen in your context.
3. **Invoke `scenario.js`**:

   ```bash
   node ~/.claude/skills/dsc-scenario/scripts/scenario.js <<'EOF'
   {
     "target": "createOrder",
     "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders",
     "graph": { "nodes": [], "edges": [] },
     "cacheRoot": "/Users/<you>/.cache/dsc-scrape"
   }
   EOF
   ```
4. **Layer business-logic ordering.** The structural plan from Step 3 may need reordering based on rules stated in the Summary or endpoint `description` prose. Apply constraints only when they're *quoted* from the docs; otherwise leave the structural order as-is and annotate as "no explicit ordering constraint found – structural only." Never invent constraints.
5. **Compose the output** per the template below. Cite only the URLs in `sources[]`; never cite local paths.

## Output composition

scenario.js emits `{plan, runnable, sources}`. Wrap it for the user like this:

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

The `## Run it` block is mandatory. The runnable bash must use canonical full URL paths -- not the spec's relative paths -- so a teammate can paste-and-run without reconstructing the URL prefix. The prefix differs by reference family:

- **SCAPI:** `${BASE_URL}/checkout/<reference>/v1/organizations/${ORG_ID}/...?siteId=${SITE_ID}` (e.g. `/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets`).
- **OCAPI:** `${BASE_URL}/s/${SITE_ID}/dw/shop/v<version>/...` for shop API, `/s/-/dw/data/v<version>/...` for data API. Don't abbreviate to `/baskets` or `/orders` -- those work only inside the spec doc, not against an instance.
- **SLAS / `auth`:** `${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/...`.

If the bash block uses bare paths from the spec (e.g. just `/baskets` or `/orders` without the `/checkout/...` or `/s/<siteId>/dw/shop/v<version>/...` prefix), the answer fails the paste-and-run criterion -- a teammate has to reconstruct each URL. That's a regression on the skill's main deliverable; the runnable should be runnable as-is.

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

- **`registered-federated` plans**: NO IDP framing. The user already specified federation (Okta, Auth0, etc.) -- their plan uses `authorizeCustomer` with `hint=<idp-name>` and the prose stays focused on that flow. Do not add a "if you weren't federated, you'd use `authenticateCustomer`" footnote; that's the kind of alternative-narration the "Don't narrate the alternatives" rule above specifically prohibits.

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

- **All DSC fetches go through the shared scrape library** (via `scrapeRefresh`). Never use `curl`, `WebFetch`, or any other client to read a `developer.salesforce.com` URL. When the user names a target you can't resolve, cascade through the library's discovery modes (`/docs/apis` for `_catalog.json` – match the user's hint against `title`, `body`, and `searchKeys` together; `searchKeys` carries acronyms like "OCI" or "SCAPI" so cold-cache resolution doesn't depend on training data → `lib/scrape/aliases.js` for catalog-missing products → product-area landing → reference root); don't reach for curl as a shortcut.
- Cite only the public DSC URLs in `sources[]`; never cite local cache paths.
