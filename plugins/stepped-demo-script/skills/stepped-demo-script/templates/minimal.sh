#!/bin/bash
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

announce "Describe the step"
# <command here>
expect "what a correct result looks like"
pause
