# CLAUDE.md

Repo-specific guidance for Claude Code sessions working on this skills repo.
Complements the user's global `~/.claude/CLAUDE.md` (don't duplicate platform-wide
rules here — this file is only for what's specific to this repo).

## Repository overview

A collection of Claude Code skills, most of them tooling for Salesforce
developer docs (`developer.salesforce.com`, "DSC"). The scraper and
synthesis patterns are generic against any DSC reference family; see
[`docs/dsc-skills.md`](docs/dsc-skills.md) for the per-skill / per-family
coverage matrix and known gaps. Each
skill lives under `skills/<name>/` with its own `SKILL.md`, `scripts/`,
`lib/`, `tests/`, and `README.md`. Shared utilities live in
`skills/_shared/` and are consumed via a symlinked `lib/` dir inside each
skill (so a skill that's installed as `~/.claude/skills/<name>/` can still
resolve its imports).

For the design rationale behind the four-skill DSC family (layers,
boundaries, extension guidance), see [`docs/dsc-skills.md`](docs/dsc-skills.md).

## Core convention: cite public URLs, not local paths

Every DSC skill in this repo makes factual claims about Salesforce APIs.
The family-wide rule is that each claim cites a `developer.salesforce.com`
URL — never a local cache path (`~/.cache/dsc-scrape/...`) or a skill file
path. Engineers forward these answers to customers; a local path isn't
shareable. When editing a skill, check that the output composition section
of its `SKILL.md` preserves this. Regressions on this rule are easy to
miss and expensive to unwind.

## Running and evaluating skills

### Installation

Skills in this repo are designed to run when installed as symlinks under
`~/.claude/skills/` with clean names (no UUID suffixes, no `-skill-xxx`
decoration). To install:

```bash
ln -s "$PWD/skills/dsc-<name>" ~/.claude/skills/dsc-<name>
```

This matches how end users install them. **Also the only registration mode
that evals correctly** — see below.

### Evaluating trigger accuracy

`skill-creator:skill-creator` ships a `run_eval.py` harness that, on this
machine, produces misleading numbers. Two reasons:

1. It registers the skill-under-test as a slash command
   (`.claude/commands/<name>-skill-<uuid>.md`). On this harness version
   slash commands appear in `slash_commands` but NOT in the `skills` list
   surfaced to Sonnet's `Skill` tool. Sonnet's thinking output has
   confirmed it sees the real clean-name skill from description but treats
   the UUID-suffixed synthetic as a different entity — it routes to real
   globals instead, which the harness doesn't detect as triggers.
2. `find_project_root()` walks up from `Path.cwd()` looking for `.claude/`
   and finds `~/.claude/` before reaching any actual repo — planting
   synthetics in the user's personal commands dir.

There's a local patch to `run_eval.py` in the plugin cache (`--project-root`
flag + skill-dir registration) but even with that, the UUID-suffix issue
remains. **The honest eval path is:**

- Install the skill as a clean-name symlink under `~/.claude/skills/`.
- Run `tools/probe-eval.py` (manual `claude -p` harness in this repo) against
  the clean name:
  ```bash
  python3 tools/probe-eval.py \
    --eval evals/dsc-triage/trigger-eval.json \
    --skill-name dsc-triage \
    --runs 3 --workers 4 --timeout 240 \
    --out evals/dsc-triage/runs/iteration-N/results.json
  ```
- The harness scores by inspecting the first `tool_use` event in the
  stream-json: if it's the `Skill` tool with input matching the target
  skill name, count as trigger; otherwise (different skill, different
  tool, text-only, timeout) count as miss.

Eval state for each skill lives under `evals/<name>/`:

- `trigger-eval.json` (tracked) – the authored query set.
- `iteration-<descriptive-name>.md` (tracked) – per-iteration prose
  notes: hypothesis tested, what changed, query-level breakdown, surprises.
- `runs/iteration-<descriptive-name>/results.json` (gitignored) – the heavy
  probe-eval output. Filename matches the notes file.

Cite the iteration name in the commit message (e.g.
`eval(dsc-endpoint-lookup): einstein coverage 23/23 under Sonnet 4.5
(iteration-einstein-coverage)`) so `git log` and the notes cross-reference.

### Model targeting for evals

**Build skills on Opus, eval them on Sonnet.** Design and implementation
conversations run on Opus (the parent model); eval invocations run on
Sonnet. The average user running these skills is on Sonnet, not Opus,
so a skill that passes only on Opus doesn't ship something useful –
the SKILL.md description and scripts have to be clear enough for the
weaker reasoner. This is about test-result correctness, not cost.

## Skill architecture

Each skill follows a common shape — see any of `skills/dsc-*/SKILL.md` for
the pattern, but key points for consistency:

- `SKILL.md` frontmatter `description` drives triggering; it's the single
  most important field. Leading with *what the skill requires* (specific
  endpoint, failing request + body, etc.) and following with *what it
  declines* reads better to Sonnet than leading with the positive case
  alone — it primes the decline logic.
- Scripts take JSON on stdin, emit JSON on stdout. See
  `skills/dsc-triage/scripts/triage.js` for the canonical shape.
- `lib/` inside a skill is a symlink to `_shared/` — so the skill stays
  installable as `~/.claude/skills/<name>/` without breaking imports.
- Tests are `node:assert/strict`, one concern per file, picked up by
  `bash tests/run.sh` — exit 0 on success, prints `ok`.

## Adding, renaming, or removing a skill

When you add a new skill (`skills/<name>/`), rename an existing one, or
remove one, update the root `README.md` to match *in the same commit*:

- **Skills table** – add/rename/remove the row under "## Skills."
- **Install block** – add/rename/remove the matching `ln -s` line.

Forgetting this leaves the root README drifted from the actual skill
set – installers follow the root README, and a missing row means the
skill is shipped-but-invisible.

## Commit message style

Follows Conventional Commits — the types we use in this repo:

- `feat(<skill>):` — new functionality in a skill
- `refactor(<skill>):` — internal cleanup with no user-visible change
- `docs(<skill>):` — SKILL.md / README-level changes
- `test(...):` — new tests or eval artifacts
- `chore(...):` — gitignore, scaffolding, cross-cutting cleanups
- `eval(<skill>):` — eval-driven description tweaks. Cite the numbers
  (`17/20 under Sonnet 4.5`) and the eval set referenced.

## Style

- **Dashes:** en-dash (`–`, U+2013) in prose; em-dash (`—`) and
  double-hyphen (`--`) in prose are style bugs. CLI flags (`--force`)
  untouched.
- **Strings:** template literals, not `+` concatenation.
- **Error classes:** subclass `Error` with `this.name = 'ClassName'`,
  exported alongside the throwing function.

## Scope of the current skills

Phase 1 (spec-grounded errors): `dsc-scrape`, `dsc-endpoint-lookup`, `dsc-triage`,
`dsc-scenario`. Complete on this branch.

Phase 2 (runtime-grounded errors): `dsc-docs-scrape`, `dsc-runtime-triage`.
Explicitly deferred — see `docs/superpowers/specs/2026-04-29-dsc-workflow-skills-design.md`
§8 for the rationale and the mandatory build order (`dsc-docs-scrape` first;
`dsc-runtime-triage` cannot be built before it without forcing fabricated
answers, the exact failure mode this family exists to prevent).
