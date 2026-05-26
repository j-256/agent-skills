# Eval harness for Claude Code skills

A trigger-accuracy + synthesis-behavior eval harness with a live dashboard, built around `claude -p`. Used in this repo to validate the DSC skill family; works against any skill installed under `~/.claude/skills/`.

## Why this exists

`skill-creator:run_eval.py` is the documented eval harness that ships with the skill-creator plugin. On this machine it produces misleading numbers because it registers skills as slash commands under UUID-suffixed names (`.claude/commands/<name>-skill-<uuid>.md`); slash commands appear in `slash_commands` but NOT in the `skills` list surfaced to Sonnet's `Skill` tool, so `Skill` invocations route to globals instead of the synthetic. The harness scores those routings as misses even though the real skill triggered.

The harness in this directory installs the skill-under-test as a clean-name symlink under `~/.claude/skills/` and invokes the real CLI to score the actual `Skill` tool calls in the stream-json transcript. Two scoring layers:

- **Trigger:** did the right skill fire? Pass = first `tool_use` in transcript is `Skill` with input matching `--skill-name`.
- **Synthesis:** did the right skill fire AND did the answer hold up to typed assertions (regex against final text, regex against tool inputs, tool-sequence-includes)?

A single dashboard surfaces in-flight runs of both kinds with a per-(fixture, run) segmented progress bar.

## Architecture

```
        +-------------------+
        | _retry_aware_     |   spawn + bail on api_retry budget
        | subprocess.py     |   exhaustion or wall-clock timeout
        +---------+---------+
                  ^
                  |
        +---------+---------+
        | _eval_runner.py   |   ProcessPoolExecutor dispatch,
        |                   |   abort-on-first-timeout,
        |                   |   results envelope, canonical
        |                   |   stderr line, startup banner,
        |                   |   fixture-id assignment
        +----+---------+----+
             ^         ^
   +---------+--+   +--+----------+
   | trigger-   |   | synthesis-  |   thin wrappers: fixture
   | eval.py    |   | eval.py     |   loading, scoring callback,
   +-----+------+   +------+------+   summary callback
         |                 |
         +--------+--------+
                  v
         +-----------------+
         | eval-monitor.py |   reads ps for live workers,
         |                 |   reads .output files for finished
         |                 |   runs, renders an HTML dashboard
         +-----------------+
```

Principle: the runner owns *how* runs are dispatched and aborted; the harnesses own *what* a run means.

## Files

| File | Responsibility |
|---|---|
| `_env.py` | Tiny `.env` loader; runs at import time so harnesses can read `DSC_EVAL_MODEL` etc. without external dependencies. |
| `_retry_aware_subprocess.py` | `run_with_retry_aware_bail`: spawns `claude -p`, streams stdout to a transcript file, watches for `api_retry` events, bails when the CLI's retry budget is exhausted (`attempt == max_retries`) or a wall-clock backstop fires. Used by the runner to keep CLI internal retries from counting against the harness's wall clock. |
| `_eval_runner.py` | Shared library both harnesses delegate to. Owns: process-pool dispatch, abort-on-first-timeout, results-JSON envelope, canonical stderr progress line, startup banner, `assign_fixture_ids` with collision detection. Does NOT know fixture schemas or scoring rules. |
| `trigger-eval.py` | Trigger-accuracy harness. Loads `trigger-eval.json`, validates, calls `run_eval` with `score_trigger_run` (which walks the transcript for the first `tool_use`) and a `summarize` callback (per-query trigger rate >= 0.5 matches `should_trigger`). |
| `synthesis-eval.py` | Synthesis-behavior harness. Loads `synthesis-eval.json`, validates fixture schema and assertion kinds, calls `run_eval` with `score_synthesis_run` (parses transcript, evaluates typed assertions) and a strict-or-lenient `summarize` callback. |
| `eval-monitor.py` | Read-only HTML dashboard. Greps `ps` for live trigger/synthesis workers, parses the canonical stderr line from each, renders per-(skill, kind) state with a segmented bar. Also walks finished `.output` files via the runner's startup banner. Stdlib only; no pip install. |
| `test_*.py` | Unit tests. Run with `python3 -m unittest tools.test_<name>`. |

## Fixture schemas

### `trigger-eval.json`

A flat array of fixtures. Each fixture is one query the harness fires N times.

```json
[
  {
    "name": "scopes-shopper-products",
    "query": "what scopes does shopper-products getProducts need?",
    "should_trigger": true
  },
  {
    "query": "what's the difference between OCAPI and SCAPI?",
    "should_trigger": false
  }
]
```

