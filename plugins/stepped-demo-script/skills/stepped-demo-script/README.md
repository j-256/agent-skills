# stepped-demo-script

An Agent Skill that authors a self-contained bash script that walks a human through a multi-step demo -- announcing each step, pausing between them, and asserting expected-vs-actual outcomes. The reader pastes the file into a terminal and presses Enter to advance.

## What it does

- **Inlines a fixed prelude** (~22 lines: `jq` fallback, glyph constants, color guards, five helper functions) into every script, so the reader never has to install or source anything before running.
- **Composes the body from a five-primitive alphabet** -- `announce`, `section`, `expect`, `pause`, `_jq` -- in a stable pattern (`announce -> command -> expect? -> pause`).
- **Emits a polymorphic `expect`.** `expect "X"` for correct behavior (✅), `expect "X" "Y"` for misbehavior (❌, expected vs. actual). One primitive, two arities.
- **Pauses after every step** so the reader can read the output before continuing -- skippable via `DEMO_NO_PAUSE=1` and auto-skipped on non-tty stdin (CI, pipelines).
- **Respects `NO_COLOR`** and falls back to plain text (and `cat` instead of `jq`) when color or jq isn't available.
- **Writes to `/tmp/<scenario-slug>.sh`** by default -- absolute path, never the user's working directory. Chat answer is a one-line handoff, not the script inlined in a fenced block.
- **Domain-agnostic.** Works for API repros, CLI walkthroughs (git, kubectl, anything with a CLI), or mixed sequences -- the alphabet is the same.

## Not for

- **Non-interactive pipelines** (CI, batch jobs, cron). They shouldn't pause for a human; this skill is built around the pause.
- **Single-command jobs.** If there's nothing to step through, you don't need stepped output.
- **Tutorial documents.** That's Markdown, not bash. The skill emits `.sh`.
- **Domain-specific payloads** (API request bodies, SQL, `kubectl` manifests). Those are your content; this skill authors the scaffolding around them.
- **Salesforce-specific scenario *planning*** ("what do I need to call before `createOrder`"). That's the separately installed `dsc-scenario` skill -- it produces the *plan* of calls, not the paste-and-run bash. Those skills compose: dsc-scenario can hand its plan off to this skill for runnable-script authoring.

## Why you'd want this

Without the skill, an LLM tasked with "write me a runnable demo of X" reliably reinvents a parallel vocabulary every time -- `banner`, `describe`, `run_cmd`, `assert_eq`, `assert_nonempty`, sometimes wrapped in a `set -e` that masks the very mismatch the demo exists to surface. The output runs ~60 lines of setup before the first step, and the reader has to learn the bespoke shape before they can follow along.

Five primitives, no more. The alphabet earns each slot: `announce` and `section` for narration, `expect` polymorphic on arity, `pause` because the body has to handle `DEMO_NO_PAUSE` and non-tty stdin in one place, `_jq` because output formatting shouldn't require `jq` to be installed. A sixth primitive for a one-off shape doesn't earn its rent, so the skill turns it down.

