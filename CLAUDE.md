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

For the design rationale behind the three-skill DSC family (layers,
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

The eval harness lives in a separate repo ([`stream-eval`](<stream-eval-url>)) consumed here as a git submodule mounted at `harness/`. See [`harness/README.md`](harness/README.md) for the harness's own architecture documentation, fixture schemas, and dashboard reference; this section covers integration with this repo.

### First-time setup

```bash
git submodule update --init harness
pipx install -e ./harness
```

[`pipx`](https://pipx.pypa.io) puts `stream-eval` on `$PATH` permanently with its dependencies isolated – no venv to activate before each invocation. The `-e ./harness` (editable) install means `pipx` reads the submodule directly, so the binary tracks whatever SHA the submodule is currently pinned to; bumping the submodule pin in a future commit picks up automatically.

If you don't have `pipx` and don't want to install it, the `pip install -e ./harness` route still works – you just have to `source .venv/bin/activate` in every new shell that will run `stream-eval`, and the editable-via-venv install also requires `python3 -m venv .venv` first.

Run `stream-eval --help` for the full subcommand list (`trigger`, `synthesis`, `monitor`, `fake`).

### Installation (skills under this repo)

Skills in this repo are designed to run when installed as symlinks under `~/.claude/skills/` with clean names (no UUID suffixes, no `-skill-xxx` decoration). From the repo root:

```bash
ln -s "$PWD/skills/dsc-<name>" ~/.claude/skills/dsc-<name>
```

This matches how end users install them. The harness's default `--profile isolated` builds its own temp HOME containing only `--skill-path skills/<name>`, so the symlink is for *interactive* use; trigger/synthesis-eval invocations don't need it once `--skill-path` is wired up.

### Why not `skill-creator:skill-creator`'s `run_eval.py`?

The bundled `skill-creator` plugin ships `scripts/run_eval.py` and it works – we tested it. But it has a footgun that bites the typical contributor workflow: it scores by checking whether the model invoked a UUID-suffixed synthetic slash command, and when a real skill is installed at `~/.claude/skills/<canonical-name>/` (which contributors here typically have, via `ln -s skills/<name> ~/.claude/skills/<name>`), the model preferentially invokes the canonical-named entry. The harness counts that as a miss.

stream-eval avoids the footgun by default (`--profile=isolated` builds a temp HOME with only the skill under test, eliminating the shadowing real install by construction) and adds capabilities `run_eval.py` doesn't have: synthesis evals, a live dashboard with worker control, worktree contamination detection, bail-on-throttle. See [`harness/README.md`](harness/README.md#why-this-exists) for the full comparison and the conditions under which `run_eval.py` does work cleanly.

There's also a separate cleanup gotcha (independent of the shadowing one above): if your project doesn't already have a `.claude/` directory, `run_eval.py` writes its synthetics into your `~/.claude/commands/`. A pre-existing `<project>/.claude/commands/` (even empty) anchors its walk and avoids that – but it doesn't help with shadowing, which is about the skill catalog the model sees, not where the synthetic file lives.

### Evaluating trigger accuracy

`stream-eval trigger` invokes `claude -p` with the real skill installed (under `--profile=isolated`'s temp HOME, or the user's `~/.claude/skills/` under `--profile=inherit`/`restricted`) and scores by inspecting the first `tool_use` event in the stream-json: if it's the `Skill` tool with input matching the target skill name, count as trigger; otherwise (different skill, different tool, text-only, timeout) count as miss.

```bash
stream-eval trigger \
  --skill-path skills/dsc-endpoint-help \
  --eval evals/dsc-endpoint-help/trigger-eval.json \
  --runs 3 --workers 4 --timeout 600 \
  --out evals/dsc-endpoint-help/runs/iteration-N/results.json
```

The harness reads the canonical skill name from `skills/<name>/SKILL.md`'s frontmatter `name:` field. `--skill-name <override>` is available but rarely needed.

Default profile is `isolated`: each spawn runs against a temp HOME containing *only* the skill under test. Your `~/.claude/skills/` is not read or written. Other profiles available via `--profile`:

- `restricted`: user's globally-installed skills visible; MCP / Agent stripped.
- `inherit`: closest to interactive use; nothing stripped.

Eval state for each skill lives under `evals/<name>/`:

- `trigger-eval.json` (tracked) – the authored query set.
- `iteration-<descriptive-name>.md` (tracked) – per-iteration prose notes: hypothesis tested, what changed, query-level breakdown, surprises.
- `runs/iteration-<descriptive-name>/results.json` (gitignored) – the heavy trigger-eval output. Filename matches the notes file.

Cite the iteration name in the commit message (e.g. `eval(dsc-endpoint-help): einstein coverage 23/23 under Sonnet 4.5 (iteration-einstein-coverage)`) so `git log` and the notes cross-reference.

### Evaluating synthesis behavior

`stream-eval trigger` scores triggering only – does the right skill fire? `stream-eval synthesis` runs *above* it, asserting against the full stream-json transcript and the final answer. It catches regressions trigger accuracy can't: citation leaks, cascade-order bugs, hallucinated spec fields, prose-rule violations.

Fixture format: `evals/<skill>/synthesis-eval.json` – array of `{name, query, expected_skill?, hypothesis, assertions[]}` objects. Four assertion `kind`s: `final_text_matches`, `final_text_excludes`, `tool_input_matches` (per-tool input regex), `tool_sequence_includes` (tool-name sequence regex). Each assertion carries a `because` string echoed verbatim into failure reports.

```bash
stream-eval synthesis \
  --skill-path skills/dsc-scrape \
  --eval evals/dsc-scrape/synthesis-eval.json \
  --runs 5 --workers 4 --timeout 600 \
  --out evals/dsc-scrape/runs/iteration-N/results.json
```

Default is `--runs 5` strict (every run must pass every assertion). `--lenient` switches to majority-pass. Exit codes: 0 = all pass, 1 = test failure, 2 = fixture schema error, 3 = aborted on the first run that hit the wall-clock timeout. Code 3 exists because upstream-API throttling typically presents as one timeout, then more – continuing to gather measurements during throttle mixes real failures with noise. The harness bails on the first timeout to keep the signal honest. Per-run transcripts up to the abort point are retained for offline debugging.

Iteration notes: `evals/<skill>/iteration-<descriptive-name>.md` (tracked). Heavy run artifacts: `evals/<skill>/runs/iteration-<name>/` (gitignored). Per-run transcripts retained at `runs/iteration-<name>/transcripts/<out-stem>/<fixture>-<run>.jsonl` for offline debugging – the `<out-stem>` segment is the basename of `--out` without `.json`, so multi-phase iterations (e.g. `results-cold.json` and `results-warm.json` into one iteration dir) get distinct transcript subdirs.

**Don't tune fixtures to make red turn green.** A failing assertion means either the prose is leaking (fix the skill) or the regex is over-strict (fix the regex with a `because` reflecting the new intent). Relaxing patterns to mask real signal defeats the whole apparatus.

### The dashboard

```bash
stream-eval monitor serve --port 8765 --open
```

Live worker-control buttons (`+1`, `-1`, `pause`, `resume`) per row, scoped to the matching harness via Unix socket. Manual control via signals also works:

```bash
kill -USR1 <harness-pid>   # decrement target_workers by 1
kill -USR2 <harness-pid>   # increment target_workers by 1
```

For dashboard development, `stream-eval fake <scenario>` synthesizes `.output` files + in-memory socket servers covering every state (active, completed, aborted, contaminated, legacy, etc.) without spinning up real evals. See `harness/README.md` for the scenario list.

### Model targeting for evals

**Build skills on Opus, eval them on Sonnet.** Design and implementation conversations run on Opus (the parent model); eval invocations run on Sonnet, explicitly. The average user running these skills is on Sonnet, not Opus, so a skill that passes only on Opus doesn't ship something useful – the SKILL.md description and scripts have to be clear enough for the weaker reasoner. This is about test-result correctness, not cost.

The harnesses read the model identifier from `STREAM_EVAL_MODEL` via `.env` (or the environment), defaulting to `sonnet`. See `harness/.env.example` for the full list of variables the harnesses recognize.

Pin an exact identifier in `.env` rather than the `sonnet` alias if your CLI's alias resolution doesn't target the version you want – some deployments resolve `sonnet` to an older release. Pinning also avoids run-to-run reproducibility drift if the alias's target shifts.

Each `results.json` records `harness_version` (the SHA of the submodule pin), so iteration numbers can be correlated to a specific harness commit when triaging regressions.

## Skill architecture

Each skill follows a common shape — see any of `skills/dsc-*/SKILL.md` for
the pattern, but key points for consistency:

- `SKILL.md` frontmatter `description` drives triggering; it's the single
  most important field. Leading with *what the skill requires* (specific
  endpoint, failing request + body, etc.) and following with *what it
  declines* reads better to Sonnet than leading with the positive case
  alone — it primes the decline logic.
- Scripts take JSON on stdin, emit JSON on stdout. See
  `skills/dsc-endpoint-help/scripts/` for the canonical shape.
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
- `eval(<skill>):` – eval-driven description tweaks. Cite the numbers
  (`17/20 under Sonnet 4.5`) and the eval set referenced.

Commit messages, repo docs, and any other in-tree artifact must reference
in-tree files only (iteration notes under `evals/<skill>/`, file paths
under this repo, eval numbers). Don't cite tracking docs that live outside
this repo or aren't checked in – those names are meaningless to anyone
who clones the repo, and leak external workflow structure into the
public history.

## Style

- **Dashes:** en-dash (`–`, U+2013) in prose; em-dash (`—`) and
  double-hyphen (`--`) in prose are style bugs. CLI flags (`--force`)
  untouched.
- **Strings:** template literals, not `+` concatenation.
- **Error classes:** subclass `Error` with `this.name = 'ClassName'`,
  exported alongside the throwing function.

## Scope of the current skills

Phase 1 (spec-grounded errors): `dsc-scrape`, `dsc-endpoint-help`,
`dsc-scenario`. Complete on this branch (dsc-endpoint-help merges what
were dsc-endpoint-lookup and dsc-triage; see iteration-merge-baseline).

Phase 2 (runtime-grounded errors): `dsc-docs-scrape`, `dsc-runtime-triage`.
Explicitly deferred. The mandatory build order is `dsc-docs-scrape` first;
`dsc-runtime-triage` cannot be built before it without forcing fabricated
answers, the exact failure mode this family exists to prevent.
