# claude-code-skills

Personal collection of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) skills.

[Skills](https://docs.claude.com/en/docs/claude-code/skills) are self-contained capability packages that Claude Code discovers and invokes on demand. Each directory under [`skills/`](skills/) is one skill — its own `SKILL.md`, supporting scripts, tests, and documentation.

## Skills

| Name | Description |
|---|---|
| [`dsc-scrape`](skills/dsc-scrape/) | Scrape developer.salesforce.com (DSC) API reference pages into structured JSON. Fetch-based — handles OpenAPI 3 (YAML), RAML (AMF JSON), and ReDoc references through one pipeline. |
| [`dsc-query`](skills/dsc-query/) | Answer one specific question about a DSC endpoint (scopes, params, body, response schema, auth) by reading `dsc-scrape`'s JSON. Invokes `dsc-scrape` automatically to populate or refresh the cache. |
| [`dsc-triage`](skills/dsc-triage/) | Diagnose a failing SCAPI/OCAPI request against the public spec. Reads a cURL/raw-HTTP request + error response and diffs required vs. provided scopes (decoded from the JWT or from the registered client list) and required vs. actual request shape. Every claim cited to a public developer.salesforce.com URL. |
| [`dsc-scenario`](skills/dsc-scenario/) | Build a multi-call SCAPI/OCAPI repro plan: given a target operation or goal, walks the type graph to find prerequisite calls, composes a linear plan with scope union + ID threading, and emits a runnable cURL block. Every step cited to a public developer.salesforce.com URL. |

## Install

Claude Code discovers skills from `~/.claude/skills/<skill-name>/`. To install a skill from this repo, symlink its directory in:

```bash
git clone https://github.com/j-256/claude-code-skills.git
ln -s "$PWD/claude-code-skills/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/claude-code-skills/skills/dsc-query" ~/.claude/skills/dsc-query
ln -s "$PWD/claude-code-skills/skills/dsc-triage" ~/.claude/skills/dsc-triage
ln -s "$PWD/claude-code-skills/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
```

**Note:** skills in this repo share utilities via `skills/_shared/`, which each skill references through a relative `lib -> ../_shared/` symlink committed to the repo. Clone the whole repo (as above) rather than copying a single skill directory – cherry-picking one skill dir will break its `lib/` symlink.

Copying instead of symlinking also works, but you lose the ability to pull updates with `git pull`.

Each skill has its own `README.md` covering prerequisites (Node version, external tools, MCP servers, etc.) and usage. Check the skill's README before first use.

## Evaluation

Both new skills (`dsc-triage`, `dsc-scenario`) are designed to be benchmarked with `skill-creator`'s triggering-accuracy evals. **Run these evals under Sonnet 4.6** – that's the tier the average teammate runs, so the behavior it captures is the behavior they'll see. An Opus-passing skill that flakes on Sonnet isn't shippable to the team.

## License

[MIT](LICENSE).
