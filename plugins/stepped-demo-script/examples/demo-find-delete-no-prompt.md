## Prompt

> need a paste-and-run bash demo showing that `find -delete` doesn't prompt before removing files. Should create a tempdir, populate it, run find, show the files are gone. Something I can share on the team channel

Skill: `stepped-demo-script`. Captured from `evals/stepped-demo-script/synthesis-eval.json` fixture `synthesis-demo-misbehavior-two-arg-expect` (run 1 of `iteration-output-mode-anchor`). Both the chat answer and the file the skill wrote are reproduced below.

## Answer (chat)

Script is at `/tmp/find-delete-demo.sh` -- run it with:

```bash
bash /tmp/find-delete-demo.sh
```

Each step pauses for Enter so you can read the output before moving on. Pass `DEMO_NO_PAUSE=1` if you want it to run straight through (useful for screen recording).

---

## What the file contains

```bash
#!/bin/bash
# Demo: find -delete removes files silently, with no confirmation prompt.
# Creates a fresh tempdir, populates it, runs the find, then shows the files are gone.
# Safe to rerun -- each run gets its own tempdir.

# --- Demo prelude ----------------------------------------------------
command -v jq >/dev/null 2>&1 && _jq() { jq ${NO_COLOR:+-M} "$@"; } || _jq() { cat; }
c=$'\342\234\205'  # ✅ check
x=$'\342\235\214'  # ❌ cross
if [[ -z "$NO_COLOR" && -t 1 ]]; then
    DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    DIM=''; BOLD=''; RESET=''
fi
announce() { printf '%s- %s%s\n' "$BOLD" "$*" "$RESET"; }
section()  { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$RESET"; }
expect()   {
    local e="$1" a="${2-$1}"
    if [[ "$e" == "$a" ]]; then
        printf '%s> expected: %s %s%s\n' "$DIM" "$e" "$c" "$RESET"
    else
        printf '%s> expected: %s %s actual: %s%s\n' "$DIM" "$e" "$x" "$a" "$RESET"
    fi
}
pause() {
    [[ -n "$DEMO_NO_PAUSE" || ! -t 0 ]] && return
    read -rp "<Enter to continue...>" && printf '\033[A\033[2K\n'
}
# ---------------------------------------------------------------------

sandbox="$(mktemp -d -t find-delete-demo-XXXX)"
echo "(sandbox: $sandbox)"

section "Set up the sandbox"

announce "Create 5 .log files and 2 .txt files inside the sandbox"
touch "$sandbox/app.log" "$sandbox/error.log" "$sandbox/debug.log" \
      "$sandbox/access.log" "$sandbox/audit.log" \
      "$sandbox/readme.txt" "$sandbox/notes.txt"
ls "$sandbox"
expect "7 files: 5 .log and 2 .txt"
pause

section "Run find -delete"

announce "find \$sandbox -name '*.log' -delete  (no confirmation, no output)"
find "$sandbox" -name '*.log' -delete
expect "no output -- find -delete is silent"
pause

announce "List the sandbox after the delete"
ls "$sandbox"
expect "only the 2 .txt files remain"
pause

section "Cleanup"

announce "Remove the sandbox"
rm -rf "$sandbox"
expect "sandbox gone"
pause

echo "(done)"
```

---

The skill wrote the script via the `Write` tool to a deterministic path (`/tmp/find-delete-demo.sh`), and the chat answer is a one-line handoff pointing at it – no copy-paste-and-save step required. Each step uses the prelude's `announce` / `expect` / `pause` primitives: announce narrates what's about to happen in bold, the command runs and produces output, expect prints the expected outcome, pause waits for Enter so the reader can read before moving on. The `mktemp -d` sandbox makes the demo self-cleaning and re-runnable; the `rm -rf` at the end cleans up.
