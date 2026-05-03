# dsc-triage

Diagnose failing requests against Salesforce API specs published on developer.salesforce.com ("DSC"). Current coverage is heaviest on B2C Commerce SCAPI, SLAS, and Einstein; the diff mechanism is generic against any DSC reference `dsc-scrape` can deliver. Companion to [`dsc-scrape`](../dsc-scrape/) and [`dsc-endpoint-lookup`](../dsc-endpoint-lookup/); see each skill's README for its role.

## What it does

Given a failing request (cURL, raw HTTP, or `{method, url}`) plus the error response the customer got back, `dsc-triage` runs a mechanical diff against the spec and returns:

- **Which error class** (missing scope, invalid client, malformed body, etc.) – or `UNKNOWN` if the spec can't explain it.
- **Scope diff** – required vs. provided vs. missing, labelled by where the "provided" list came from (decoded JWT vs. registered client list).
- **Request-shape diff** – method, required params, headers, content-type, body-schema required fields + types.
- **Sources** – the list of public `developer.salesforce.com` URLs backing every claim.

Output is always cited to URLs a customer can open. No local paths.

## Install

```bash
# Clone the whole claude-code-skills repo – don't cherry-pick a single dir,
# because dsc-triage's lib/ is a symlink to ../_shared/.
git clone <repo-url>
ln -s "$PWD/claude-code-skills/skills/dsc-triage" ~/.claude/skills/dsc-triage
```

Requires `dsc-scrape` installed at `~/.claude/skills/dsc-scrape/` (or pass `scrapeScript` explicitly when invoking).

## Usage

See [`SKILL.md`](SKILL.md) for the full invocation contract. Quick shape:

```bash
node ~/.claude/skills/dsc-triage/scripts/triage.js <<'EOF'
{
  "request": "curl -X POST 'https://...' -H 'Authorization: Bearer ...' ...",
  "errorResponse": { "status": 403, "body": { "error": "insufficient_scope" } },
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets"
}
EOF
```

## Tests

```bash
cd ~/.claude/skills/dsc-triage && bash tests/run.sh
```

All tests run offline. Fixtures embed the spec slices they need.