| Field | Required | Description |
|---|---|---|
| `query` | yes | The prompt to send to `claude -p`. |
| `should_trigger` | yes | `true` if the skill should fire; `false` for a decline-test (the harness scores the inverse outcome as a pass). |
| `name` | optional | Stable id for the fixture. If omitted, the runner assigns `q0`, `q1`, ...; if the resulting `qN` collides with a hand-authored `name`, the runner skips that index and uses the next. |

Pass criterion (per fixture): trigger rate across runs >= 0.5 matches `should_trigger`. Default `--runs 3`, so 2-of-3 runs must trigger correctly.

### `synthesis-eval.json`

A flat array of fixtures. Each fixture has typed assertions evaluated against the resulting transcript.

```json
[
  {
    "name": "mcg-citation-leak",
    "query": "list the MCG references in the Salesforce dev catalog",
    "expected_skill": "dsc-scrape",
    "hypothesis": "MCG triggers dsc-scrape; final text cites only public URLs.",
    "assertions": [
      {
        "kind": "tool_input_matches",
        "tool": "Bash",
        "field": "command",
        "pattern": "dsc-scrape",
        "because": "MCG asks must route through dsc-scrape's catalog index"
      },
      {
        "kind": "final_text_excludes",
        "pattern": "/Users/.*\\.cache/dsc-scrape",
        "because": "answer must cite developer.salesforce.com URLs, not local cache paths"
      }
    ]
  }
]
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique id for the fixture (used for transcript filenames + stderr line + dashboard). Schema error if duplicated. |
| `query` | yes | The prompt. |
| `expected_skill` | optional | If set, the run fails when the first `tool_use` is `Skill` with a different skill name. |
| `hypothesis` | optional | Free-text note carried through to results.json for human review. |
| `assertions` | optional | Array of typed checks. Empty = `expected_skill` is the only criterion. |

Assertion kinds:

| Kind | Required fields | Behavior |
|---|---|---|
| `final_text_matches` | `pattern` | Regex against the final answer; fail if no match. |
| `final_text_excludes` | `pattern` | Regex against the final answer; fail if it matches. |
| `tool_input_matches` | `tool`, `field`, `pattern` | At least one tool_use of `tool` must have its `input.<field>` match `pattern`. |
| `tool_sequence_includes` | `pattern` | Regex against the newline-joined sequence of tool names; fail if no match. |

Every assertion takes a `because` field documenting the rule's intent; surfaced in failure reports verbatim.

Pass criterion (per fixture): `expected_skill` matched (if set) AND every assertion passed. Default mode is strict (every run of every fixture must pass); `--lenient` switches to majority-pass.

## Running an eval

### Trigger

```bash
python3 tools/trigger-eval.py \
    --eval evals/dsc-endpoint-help/trigger-eval.json \
    --skill-name dsc-endpoint-help \
    --runs 3 --workers 4 --timeout 1800 \
    --out evals/dsc-endpoint-help/runs/iteration-N/results.json
```

| Flag | Default | Description |
|---|---|---|
| `--eval` | required | Path to a `trigger-eval.json` fixture file. |
| `--skill-name` | required | Clean skill name (matches the install symlink under `~/.claude/skills/`). |
| `--runs` | 3 | Runs per fixture. |
| `--workers` | 4 | Concurrent `claude -p` subprocesses. |
| `--timeout` | 1800 | Wall-clock backstop in seconds. Primary bail signal is api_retry exhaustion; this fires only for hung processes. |
| `--cwd` | current dir | CWD for `claude -p` subprocesses. |
| `--out` | required | Where to write results.json. Created with parents. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | All fixtures pass. |
| 1 | At least one fixture fails. |
| 3 | Aborted on api_retry budget exhaustion or wall-clock timeout. Continuing measurements after a budget-exhaustion event would mix real failures with throttle noise; re-run when the gateway has recovered. |

### Synthesis

```bash
python3 tools/synthesis-eval.py \
    --eval evals/dsc-scrape/synthesis-eval.json \
    --runs 5 --workers 4 --timeout 240 \
    --out evals/dsc-scrape/runs/iteration-N/results.json
