# AGENTS.md

Repository-specific guidance for coding agents working on this Agent Skills repository. Keep platform-wide preferences in the user's global instructions rather than duplicating them here.

## Repository overview

This repository distributes five Agent Skills as three self-contained Agent Plugins:

- `plugins/dsc/` contains `dsc-endpoint-help`, `dsc-scenario`, `dsc-scrape`, their shared runtime, tests, documentation, and examples
- `plugins/fork-and-pr/` contains the `fork-and-pr` skill and its example
- `plugins/stepped-demo-script/` contains the `stepped-demo-script` skill, examples, template, and reference material

The DSC family works against Salesforce API references on `developer.salesforce.com`. See [`plugins/dsc/docs/dsc-skills.md`](plugins/dsc/docs/dsc-skills.md) for its architecture, boundaries, coverage, and extension guidance.

## Canonical paths and compatibility

The plugin directories under `plugins/` are canonical. Edit source files there.

Root paths under `skills/`, `docs/commerce-auth-matrix.md`, `docs/dsc-skills.md`, and `docs/examples/` are compatibility symlinks. Preserve them so clients and links that use the former direct-skill layout continue to work.

Each plugin carries three manifests whose identity, version, description, and license must stay synchronized:

- `plugin.json` for the portable Agent Plugins specification
- `.codex-plugin/plugin.json` for Codex
- `.claude-plugin/plugin.json` for Claude Code

The repository catalogs are `.agents/plugins/marketplace.json` for Codex and `.claude-plugin/marketplace.json` for Claude Code. Both expose the same three plugin names and use repository-relative sources.

Plugin packages must be self-contained after copying or caching. A symlink inside a plugin may target another path in that same plugin but must never escape the plugin root. The three DSC skill `lib` symlinks intentionally target `plugins/dsc/shared/`.

## Skill descriptions

Every `SKILL.md` frontmatter `description` is a single line capped at 300 Unicode characters. Descriptions must distinguish positive triggers, close sibling boundaries, and important declines without relying on the skill body.

Run `node scripts/validate-skills.mjs` after any description or skill-layout change. For behavior changes, run the relevant trigger suite with all sibling skills present so displacement remains visible.

## DSC citation contract

Every factual DSC answer cites a public `developer.salesforce.com` URL, never a local cache path or skill file. Preserve this rule in skill instructions, output composition, tests, and examples because engineers forward these answers outside their local environment.

## Validation

Run the repository validators for every distribution change:

```bash
node scripts/validate-skills.mjs
node scripts/validate-distribution.mjs
```

Run every offline DSC suite after changing the DSC package or shared runtime:

```bash
bash plugins/dsc/shared/tests/run.sh
bash plugins/dsc/skills/dsc-scrape/tests/run.sh
bash plugins/dsc/skills/dsc-endpoint-help/tests/run.sh
bash plugins/dsc/skills/dsc-scenario/tests/run.sh
```

Validate Claude manifests and the marketplace after changing package metadata:

```bash
claude plugin validate --strict plugins/dsc
claude plugin validate --strict plugins/fork-and-pr
claude plugin validate --strict plugins/stepped-demo-script
claude plugin validate --strict .claude-plugin/marketplace.json
```

Also validate each portable `plugin.json` against the schema named in its `$schema` field. A detached-copy check for each changed plugin is the strongest portability test: copy only that plugin directory to a temporary location, then run its tests and manifest validators there.

## Eval harness

The `stream-eval` submodule under `harness/` provides Claude-backed trigger and synthesis evaluation. That harness is intentionally Claude-specific test infrastructure; the shipped skills and plugin runtimes remain agent-neutral.

First-time setup:

```bash
git submodule update --init harness
git config submodule.recurse true
pipx install -e ./harness
```

Use an isolated profile by default so globally installed skills cannot shadow the skill under test:

```bash
stream-eval trigger \
  --skill-path skills/<name> \
  --eval evals/<name>/trigger-eval.json \
  --runs <runs> --workers <workers> \
  --out evals/<name>/runs/iteration-<name>/results.json

stream-eval synthesis \
  --skill-path skills/<name> \
  --eval evals/<name>/synthesis-eval.json \
  --runs <runs> --workers <workers> \
  --out evals/<name>/runs/iteration-<name>/results.json
```

Build and edit skills with the strongest available reasoning model, but evaluate triggering and synthesis on the representative Sonnet target configured through `STREAM_EVAL_MODEL`. Pin an exact accepted model identifier when alias drift would make measurements incomparable.

Tracked eval state lives under `evals/<name>/`; heavy run artifacts under `evals/<name>/runs/` are ignored. Write an iteration note only when the run produced a measurement, a genuine surprise, a rejected alternative, or a precedent the diff cannot preserve. Before deleting a note, grep for inbound citations from fixtures and other notes.

Do not weaken fixtures merely to turn a failure green. Fix skill behavior when the assertion represents the intended contract; change an assertion only when it is narrower than that contract, and update its `because` field to state the corrected intent.

## Skill architecture

- `SKILL.md` frontmatter controls discovery; the body owns the workflow
- Bundled scripts use paths relative to their skill directory and must not assume a particular client's home directory or tool names
- DSC scripts take JSON on stdin and emit JSON on stdout where practical
- DSC tests use `node:assert/strict`, keep one concern per file, and run through each package's `tests/run.sh`
- The DSC shared library owns network access, parsing, caching, and public citation metadata; synthesis skills consume it rather than reimplementing fetches

## Adding, renaming, or removing a skill or plugin

Update every affected surface in the same logical change:

- The canonical plugin directory and its package README
- All three plugin manifests
- Both marketplace catalogs
- Root compatibility symlinks
- Root `README.md` and [`docs/distribution.md`](docs/distribution.md)
- Relevant validators, tests, eval fixtures, and sibling descriptions

Grep the full worktree for the old name or path before committing. Version bumps must be applied to all three manifests for that plugin.

## Commit messages

Use Conventional Commits. Common scopes are the skill name, `plugins`, `distribution`, `docs`, and `eval`.

Commit messages and tracked documentation must reference only files and measurements available in this repository. Do not cite private scratch paths, external tracking notes, or mutable commit hashes.

## Style

- Use spaced en dashes in prose and reserve `--` for source code and CLI flags
- Prefer template literals over string concatenation in JavaScript
- Subclass `Error`, set `this.name`, and export the error beside the throwing function
- Keep tracked prose soft-wrapped with one source line per paragraph

## Deferred scope

The shipped DSC family covers spec-grounded scraping, endpoint help, and multi-call scenarios. Runtime-grounded error analysis remains deferred until a documentation scraper exists that can support it without fabricated answers.