The deliberate non-decisions matter as much as the decisions: no `set -e` (a failing step is often the point), no auto-cleanup trap (the reader often wants to poke around afterward), no third "uncertain" mode for `expect` (if you don't know what's correct, the demo isn't ready), no helper library to source (the script has to be paste-and-run).

## Tested

15/15 strict on synthesis-eval under Sonnet 4.5 (3 fixtures × 5 runs each). Each fixture guards a distinct shape:

| Fixture | What it guards |
|---|---|
| `synthesis-demo-curl-httpbin-uas` | API-style demo with 3 cURL calls, two-leg flow, file-writing delivery (not inlined in chat) |
| `synthesis-demo-git-squash-walkthrough` | CLI walkthrough (non-API, non-curl) -- same primitives apply uniformly; absolute path under `/tmp/` (no working-dir contamination) |
| `synthesis-demo-misbehavior-two-arg-expect` | Misbehavior demo with `expect "X" "Y"`; demonstrates the two-arg form on a `find -delete` repro inside a `mktemp` workspace |

The output-mode anchor (`/tmp/<slug>.sh`, never inlined in chat, never under CWD) catches a real regression class -- pre-fix the skill was bimodal between file-writing and chat-inline delivery, and chat-inline forces the reader to copy-paste-and-save before they can run anything. The source repository records the regression history.

Trigger-eval (one-run, Sonnet 4.5, 3 cases): 100% with skill (34/34 assertions), 27% baseline (9/34). Baselines reinvented parallel vocabulary every run; with-skill runs converged on the five-function alphabet every time.

The source repository carries the fixtures and per-iteration notes.

## What it produces

A ~50-60 line bash file. **Input** (your prompt to the agent):

> Write me a runnable bash script I can paste into a terminal to demonstrate this flow against the public GitHub API: (1) look up the repo `cli/cli`, (2) pull its top 3 contributors, (3) look up the first contributor's user profile.

**Output** (trimmed):

```bash
#!/bin/bash
# --- Demo prelude ----------------------------------------------------
command -v jq >/dev/null 2>&1 && _jq() { jq ${NO_COLOR:+-M} "$@"; } || _jq() { cat; }
c=$'\342\234\205'  # ✅ check
x=$'\342\235\214'  # ❌ cross
# ...color guards, announce/section/expect/pause...
# ---------------------------------------------------------------------

owner="cli"; repo="cli"

announce "GET /repos/$owner/$repo"
curl -s "https://api.github.com/repos/$owner/$repo" | _jq '{full_name, description, stargazers_count}'
expect "full_name: $owner/$repo"
pause

announce "GET /repos/$owner/$repo/contributors?per_page=3"
contributors_json=$(curl -s "https://api.github.com/repos/$owner/$repo/contributors?per_page=3")
echo "$contributors_json" | _jq '[.[] | {login, contributions}]'
top_contributor=$(echo "$contributors_json" | _jq -r '.[0].login')
expect "3 contributors, top one is a non-empty login string"
pause

announce "GET /users/$top_contributor"
curl -s "https://api.github.com/users/$top_contributor" | _jq
expect "a 'login' field matching $top_contributor"
pause
```

The reader pastes, presses Enter three times, and sees ✅/❌ at each step. No hidden state. No cleanup required.

## Install

Install the self-contained [`stepped-demo-script`](../../) plugin. Clients that accept individual Agent Skills can instead install the source repository's `skills/stepped-demo-script` compatibility path.

Zero runtime dependencies -- scripts are plain bash. Generated scripts are themselves dependency-free (`jq` optional via the `_jq` shim; everything else is POSIX or bash builtins).

## How it works

When invoked, the skill:

1. **Elicits the scenario** if not already clear -- what's being demonstrated, in roughly what steps, and whether any of it is misbehavior (so `expect` can surface the mismatch).
2. **Picks the closest example** from `examples/` (API sequence or CLI walkthrough) to seed the structure, or starts from `templates/minimal.sh`.
3. **Composes the body** from the five-primitive alphabet, wrapping repeated calls in shell functions (not new primitives).
4. **Reads the draft back** with fresh eyes -- if a step's purpose isn't obvious from the `announce` line, the announce gets fixed, not the code.
5. **Writes to `/tmp/<scenario-slug>.sh`** through the active client's file-writing capability. The chat answer is one or two sentences pointing at the file.

```
stepped-demo-script/
├── SKILL.md                  # triggering + authoring flow
├── README.md                 # this file
├── templates/
│   └── minimal.sh            # bare skeleton: prelude + one step
├── examples/
│   ├── api-sequence.sh       # GitHub API walkthrough (functions, section, two-arg expect)
│   └── cli-walkthrough.sh    # git merge-conflict demo in a mktemp workspace
└── references/
    └── primitives.md         # rationale + patterns for the five helpers
```

The interesting file is `SKILL.md`. It teaches the agent:

1. **How to read the user's request** -- is this actually a stepped demo (runnable, paste-and-run, human-watching-output), or something else (tutorial doc, CI script, single long command)?
2. **When to pick an example vs. start from the template** -- match the closest existing shape rather than composing from scratch.
3. **The alphabet** -- five functions + five constants, composed in a stable pattern.
4. **What *not* to add** -- no sixth primitive for a shape that appears once, no retry loops, no `set -e` that would mask step-level failures, no parallel helper stack with its own `banner`/`describe`/`assert_*` vocabulary.

## The alphabet (at a glance)

| Function | Purpose | Rendered output |
|---|---|---|
| `announce "msg"` | Narrator line before a command | `- msg` (bold) |
| `section "title"` | Phase boundary in a multi-part demo | `== title ==` (bold, blank line above) |
| `expect "X"` | Assert correct behavior | `> expected: X ✅` |
| `expect "X" "Y"` | Assert misbehavior (X ≠ Y) | `> expected: X ❌ actual: Y` |
| `pause` | Wait for Enter; erase prompt | (interactive only) |
| `_jq [filter]` | jq-or-cat fallback | pretty-printed JSON, raw if no `jq` |

`$c` / `$x` are exposed directly for hand-rolled summary lines. `$DIM` / `$BOLD` / `$RESET` are available but rarely needed at call sites.

Environment escape hatches:

- `DEMO_NO_PAUSE=1` -- blast through every step without pressing Enter.
- `NO_COLOR=1` -- strip ANSI codes from narrator lines and `_jq` output.

## Design decisions (and deliberate non-decisions)

- **Self-contained, not sourced.** Every script inlines the prelude. A helper library saves ~22 lines in the author's editor but loses the "paste and run" contract for the reader.
- **Five primitives, no more.** `info`/`warn`/`note`/`summary` helpers would be thin wrappers around `echo` -- each earns a slot only if it appears often enough to pay rent. A bare `echo "(cookieId: $cookieId)"` for one-off context is fine.
- **`expect` is polymorphic on arity, not two primitives.** Flipping between modes as understanding of a bug evolves shouldn't require renaming calls.
- **No third "uncertain" mode for `expect`.** If the author doesn't know what's correct, the demo isn't ready.
- **Inline pause, not wrapped.** `read -rp "..." && printf '\033[A\033[2K\n'` is one line; hiding it in `pause()` saves nothing -- except that `pause()` *also* handles `DEMO_NO_PAUSE` and non-tty stdin. That earns it a function slot.
- **No `set -e`.** A failing step is often the point. `set -e` would mask the very mismatch the reader is there to see.
- **No auto-cleanup trap for workspaces.** The reader often wants to poke around after the demo finishes. A trailing "rm -rf this when you're done" line is friendlier than unconditional cleanup.

## Tests

No unit tests; the deliverable is prose-and-bash composition, validated end-to-end through synthesis-eval and trigger-eval. The source repository carries the fixtures and per-iteration notes.

## Companion skills

- `dsc-scenario` builds a multi-call SCAPI/OCAPI repro plan and can hand its plan output to this skill for "now turn that into a paste-and-run script."
- `fork-and-pr` is domain-agnostic too; it covers the GitHub fork-and-PR flow rather than authoring a stepped demo.

## Limitations

- **Bash only.** The prelude uses `bash`-specific features (`$'...'`, `[[ ... ]]`, `local`). Not POSIX-portable. If your target shell is `/bin/sh`, you're writing a different kind of script.
- **macOS / Linux assumed.** No BusyBox shims, no portability to ancient `bash` (pre-4), no Windows. If your demo needs to run on a NAS or an embedded device, the prelude assumptions break.
- **The reader chooses when to continue.** Auto-advancing after N seconds, or waiting on a specific keypress, isn't supported -- doing so would mean a less accessible demo.
- **Not a test framework.** `expect` is for *demonstrating* an outcome to a human, not for gating a CI job. If you want structured pass/fail with exit codes, use a test runner.