```

Same shape, with these differences from trigger:

| Flag | Default | Description |
|---|---|---|
| `--skill-name` | not used | Synthesis takes per-fixture `expected_skill`. |
| `--runs` | 5 | Higher than trigger because assertion failures can be noisy. |
| `--timeout` | 240 | Lower than trigger because synthesis runs are typically shorter. |
| `--lenient` | off | Pass if majority of runs pass. Default is strict (every run must pass every assertion). |

Synthesis additionally retains per-run stream-json transcripts at `runs/<iteration>/transcripts/<out-stem>/<fixture>-<N>.jsonl` for offline debugging. Trigger runs use a tempfile that's unlinked after scoring.

Exit code 2 is unique to synthesis: fixture schema error (returned before any runs spawn). Otherwise the codes match trigger.

## Capturing a worked example

When a synthesis-eval (or trigger-eval) run produces a teammate-shareable answer, commit it under `docs/examples/<scenario-slug>.md`. The file is the human-facing entry point for that example, so it must include the *prompt* that triggered the answer, not just the answer text. A reader opening one of these in isolation should be able to reproduce or contextualize the run without grepping the eval fixtures.

Each example is a single file. Don't introduce a directory just to hold one Markdown file -- if a future example needs companion artifacts (a transcript snippet, a diagram), promote `<slug>.md` to `<slug>/README.md` at that point. Until then, the flat layout keeps the catalog scannable.

Required shape:

```markdown
## Prompt

> <verbatim query from the eval fixture, blockquoted; multi-line prompts use multi-line blockquotes>

Skill: `<skill-name>`. Captured from `evals/<skill>/<eval-file>.json` fixture `<fixture-name>` (run <N> of `<iteration-name>`).

## Answer

<verbatim final-answer text from the transcript>
```

For `stepped-demo-script` (where the deliverable is a file written via the `Write` tool, not a chat answer), include both the chat handoff and the file content:

```markdown
## Answer (chat)

<one-line handoff from the transcript's result event>

## Answer (file written to /tmp/<scenario-slug>.sh)

```bash
<file content from the Write tool_use event>
```
```

The `## Prompt` section should always come from the fixture's `query` field verbatim (not paraphrased). The provenance line below it lets a future maintainer reproduce the run -- iteration directory + fixture name + run index together specify exactly which transcript was extracted.

## The dashboard

```bash
# one-shot CLI summary
python3 tools/eval-monitor.py

# HTML dashboard at http://localhost:8765
python3 tools/eval-monitor.py serve

# pin to a specific Claude Code session by name or UUID prefix
python3 tools/eval-monitor.py serve --session my-session-name
python3 tools/eval-monitor.py serve --session 0fc37026

# auto-open in default browser
python3 tools/eval-monitor.py serve --open
```

What it shows:

- **Per-(skill, kind) skill rows.** A skill running both trigger and synthesis in parallel renders as two rows.
- **Segmented progress bar.** One cell per `(fixture, run)`. Green = pass, red = fail, gray = pending. Pass/fail colors come from the runner's `pass=` field on the canonical stderr line.
- **Active subprocess table.** Per-worker runtime, total api_retry events, latest attempt N/M, last error.
- **Recent completions table.** Last 5 completed runs per skill row, with elapsed + retry counts + first 80 chars of query.
- **Session scoping.** The dashboard pins to one Claude Code session at a time. Layered detection: explicit `--session` flag, then this dashboard's own bash parent's `.output` file, then any live trigger/synthesis worker's bash parent, then youngest `.output` globally within `DASHBOARD_MAX_AGE_HOURS` (default 4h).
- **JS polling.** 5s when active runs exist, 30s when idle, pauses after ~3 min of no change. Click "refresh now" to resume.
- **Read-only.** The dashboard never spawns runs or writes anything except the HTTP responses. Safe to start/stop mid-eval.

Stop with Ctrl-C. The monitor process is decoupled from in-flight evals; restarting it doesn't affect them.

## Adding a new eval kind

Two files plus the monitor regex:

1. **Author the harness.** Copy `synthesis-eval.py` as a template. Replace the fixture schema, the scoring callback, and the `summarize` callback. Each is one function, ~15-25 lines. The harness owns:
   - Fixture loading and validation (raise `FixtureSchemaError` on bad shapes; harness catches and exits 2)
   - The `score_run(fixture, transcript_path, bail) -> (pass: bool, kind_extra: dict)` callback
   - The `summarize(fixtures_with_runs) -> list` callback (per-fixture pass aggregation)
   - argparse with kind-specific flags and defaults
   - The `main()` glue that calls `run_eval(...)`

