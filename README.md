# claude-code-skills

Personal collection of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) skills.

[Skills](https://docs.claude.com/en/docs/claude-code/skills) are self-contained capability packages that Claude Code discovers and invokes on demand. Each directory under [`skills/`](skills/) is one skill – its own `SKILL.md`, supporting scripts, tests, and documentation.

Most of what's here is tooling for Salesforce developer docs (`developer.salesforce.com`, "DSC") – a four-skill family that composes into an API lookup, repro, and triage workflow. The scraper and synthesis patterns target DSC references that publish a machine-readable spec; current coverage and examples lean heavily on B2C Commerce SCAPI, SLAS, and Einstein Recommendations because those are what've been exercised. `stepped-demo-script` is domain-agnostic scaffolding for authoring multi-step terminal demos.

## Skills

| Name | Description |
|---|---|
| [`dsc-scrape`](skills/dsc-scrape/) | Scrape developer.salesforce.com (DSC) API reference pages into structured JSON. Fetch-based – handles OpenAPI 3 (YAML), RAML (AMF JSON), and ReDoc references through one pipeline. |
| [`dsc-endpoint-lookup`](skills/dsc-endpoint-lookup/) | Answer one specific question about a DSC endpoint (scopes, params, body, response schema, auth) by reading `dsc-scrape`'s JSON. Invokes `dsc-scrape` automatically to populate or refresh the cache. |
| [`dsc-triage`](skills/dsc-triage/) | Diagnose a failing SCAPI/OCAPI request against the public spec. Reads a cURL/raw-HTTP request + error response and diffs required vs. provided scopes (decoded from the JWT or from the registered client list) and required vs. actual request shape. Every claim cited to a public developer.salesforce.com URL. |
| [`dsc-scenario`](skills/dsc-scenario/) | Build a multi-call SCAPI/OCAPI repro plan: given a target operation or goal, walks the type graph to find prerequisite calls, composes a linear plan with scope union + ID threading, and emits a runnable cURL block. Every step cited to a public developer.salesforce.com URL. |
| [`stepped-demo-script`](skills/stepped-demo-script/) | Author a self-contained bash script that walks a human through a multi-step demo – pausing between steps so they can read output, and asserting expected vs. actual so pass/fail is visible at a glance. Five-primitive alphabet (`announce`, `section`, `expect`, `pause`, `_jq`) inlined into every script; no sourced helper, no install step for the reader. Domain-agnostic – works for API repros, CLI walkthroughs, and mixed flows. |

## The DSC skill family

The four `dsc-*` skills share a cache at `~/.cache/dsc-scrape/` and compose like this: `dsc-scrape` is the data layer (it's the only one that talks to the network); `dsc-endpoint-lookup`, `dsc-scenario`, and `dsc-triage` are three synthesis layers on top, each doing a different job against the same cache. The scraper and synthesis patterns aren't tied to any one Salesforce product area – they target DSC references that publish a machine-readable spec file (currently OpenAPI 3 (YAML), RAML via AMF JSON, and ReDoc). Coverage today is heaviest on B2C Commerce SCAPI, SLAS, and Einstein Recommendations, because that's what's been exercised end-to-end.

Rough heuristic — the verb in the user's ask usually tells you which fires:

| User says… | Skill |
|---|---|
| "what scopes / params / body / response does X have" | `dsc-endpoint-lookup` |
| "what auth scheme is on X" / "what method is X" | `dsc-endpoint-lookup` |
| "what do I need to call before X" / "prereqs for X" | `dsc-scenario` |
| "chain of calls to reach / produce Y" | `dsc-scenario` |
| "why is this request failing" + a failing request + an error | `dsc-triage` |
| "what scope is missing" + an error body or decoded JWT | `dsc-triage` |
| "scrape / mirror / fetch reference X" | `dsc-scrape` |

The synthesis skills invoke `dsc-scrape` themselves on cache miss — you rarely need to call it explicitly unless the user wants the raw JSON dump.

**Extending the family?** See [`docs/dsc-skills.md`](docs/dsc-skills.md) for the layer diagram, per-skill input/output shapes, and the design rationale behind the boundaries (why the synthesis isn't collapsed into one skill, where the edges are, what's out of scope).

## Install

Claude Code discovers skills from `~/.claude/skills/<skill-name>/`. To install a skill from this repo, symlink its directory in:

```bash
git clone <repo-url>
ln -s "$PWD/claude-code-skills/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/claude-code-skills/skills/dsc-endpoint-lookup" ~/.claude/skills/dsc-endpoint-lookup
ln -s "$PWD/claude-code-skills/skills/dsc-triage" ~/.claude/skills/dsc-triage
ln -s "$PWD/claude-code-skills/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
ln -s "$PWD/claude-code-skills/skills/stepped-demo-script" ~/.claude/skills/stepped-demo-script
```

**Note:** skills in this repo share utilities via `skills/_shared/`, which each skill references through a relative `lib -> ../_shared/` symlink committed to the repo. Clone the whole repo (as above) rather than copying a single skill directory – cherry-picking one skill dir will break its `lib/` symlink.

Copying instead of symlinking also works, but you lose the ability to pull updates with `git pull`.

Each skill has its own `README.md` covering prerequisites (Node version, external tools, MCP servers, etc.) and usage. Check the skill's README before first use.

## License

[MIT](LICENSE).
