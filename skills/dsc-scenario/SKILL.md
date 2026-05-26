---
name: dsc-scenario
description: Build a multi-call repro plan against a Salesforce API reference published on developer.salesforce.com ("DSC"). Invoke when the user wants to reproduce a customer flow on a sandbox and needs to know which supporting API calls to make, in what order, with which scopes, and how IDs thread through the chain – examples: "repro a registered shopper adding a promo coupon and checking out", "what do I need to call before `createOrder`", "prerequisites for `createOrder`" (treat "prerequisites" or "prereqs" of a target op as a multi-call request even if the user says just that word), "build me a scenario around this cURL", "chain of calls to get from X to Y". Accepts an operationId, a natural-language goal, or a sample cURL/HTTP request as the target. Runs a type-graph walk (structural dependencies) and composes a linear plan + runnable cURL block. Every step cited to a public developer.salesforce.com URL. Works against any DSC reference `dsc-scrape` can deliver. Not for scraping a reference wholesale (that's `dsc-scrape`), not for one-off "what does this endpoint require" lookups or diagnosing why an existing request is failing (that's `dsc-endpoint-help` – single-endpoint, no ordering), and not for *authoring a runnable demo/repro script* the user will paste into a terminal – even if the subject is a Salesforce API on DSC (that's `stepped-demo-script`; this skill produces the *plan* of calls, not the paste-and-run bash).
---

# DSC Scenario Composer

Produce a plan of SCAPI / OCAPI calls – in order, with scope union, ID threading, and a runnable cURL block – to reach a target state. Every claim backed by a public `developer.salesforce.com` URL.

## When to use

The user is trying to reproduce a customer flow on a sandbox and needs to know:
- Which API calls must happen *before* the target operation can succeed.
- Which scopes the sandbox's SLAS/OAuth client must be configured with.
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

The `## Run it` block is mandatory. The runnable bash must use canonical full URL paths -- not the spec's relative paths -- so a teammate can paste-and-run without reconstructing the URL prefix. The prefix differs by reference family:

- **SCAPI:** `${BASE_URL}/checkout/<reference>/v1/organizations/${ORG_ID}/...?siteId=${SITE_ID}` (e.g. `/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets`).
- **OCAPI:** `${BASE_URL}/s/${SITE_ID}/dw/shop/v<version>/...` for shop API, `/s/-/dw/data/v<version>/...` for data API. Don't abbreviate to `/baskets` or `/orders` -- those work only inside the spec doc, not against a sandbox.
- **SLAS / `auth`:** `${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/...`.

If the bash block uses bare paths from the spec (e.g. just `/baskets` or `/orders` without the `/checkout/...` or `/s/<siteId>/dw/shop/v<version>/...` prefix), the answer fails the paste-and-run criterion -- a teammate has to reconstruct each URL. That's a regression on the skill's main deliverable; the runnable should be runnable as-is.

When a step's only evidence is `{kind: 'structural', ...}`, the "Why" line should read: "<consumer> requires <field> in the request; this step's response provides it." When you add a business-logic constraint from prose, quote the relevant sentence and cite the Summary or endpoint URL inline.

**Cross-reference steps go in the same Plan list, not in a separate section.** If `externalInputs[]` includes `{reference: "auth", ...}`, the "References involved" line names `auth` (the SLAS reference's URL slug; the title on DSC is "Shopper Login (SLAS)") alongside the others, and the SLAS step (or steps – usually `authorizeCustomer` + `getAccessToken`) appears as numbered step(s) in the main Plan with their own `Spec:` URL. Don't write "external input – not part of either reference"; that prose is wrong (the input *is* part of a DSC reference). Auth steps in particular are mandatory expansions – see "Cross-reference walks" below. The "References involved" line and the Plan must include the auth steps even when the rest of the scenario is scoped to one reference.

## Cross-reference walks

If the sub-agent returns `externalInputs: [...]`, every entry has a `reference` field naming the DSC reference the input originates in (e.g. `{name: "access_token", likelyOrigin: "SLAS", reference: "auth"}` – `auth` is the URL slug DSC publishes the SLAS reference under; its title on the page is "Shopper Login (SLAS)"). **That reference is part of DSC** – not something outside this skill's universe. Cite it as a reference like any other, with its actual URL slug.

Cross-reference deps split into two categories with different handling rules:

### Auth deps – always expand, no mode choice

Auth tokens (`access_token`, shopper JWT, customer JWT) are the universal precondition for every SCAPI / OCAPI call. Without the token the user can't make *any* call in the plan, so leaving them at "step 1: get a token" abdicates on the most important step. Always expand auth into the main Plan as numbered steps – never surface it as a "say the word and I'll chain it in" affordance.

Concretely:

- **SCAPI scenarios:** the SLAS legs (`authorizeCustomer` + `getAccessToken` on the SLAS reference, URL slug `auth`) are mandatory steps 1a + 1b (or 1 + 2) in every plan. Both legs cited with their own `Spec:` URLs (`https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer` and `…?meta=getAccessToken`). The "References involved" line names `auth` (Shopper Login / SLAS) alongside the target reference(s). Warm the `auth` cache via `scrapeRefresh` if it isn't already; if the user names the reference as "shopper-login" or "SLAS" in their ask, resolve it to the `auth` URL slug before scraping (the title on the reference page is "Shopper Login (SLAS)" but the URL is `…/references/auth`).
- **OCAPI scenarios:** OCAPI Shop API uses `customers_auth` (`POST /customers/auth` on `ocapi-shop-customers`) for shopper / guest JWTs; that endpoint is a real DSC reference and gets expanded the same way. The `Spec:` URL is `…/ocapi-shop-customers?meta=post-customers-auth`. OCAPI Data API endpoints sit behind Account Manager (the `oauth2_application` security scheme) – that's not a DSC reference, so the auth step there is "obtain an Account Manager access token" with a one-line note that it isn't a separately scrapeable spec. Don't fabricate a DSC URL for it.

Auth entries in `externalInputs[]` are flagged with `auth: true` so the composition layer can route them through the always-expand branch unconditionally.

### Non-auth cross-reference deps – mode choice still applies

Other cross-reference deps (e.g. a Shopper Orders scenario that needs a customer ID producible by Shopper Customers `getCustomer`, but the user might already have one) have two legitimate handling modes; pick based on what the user asked for:

1. **Expansion (preferred when the user wants a runnable end-to-end repro).** Warm the cache for the named reference (via `scrapeRefresh`), re-run the scenario, and integrate the dependency's calls as numbered steps in the main plan. Each integrated step gets the same `Spec:` URL line as native steps, citing the cross-reference's public DSC URL.

2. **Surfacing (preferred when the user is asking a focused question scoped to one reference, or has already obtained the value).** Keep the cross-reference dep as a numbered step labelled by its source reference, and tell the user explicitly: "this step belongs to the `<reference>` reference; say the word and I'll re-run with `<reference>` warmed and chain the full sub-flow in." Cite the cross-reference's public DSC URL in the step.

The mode choice never applies to auth – that's the auth subsection's job.

What never to write, in either category: "external input – not part of either reference," or "external dep, not in scope" – the input *is* part of a DSC reference (the one named in `externalInputs[].reference`); calling it "external" or "out of scope" misrepresents the skill's universe to the user. Always name the source reference and its DSC URL.

## What this skill doesn't do

- **Doesn't run the plan.** Output is a plan + runnable snippet; the engineer executes it in their sandbox.
- **Doesn't invent ordering constraints.** If the type graph has no edge and the prose has no ordering statement, the skill emits the structural order and annotates it as such.
- **Doesn't resolve environment-specific values** (site-ID, client-ID, auth flavor). Those become placeholders in the cURL block; the legend at the bottom names each.
- **Doesn't cite local cache paths.** `sources[]` only.
- **Doesn't auto-scrape cross-reference dependencies on a cold cache.** If the walk surfaces an `externalInputs` entry (e.g. SLAS for `access_token`) and the named reference isn't cached yet, the skill warms the cache via `scrapeRefresh` then re-runs the scenario with the dependency expanded; it doesn't try to walk an unscraped reference. The skill *does* expand cross-reference deps into multi-reference plans once the cache is warm – see "Cross-reference walks" above.

## Prerequisites

Same as `dsc-endpoint-help`: `~/.cache/dsc-scrape/` writable, Node.js. The shared scrape library ships with this skill via `lib -> ../_shared`.

## Key invariants

- **All DSC fetches go through the shared scrape library** (via `scrapeRefresh`). Never use `curl`, `WebFetch`, or any other client to read a `developer.salesforce.com` URL. When the user names a target you can't resolve, cascade through the library's discovery modes (`/docs/apis` for `_catalog.json` – match the user's hint against `title`, `body`, and `searchKeys` together; `searchKeys` carries acronyms like "OCI" or "SCAPI" so cold-cache resolution doesn't depend on training data → `lib/scrape/aliases.js` for catalog-missing products → product-area landing → reference root); don't reach for curl as a shortcut.
- Cite only the public DSC URLs in `sources[]`; never cite local cache paths.
