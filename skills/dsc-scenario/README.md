# dsc-scenario

Compose multi-call SCAPI / OCAPI repro plans for Salesforce B2C Commerce sandboxes. Companion to [`dsc-scrape`](../dsc-scrape/), [`dsc-query`](../dsc-query/), and [`dsc-triage`](../dsc-triage/).

## What it does

Given a target operation, `dsc-scenario`:

- Walks the OAS / AMF type graph to find every operation whose response produces an input the target requires.
- Recurses until it hits primitives or auth material.
- Produces a linear plan (topological order), the scope union, and an ID-passing map.
- Renders a runnable cURL block with placeholder environment variables.

Every step cited to a public `developer.salesforce.com` URL.

## Install

```bash
# Clone the whole claude-code-skills repo – lib/ is a symlink to ../_shared/.
git clone <repo-url>
ln -s "$PWD/claude-code-skills/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
```

Requires `dsc-scrape` at `~/.claude/skills/dsc-scrape/` (or pass `scrapeScript` explicitly).

## Usage

See [`SKILL.md`](SKILL.md). Quick shape:

```bash
node ~/.claude/skills/dsc-scenario/scripts/scenario.js <<'EOF'
{
  "target": "createOrder",
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders"
}
EOF
```

## Sub-agent dispatch

For production, the outer Claude conversation should dispatch a sub-agent for the type-graph walk (keeps JSON reads out of its context). The prompt template is in [`scripts/walk-via-agent.md`](scripts/walk-via-agent.md); `scripts/walk-types.js` exposes `walkViaAgentPrompt({targetSlug, reference, cacheRoot})` to do parameter substitution. Pass the sub-agent's returned graph as the `graph` field in scenario.js's input.

For local runs and tests, `scenario.js` falls back to running `walkTypes` in-process.

## Tests

```bash
cd ~/.claude/skills/dsc-scenario && bash tests/run.sh
```

Tests run offline with tiny fixtures under `tests/fixtures/`.
