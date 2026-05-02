#!/bin/bash
# Demo: git merge-conflict walkthrough in a throwaway repo. The demo creates
# its own sandbox under $TMPDIR and leaves it behind for the reader to poke at.
# Shows:
#   - primitives applied to CLI commands (no cURL/JSON in sight)
#   - the "demo creates its own sandbox" pattern so it can be rerun cleanly
#   - section splitting the setup phase from the conflict demonstration
#   - one-arg expect when the demo is about correct behavior

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

sandbox="$(mktemp -d -t merge-demo-XXXX)"
echo "(sandbox: $sandbox)"
cd "$sandbox" || exit 1

section "Set up a repo with two branches that touch the same line"

announce "git init + initial commit on main"
git init -q -b main
echo "hello" > greeting.txt
git add greeting.txt
git commit -q -m "initial"
git log --oneline
expect "one commit, subject 'initial'"
pause

announce "Create branch 'feature' and change the greeting"
git checkout -q -b feature
echo "hello from feature" > greeting.txt
git commit -qam "feature: rephrase greeting"
git log --oneline
expect "two commits, feature on top"
pause

announce "Back on main, change the same line differently"
git checkout -q main
echo "hello from main" > greeting.txt
git commit -qam "main: rephrase greeting"
git log --oneline
expect "two commits on main, diverged from feature"
pause

section "Provoke the merge conflict"

announce "git merge feature"
# The merge fails on purpose — don't let a nonzero exit kill the demo.
git merge feature || true
expect "CONFLICT in greeting.txt"
pause

announce "git status"
git status --short
expect "UU greeting.txt (both modified)"
pause

announce "Resolve the conflict manually (pick the feature line)"
cat > greeting.txt <<'EOF'
hello from feature
EOF
git add greeting.txt
git commit -q --no-edit
git log --oneline
expect "three commits: a merge commit on top"
pause

section "Done"

echo "(sandbox left at $sandbox — 'rm -rf \"$sandbox\"' to clean up)"
