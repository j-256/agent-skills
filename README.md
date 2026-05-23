# claude-code-skills

Personal collection of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) skills.

[Skills](https://docs.claude.com/en/docs/claude-code/skills) are self-contained capability packages that Claude Code discovers and invokes on demand. Each directory under [`skills/`](skills/) is one skill – its own `SKILL.md`, supporting scripts, tests, and documentation.

Some of these are domain-agnostic – `stepped-demo-script` for authoring multi-step terminal demos, `fork-and-pr` for the standard GitHub fork-and-PR flow. The rest are a three-skill family targeting Salesforce developer docs (`developer.salesforce.com`, "DSC") that composes into an API lookup, repro, and triage workflow. See [`docs/dsc-skills.md`](docs/dsc-skills.md) for the DSC family's per-skill / per-family coverage matrix.

## Skills

| Name | Description |
|---|---|
| [`dsc-scrape`](skills/dsc-scrape/) | Scrape developer.salesforce.com (DSC) API reference pages into structured JSON. Fetch-based – handles OpenAPI 3 (YAML), RAML (AMF JSON), Swagger 2 (OCAPI), and ReDoc references through one pipeline. |
| [`dsc-endpoint-help`](skills/dsc-endpoint-help/) | Answer questions about a Salesforce API endpoint against its public spec on DSC – spec-field lookups (scopes, params, body, response schema, auth) and failing-request diagnosis (cURL + error body together: scope diff, request-shape diff). One skill, two output shapes selected by a runtime branch on the prompt's input shape. Every claim cited to a public developer.salesforce.com URL. |
| [`dsc-scenario`](skills/dsc-scenario/) | Build a multi-call SCAPI/OCAPI repro plan: given a target operation or goal, walks the type graph to find prerequisite calls, composes a linear plan with scope union + ID threading, and emits a runnable cURL block. Every step cited to a public developer.salesforce.com URL. |
| [`stepped-demo-script`](skills/stepped-demo-script/) | Author a self-contained bash script that walks a human through a multi-step demo – pausing between steps so they can read output, and asserting expected vs. actual so pass/fail is visible at a glance. Five-primitive alphabet (`announce`, `section`, `expect`, `pause`, `_jq`) inlined into every script; no sourced helper, no install step for the reader. Domain-agnostic – works for API repros, CLI walkthroughs, and mixed flows. |
| [`fork-and-pr`](skills/fork-and-pr/) | Walk a contributor through forking a GitHub repo they don't own, branching, committing, pushing, and opening a PR back to upstream. Codifies the `gh` + `git` syntax for the standard fork-and-PR flow, with a deliberate pause for the user's edits between branch creation and push. Domain-agnostic. |

## The DSC skill family

The three `dsc-*` skills are peers built on a shared scrape library (`skills/_shared/scrape/`). They share an on-disk cache at `~/.cache/dsc-scrape/` so warming it from one skill benefits the others, but at runtime each is independent: `dsc-scrape` is the user-facing raw-dump skill (fires on "scrape X" / "mirror Y"), and `dsc-endpoint-help` and `dsc-scenario` are two synthesis skills, each doing a different job against the same cache. The library and the synthesis patterns aren't tied to any one Salesforce product area – they target DSC references that publish a machine-readable spec file (currently OpenAPI 3 (YAML), RAML via AMF JSON, Swagger 2 (OCAPI), and ReDoc). Coverage varies per skill and per family: see [`docs/dsc-skills.md`](docs/dsc-skills.md) for the matrix and known gaps.

Rough heuristic — the verb in the user's ask usually tells you which fires:

| User says… | Skill |
|---|---|
| "what scopes / params / body / response does X have" | `dsc-endpoint-help` |
| "what auth scheme is on X" / "what method is X" | `dsc-endpoint-help` |
| "what do I need to call before X" / "prereqs for X" | `dsc-scenario` |
| "chain of calls to reach / produce Y" | `dsc-scenario` |
| "why is this request failing" + a failing request + an error | `dsc-endpoint-help` |
| "what scope is missing" + an error body or decoded JWT | `dsc-endpoint-help` |
| "scrape / mirror / fetch reference X" | `dsc-scrape` |

The synthesis skills warm the cache themselves on miss (via the shared scrape library) — you rarely need to invoke `dsc-scrape` explicitly unless the user wants the raw JSON dump.

**Extending the family?** See [`docs/dsc-skills.md`](docs/dsc-skills.md) for the layer diagram, per-skill input/output shapes, and the design rationale behind the boundaries (why the synthesis isn't collapsed into one skill, where the edges are, what's out of scope).

## Install

Claude Code discovers skills from `~/.claude/skills/<skill-name>/`. To install a skill from this repo, symlink its directory in:

```bash
git clone https://github.com/j-256/claude-code-skills.git
ln -s "$PWD/claude-code-skills/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/claude-code-skills/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
ln -s "$PWD/claude-code-skills/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
ln -s "$PWD/claude-code-skills/skills/stepped-demo-script" ~/.claude/skills/stepped-demo-script
ln -s "$PWD/claude-code-skills/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
```

**Note:** skills in this repo share utilities via `skills/_shared/`, which each skill references through a relative `lib -> ../_shared/` symlink committed to the repo. Clone the whole repo (as above) rather than copying a single skill directory – cherry-picking one skill dir will break its `lib/` symlink.

Copying instead of symlinking also works, but you lose the ability to pull updates with `git pull`.

Each skill has its own `README.md` covering prerequisites (Node version, external tools, MCP servers, etc.) and usage. Check the skill's README before first use.

## Eval harness

This repo ships a working trigger-accuracy + synthesis-behavior eval harness with a live dashboard, used to validate the DSC skills here. It works against any skill installed under `~/.claude/skills/` and can be lifted into other repos.

The harness was built because `skill-creator:run_eval.py` produces misleading numbers on this machine (registers skills as UUID-suffixed slash commands that don't reach the `Skill` tool). See `tools/README.md` for the full architecture, fixture schemas, and dashboard documentation.

Quick start:

```bash
# trigger-eval: did the right skill fire?
python3 tools/trigger-eval.py \
    --eval evals/dsc-endpoint-help/trigger-eval.json \
    --skill-name dsc-endpoint-help \
    --runs 3 --workers 4 \
    --out evals/dsc-endpoint-help/runs/iteration-N/results.json

# synthesis-eval: did the answer hold up to typed assertions?
python3 tools/synthesis-eval.py \
    --eval evals/dsc-scrape/synthesis-eval.json \
    --runs 5 --workers 4 \
    --out evals/dsc-scrape/runs/iteration-N/results.json

# live HTML dashboard at http://localhost:8765
python3 tools/eval-monitor.py serve --open
```

## License

[MIT](LICENSE).
