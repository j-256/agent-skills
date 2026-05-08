# stepped-demo-script

Claude Code skill that authors a **self-contained bash script that walks a human through a multi-step demo** – announcing each step, pausing between them, and asserting expected-vs-actual outcomes. Claude loads [`SKILL.md`](./SKILL.md) via the `Skill` tool when a matching user request arrives, then composes a script from the prelude + alphabet defined in `templates/`, `examples/`, and `references/`.

The reader is usually not the author – could be a teammate, a stakeholder, a support engineer on the other side of a ticket. The output is a single bash file that lands legibly in a paste buffer.

## What it does

A user asks *"write me a script I can paste into a terminal that reproduces this flow on sandbox X"* and gets back a ~60-line bash file that:

- Opens with a fixed, well-tested prelude (jq fallback, glyph constants, color guards, five helper functions)
- Narrates each step with `announce "what I'm about to do"`
- Runs one or two commands, output included
- Pauses after each step so the reader can read the output before continuing (skippable via `DEMO_NO_PAUSE=1`)
- Asserts outcomes with `expect "X"` (correct behavior, ✅) or `expect "X" "Y"` (misbehavior, ❌ expected vs. actual)

No external deps (`jq` is optional – the shim falls back to `cat`). Respects `NO_COLOR`. Auto-skips pauses when stdin isn't a terminal (pipelines, CI).

## When to invoke

Whenever the user wants a runnable script that demonstrates a process by calling out each step and pausing for the reader. Common shapes:

- **API sequence** – cURL calls showing a flow (auth → create → fetch → verify), often a customer-ticket repro or a "correct vs. broken" side-by-side.
- **CLI walkthrough** – commands in a shell or tool (`git`, `kubectl`, a CLI the user is teaching).
- **Mixed** – any sequence where each step is one or two commands whose output the reader should look at before moving on.

Skip for: non-interactive pipelines (CI, batch jobs – they shouldn't pause), single-command jobs (nothing to step through), tutorial documents (that's Markdown, not bash).

## The prelude

Every generated script starts with ~22 lines that define the alphabet:

```bash
command -v jq >/dev/null 2>&1 && _jq() { jq ${NO_COLOR:+-M} "$@"; } || _jq() { cat; }
c=$'\342\234\205'  # ✅ check
x=$'\342\235\214'  # ❌ cross
# ...color guards...
announce() { ... }
section()  { ... }
expect()   { ... }   # polymorphic: one arg = ✅, two args = ❌ expected/actual
pause()    { ... }   # honors DEMO_NO_PAUSE and non-tty stdin
```

The prelude is **non-negotiable and inlined into every script**. This is the whole point: the reader never has to install a helper library, source an external file, or read Claude's documentation to understand what the script does. See [`references/primitives.md`](./references/primitives.md) for the rationale behind each one.

## Example

**Input (user prompt):**

> Write me a runnable bash script I can paste into a terminal to demonstrate this flow against the public GitHub API: (1) look up the repo 'cli/cli', (2) pull its top 3 contributors, (3) look up the first contributor's user profile.

**Output** (trimmed – the full output runs to ~50 lines):

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

## Installation

```bash
cd ~/.claude/skills
ln -s /path/to/this/repo/skills/stepped-demo-script stepped-demo-script
```

Zero runtime dependencies – scripts are plain bash. Generated scripts are themselves dependency-free (`jq` optional; everything else is POSIX or bash builtins).

## How it works

```
stepped-demo-script/
├── SKILL.md                  # triggering + authoring flow Claude follows
├── README.md                 # this file
├── templates/
│   └── minimal.sh            # bare skeleton: prelude + one step
├── examples/
│   ├── api-sequence.sh       # GitHub API walkthrough (functions, section, two-arg expect)
│   └── cli-walkthrough.sh    # git merge-conflict demo in a mktemp sandbox
└── references/
    └── primitives.md         # rationale + patterns for the five helpers
```

Trigger-accuracy evals live at the repo root under `evals/stepped-demo-script/`.

The interesting file is `SKILL.md`. It teaches Claude:

1. **How to read the user's request** – is this actually a stepped demo (runnable, paste-and-run, human-watching-output), or something else (tutorial doc, CI script, single long command)?
2. **When to pick an example vs. start from the template** – match the closest existing shape rather than composing from scratch.
3. **The alphabet** – five functions (`announce`, `section`, `expect`, `pause`, `_jq`) + five constants, composed in a stable pattern (`announce → command → expect? → pause`).
4. **What *not* to add** – no sixth primitive for a shape that appears once, no retry loops, no `set -e` that would mask step-level failures, no parallel helper stack with its own `banner`/`describe`/`assert_*` vocabulary (the alphabet already covers these).

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

- `DEMO_NO_PAUSE=1` – blast through every step without pressing Enter.
- `NO_COLOR=1` – strip ANSI codes from narrator lines and `_jq` output.

## Design decisions (and deliberate non-decisions)

- **Self-contained, not sourced.** Every script inlines the prelude. A helper library saves ~22 lines in the author's editor but loses the "paste and run" contract for the reader.
- **Five primitives, no more.** `info`/`warn`/`note`/`summary` helpers would be thin wrappers around `echo` – each earns a slot only if it appears often enough to pay rent. A bare `echo "(cookieId: $cookieId)"` for one-off context is fine.
- **`expect` is polymorphic on arity, not two primitives.** `expect "X"` for correct behavior, `expect "X" "Y"` for misbehavior. Flipping between modes as the author's understanding of the bug evolves shouldn't require renaming calls.
- **No third "uncertain" mode for `expect`.** If the author doesn't know what's correct, the demo isn't ready.
- **Inline pause, not wrapped.** `read -rp "..." && printf '\033[A\033[2K\n'` is one line; hiding it in a `pause()` function saves nothing and adds a call-site indirection – except that `pause()` *also* handles `DEMO_NO_PAUSE` and non-tty stdin. That earns it a function slot.
- **No `set -e`.** A failing step is often the point. `set -e` would mask the very mismatch the reader is there to see.
- **No auto-cleanup trap for sandboxes.** The reader often wants to poke around after the demo finishes. A trailing "rm -rf this when you're done" line is friendlier than unconditional cleanup.

## Limitations

- **Bash only.** The prelude uses `bash`-specific features (`$'...'`, `[[ ... ]]`, `local`). Not POSIX-portable. If the target shell is `/bin/sh`, you're writing a different kind of script.
- **macOS / Linux assumed.** No BusyBox shims, no portability to ancient `bash` (pre-4), no Windows. If your demo needs to run on a NAS or an embedded device, the prelude assumptions break.
- **The reader chooses when to continue.** Auto-advancing after N seconds, or waiting on a specific keypress, isn't supported – doing so would mean a less accessible demo.
- **Not a test framework.** `expect` is for *demonstrating* an outcome to a human, not for gating a CI job. If you want structured pass/fail with exit codes, use a test runner.

## Eval results

Iteration 1 (one run per config, Sonnet 4.5, 3 test cases):

| Configuration | Pass rate | Assertions |
|---|---|---|
| With skill | **100%** | 34/34 |
| Baseline (no skill) | 27% | 9/34 |

Delta: **+0.73 pass-rate points**. Baselines consistently reinvented parallel vocabulary (`banner`, `describe`, `run_cmd`, `assert_eq`, `assert_nonempty`) and inflated setup to ~60 lines before the demo body begins. With-skill runs converged on the five-function alphabet every time.

Eval set: `evals/stepped-demo-script/trigger-eval.json`.