2. **Add the kind to the canonical stderr line regex.** In `_eval_runner.py`'s `PROGRESS_LINE_RE`, extend the `kind=` alternation to include the new kind. Also `STARTUP_BANNER_RE`. Mirror the change in `eval-monitor.py`.

3. **Update the monitor's `EVAL_HARNESS_RE`** to include the new harness's filename, and update `find_eval_pythons` to derive `skill` from whichever flag your harness takes (or the `--eval` parent dir, like synthesis).

4. **Add tests** under `test_<kind>_eval.py` mirroring the existing pattern.

The runner's interface (`run_eval` signature, `RunRecord` shape, abort policy) is the contract; the harness shouldn't need to touch the runner.

## Stderr line and startup banner

Both harnesses go through the runner, which emits one canonical line shape per completed run and one banner at startup.

Progress line:
```
[N/M] kind=<trigger|synthesis> pass=<True|False> fixture_id=<id> run=<R> elapsed=<s>s retries=<n> timeout_reason=<none|retry_budget|wall_clock> first_tool=<tool|-> first_skill=<skill|-> failed_asserts=<n>: <query truncated to 80>
```

All trailing fields (`timeout_reason`, `first_tool`, `first_skill`, `failed_asserts`) are required on every line. Sentinel values for kind-irrelevant slots: `timeout_reason=none`, `first_tool=-` / `first_skill=-` (no tool fired), `failed_asserts=0` (trigger or synthesis-with-all-assertions-passing).

Startup banner (emitted once before the first task completes):
```
=== eval starting: kind=<kind> skill=<skill> eval=<eval-path> runs=<R> workers=<W> total_fixtures=<N> ===
```

The dashboard parses both; `tail -f` on the underlying `.output` file is human-readable as-is. The banner exists so the dashboard can bind a finished run's `.output` file to `(skill, kind)` without inferring from the progress lines, and so the qpass denominator can render correctly from the start of the run.

The format is centralized in `_eval_runner._format_progress` and `_eval_runner.format_startup_banner`. To switch to JSONL later, change those two functions; the regex in `eval-monitor.py` follows.

## Configuration via `.env`

The harnesses read configuration from `.env` at the repo root (gitignored) via `_env.py`. See `.env.example` for the full list. Common knobs:

| Variable | Default | Description |
|---|---|---|
| `DSC_EVAL_MODEL` | `sonnet` | Model identifier passed to `claude -p --model`. Pin the exact gateway-accepted identifier (e.g. `claude-sonnet-4-6`) rather than relying on the `sonnet` alias, which resolves to the older Sonnet on this gateway. |
| `DASHBOARD_MAX_AGE_HOURS` | `4` | Recent-fallback window for session detection in `eval-monitor.py`. Stale `.output` files older than this don't surface as "this session". |

Existing environment values win over `.env`; `.env` only fills gaps. No-op if `.env` is missing.

## Limitations and out-of-scope

- **Sequential dashboard binding for finished runs.** A skill's finished `.output` file is bound to `(skill, kind)` via the runner's startup banner, which means pre-rename `.output` files (from the probe-eval era) don't surface. They're not deleted; they just fall through silently.
- **No backward compatibility with `skill-creator:run_eval.py` fixture format.** The shapes are different.
- **Single-host only.** No multi-machine eval distribution.
- **Synthesis fixtures are not auto-discoverable.** Each skill that wants synthesis coverage authors its own `synthesis-eval.json`. Trigger-evals can be run against any installed skill without authoring synthesis fixtures.
- **The dashboard is single-session-pinned.** Two parallel Claude Code sessions each running their own evals appear in two separate dashboards; cross-session aggregation is not supported.
- **Throughput is gateway-limited.** Running with `--workers 4` against an unloaded gateway is roughly 4x of `--workers 1`; against a loaded gateway, gateway throttle dominates and `--workers 2` may match `--workers 4` at lower retry frequency. The dashboard surfaces retry events; treat high retry rates as a signal to lower workers.
- **`total_fixtures` from the startup banner is not yet plumbed into the live progress-bar sizing.** The dashboard derives bar width from observed `(fixture_id, run)` pairs as they arrive; the banner field is parsed and bound but not yet used to pre-size the bar. Pre-sizing is queued as a follow-up so the bar's denominator settles immediately rather than growing across the first sweep.

For the open feedback list (progress-bar reliability, retry-counter relabeling, ETA, timeout-rate banner, etc.) see the iteration tracking under `evals/<skill>/iteration-*.md` and the brief filed during the unification iteration.
