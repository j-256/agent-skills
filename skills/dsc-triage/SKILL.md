---
name: dsc-triage
description: Diagnose a failing Salesforce API request against its public spec on developer.salesforce.com ("DSC"). Invoke whenever the user pastes a cURL command, raw HTTP request, or error body (`invalid_client`, `insufficient_scope`, `400 missing_parameter`, etc.) from a customer ticket and asks "why is this failing" / "what scope is missing" / "what's wrong with this request." Diffs required vs. provided scopes (decoded from the access token or from a registered client list the user supplies) and required vs. actual request shape (method, params, headers, body schema). Every claim cited to a public developer.salesforce.com URL. Works against any DSC reference `dsc-scrape` can deliver – heaviest current coverage on B2C Commerce SCAPI, SLAS, and Einstein. Hands off honestly for errors the spec can't explain (5xx, 404 path-or-resource-missing, 409 conflicts). Not for scraping a reference wholesale (that's `dsc-scrape`), not for answering one-off "what does this endpoint require" questions (that's `dsc-endpoint-lookup`).
---

# DSC Error Triage

Diagnose *why* a specific SCAPI / OCAPI request is failing, by diffing it against the public spec. Returns prose + structured diff; every claim backed by a public `developer.salesforce.com` URL the user can forward to the customer.

## When to use

A customer sent one of:
- A cURL command + the error they got back.
- A raw HTTP request + response.
- Just an error body (`invalid_client`, `insufficient_scope`, `400 missing_parameter`, etc.) and the endpoint name.

You need to figure out which of: missing OAuth scope, wrong client config, invalid token, missing required parameter, wrong body field type, wrong content-type, or "something else the spec can't tell you."

## Inputs

Ask the user for whatever's missing only if the skill can't proceed:

- **Request** – cURL, raw HTTP, or `method + URL`. Required.
- **Error response** – `{status, body}`. Required. Body can be JSON or prose.
- **Access token (JWT)** – optional. If provided (or embedded in the request's `Authorization: Bearer` header), the skill decodes the `scp` claim for a high-confidence scope diff.
- **Registered client scopes** – optional. If the user has the list from their SLAS/OAuth client config, pass it instead (confidence: medium, with a disclaimer).
- **Reference URL** – the developer.salesforce.com URL of the reference containing this endpoint. Usually inferrable from the request path (`/checkout/shopper-baskets/...` → `https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets`). If the path is ambiguous, ask.

## Flow

Invoke `scripts/triage.js`, piping a JSON payload into stdin:

```bash
node ~/.claude/skills/dsc-triage/scripts/triage.js <<'EOF'
{
  "request": "<cURL | raw HTTP | {method,url} pair>",
  "errorResponse": { "status": 403, "body": { "error": "insufficient_scope" } },
  "providedScopes": { "source": "clientList", "scopes": ["sfcc.shopper-products"] },
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets",
  "cacheRoot": "/Users/<you>/.cache/dsc-scrape"
}
EOF
```

Defaults: `cacheRoot` defaults to `~/.cache/dsc-scrape`, `scrapeScript` defaults to `~/.claude/skills/dsc-scrape/scripts/scrape.js`. Omit them unless you need to override.

`triage.js` prints a JSON object on stdout with:
- `errorClass` – one of `AUTH_MISSING_SCOPE`, `AUTH_INVALID_CLIENT`, `AUTH_INVALID_TOKEN`, `AUTH_UNAUTHORIZED`, `REQUEST_MISSING_REQUIRED`, `REQUEST_WRONG_TYPE`, `REQUEST_BAD_SHAPE`, `UNKNOWN`.
- `handsOff` – `true` when `errorClass === 'UNKNOWN'`. If true, tell the user: "I can't diagnose this class of error against the spec alone – it likely involves runtime state the spec doesn't describe (basket state, replication, session context). Check your logs, or wait for `dsc-runtime-triage` once it's built."
- `scopeDiff` – `{required, provided, providedSource, missing}`.
- `shapeDiff` – array of `{kind, ...}` findings. Kinds: `method-mismatch`, `query-missing-required`, `header-missing-required`, `wrong-content-type`, `body-missing-required`, `body-wrong-type`, `body-malformed-json`.
- `confidence` – `high | medium | low`.
- `sources` – list of public DSC URLs. **Cite only these URLs** in your reply. Never mention the local cache path.

## Output composition

Write a short prose diagnosis naming the root cause and the fix, followed by a structured Diff section quoting the relevant fields, followed by a Sources section listing the public URLs from `sources[]`. Template:

```
## Diagnosis
<One paragraph: what's failing, why, and what to change. Cite the DSC URL inline.>

Confidence: <high | medium | low> – <reason based on providedSource>.

## Diff

### Scopes
- Required:  <list>
- Provided:  <list>
- Missing:   <list>

### Request shape
- <one line per shapeDiff finding, or "OK" if empty>

## Sources
- <url 1>
- <url 2>
```

When `providedSource === 'clientList'`, always include this disclaimer after the prose:

> Registered client scopes are not the same as scopes actually in the access token. If the token is available, rerun with it for a definitive answer.

When `handsOff === true`, do not write a Diff or a confident diagnosis – write a short paragraph saying the error class is outside what the spec can explain, name the likely runtime causes *only if you can cite a public doc* (which you usually can't – so just say "check runtime state" and name the categories: session, replication, tenant config), and stop. Do not guess.

## What this skill doesn't do

- **No runtime calls.** Doesn't hit the customer's sandbox, doesn't introspect tokens against SLAS, doesn't fetch anything beyond what `dsc-scrape` does.
- **No fix proposals for `UNKNOWN`.** Hands off.
- **No parsing of non-SCAPI error envelopes** (WAF, CDN, raw HTML) – classifies those as `UNKNOWN` and stops.
- **No local cache paths in output.** Cite `sources[]` only.

## Prerequisites

- `dsc-scrape` skill installed at `~/.claude/skills/dsc-scrape/` (the default path `scrape-refresh.js` looks for).
- `~/.cache/dsc-scrape/` exists and is writable.
- Node.js (same as `dsc-scrape`'s requirement).

If `triage.js` exits 3 with "dsc-scrape script not found", tell the user to install the `dsc-scrape` skill.
