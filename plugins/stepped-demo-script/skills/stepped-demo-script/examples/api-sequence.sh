#!/bin/bash
# Demo: GitHub unauthenticated API. Look up a repo, its top contributor, the
# user's profile, and surface a real-world mismatch (the old "master" default
# branch vs. the modern "main"). Shows:
#   - announce / expect / pause around each step
#   - lifting a repeated call into a function (get_user runs twice)
#   - section to split phases
#   - two-arg expect to flag an actual mismatch (expected vs. actual differ)

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

owner="j-256"
repo="sh"

get_user() {
    local login="$1"
    announce "GET /users/$login"
    curl -s "https://api.github.com/users/$login" | _jq
}

section "Look up a repo and its top contributor"

announce "GET /repos/$owner/$repo"
curl -s "https://api.github.com/repos/$owner/$repo" | _jq '{full_name, description, stargazers_count, language}'
expect "full_name: $owner/$repo"
pause

announce "GET /repos/$owner/$repo/contributors (top 3)"
top_contributor=$(curl -s "https://api.github.com/repos/$owner/$repo/contributors?per_page=3" \
    | _jq -r '.[0].login')
echo "top contributor login: $top_contributor"
expect "a non-empty login string"
pause

get_user "$top_contributor"
expect "a 'login' field matching $top_contributor"
pause

section "Asking for a user that shouldn't exist"

# Same function, different input — that's the point of lifting it.
get_user "this-user-definitely-does-not-exist-9e7f3a"
expect "404 Not Found (the login is intentionally nonsense)"
pause

section "Demonstrating a mismatch with two-arg expect"

announce "Check the default branch name on $owner/$repo"
# Many older tutorials and scripts still hardcode "master". This surfaces the drift.
actual_branch=$(curl -s "https://api.github.com/repos/$owner/$repo" | _jq -r '.default_branch')
expect "master" "$actual_branch"
pause
