# Primitives

The five functions and five constants that make up the prelude. Each one is in the alphabet because it pulls its weight across many demos. Resist adding a sixth – the discipline of keeping the alphabet small is what makes the prelude legible to a first-time reader.

## The constants

### `_jq`

```bash
command -v jq >/dev/null 2>&1 && _jq() { jq ${NO_COLOR:+-M} "$@"; } || _jq() { cat; }
```

A `jq` shim that degrades to `cat` when `jq` isn't installed. Pipe JSON responses through `| _jq` and they stay readable either way – pretty-printed if the reader has `jq`, raw otherwise.

**Why not just require `jq`.** The reader is often not the author, and demos travel via Slack/email/ticket comments. "Install jq first" is a step that derails the flow before the demo even starts. Degrading to `cat` means the script always runs.

**When to pass a filter**: `| _jq '.name'`, `| _jq '{login, id}'` – works transparently whether real `jq` is present (filter is applied) or the shim is active (filter is ignored, full output shown).

**`NO_COLOR`-aware.** When `$NO_COLOR` is set, the shim passes `-M` to `jq` to strip ANSI codes from its output – so JSON output matches the same "no color" contract the narrator lines already honor. On `jq` 1.7+ this would happen automatically, but `-M` keeps older versions behaving consistently.

### `$c` and `$x`

```bash
c=$'\342\234\205'  # ✅ check
x=$'\342\235\214'  # ❌ cross
```

Octal escapes for the check and cross glyphs. `expect` uses them automatically; expose them directly for hand-rolled lines that the primitives don't cover – e.g. a final summary line with mixed results.

**Why octal.** The literal ✅/❌ characters sometimes get mangled when scripts travel through editors with weird encodings, paste boards that normalize Unicode, or terminals configured for a different locale. Octal is stable ASCII and unambiguous.

### `$DIM` / `$BOLD` / `$RESET`

```bash
if [[ -z "$NO_COLOR" && -t 1 ]]; then
    DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    DIM=''; BOLD=''; RESET=''
fi
```

ANSI codes for dim and bold, empty strings when the output is piped or when `NO_COLOR=1` is set. `announce`, `section`, and `expect` use them; you generally shouldn't reach for them directly – if you're styling your own one-off `echo`, that's usually a sign it should be a primitive call instead.

**Why respect `NO_COLOR`.** It's a widely-followed convention ([no-color.org](https://no-color.org)), and demos get redirected to files or pasted back as text often enough that escape codes in the capture are annoying. Costs one line of setup.

**Why `-t 1`.** When stdout isn't a terminal (pipe, redirect), we suppress color for the same reason – a captured transcript shouldn't have `\033[1m` sprinkled through it.

## The functions

### `announce <message>`

Narrator line before a command runs. Bold, prefixed with `- ` so it stands out from command output.

```bash
announce "GET /repos/$owner/$repo"
curl -s "https://api.github.com/repos/$owner/$repo" | _jq
```

Renders as:
```
- GET /repos/anthropics/claude-code
{...JSON output...}
```

**Rule of thumb:** every command whose output the reader should look at gets an `announce` line. Trivial setup lines (`cd`, `export`, variable assignments) don't – they're noise in the narration.

### `section <title>`

Delimits phases of a longer demo. Extra blank line before, bold `==` framing.

```bash
section "Happy path"
# ...steps...
section "Now demonstrating the bug"
# ...steps...
```

Renders as:
```

== Happy path ==
...

== Now demonstrating the bug ==
```

**When to use.** If the demo has one logical arc, skip `section` entirely. If it has two or three ("anonymous user then authenticated user", "setup then provoke the bug then mitigation"), `section` at each boundary gives the reader a reading checkpoint.

### `expect <expected> [<actual>]`

Assert the outcome of the previous step. One arg means "this is the correct behavior" (check mark). Two args mean "expected and actual differ" (cross + both values shown).

```bash
expect "404 Not Found"                              # demo is showing correct behavior
expect "pinned variation group" "just the master"   # demo is showing misbehavior
```

Renders as:
```
> expected: 404 Not Found ✅
> expected: pinned variation group ❌ actual: just the master
```

**Why polymorphic on arity.** Having one primitive keeps the call-site vocabulary small. Demos flip between correct-behavior mode and misbehavior mode as the author's understanding evolves; flipping `expect` to `expect_bug` across the file is friction the author doesn't need.

**Don't codify uncertainty.** A confident demo states what's expected. If the author genuinely doesn't know (e.g. an early repro where the correct behavior is still unclear), that's a script in draft – fix the understanding before polishing the script. The primitive shouldn't grow a third mode for "maybe this is right?".

### `pause`

Wait for the reader to press Enter, then erase the prompt so the scrollback stays clean.

```bash
read -rp "<Enter to continue...>" && printf '\033[A\033[2K\n'
```

Respects `DEMO_NO_PAUSE=1` and auto-skips when stdin isn't a terminal.

**The escape sequence** moves the cursor up one line (`\033[A`), clears that line (`\033[2K`), then newline. Without it the `<Enter to continue...>` prompt accumulates in the scrollback and makes re-reading the transcript noisy.

**`DEMO_NO_PAUSE=1`** lets the reader blast through the whole demo without pressing Enter between steps – handy for "I've already seen this, just run it again and show me the final state."

**`! -t 0`** means "stdin isn't a terminal, so pausing would hang forever" – e.g. `curl ... | bash`, or piping the script into `bash -s`. Auto-skipping is safer than hanging.

## Patterns

### Reusable-call functions

When the same command runs more than once, lift it into a shell function that includes its own `announce`:

```bash
get_recs() {
    announce "GET /recommendations for cookieId $cookieId"
    curl -s "$RECS_URL" ...data... | _jq
}

get_recs
expect "3 results including pinned item"
pause

# Later, in another phase:
section "Now with a different cookie"
cookieId="$(uuidgen)"
get_recs
expect "empty list – no prior activity"
pause
```

The function wraps `announce` + the command. It does *not* wrap `pause` or `expect` – those stay at the call site because step granularity is the caller's call. Same function, two phases, different assertions.

### Multi-phase scripts

A demo that has more than one actor, or one happy-path and one failure-path, should use `section` at each boundary and declare inputs at the top of each phase:

```bash
section "As an anonymous user"
cookieId="$(uuidgen)"
# ...steps...

section "As an authenticated user"
cookieId="$(uuidgen)"
token="$(curl -s ... auth endpoint ...)"
# ...steps...
```

Redeclaring `cookieId` (or whatever varies between phases) inside each section is fine – it makes each phase readable on its own, which matters when the reader is only interested in one of them.

### Demo creates its own sandbox

For CLI walkthroughs that mutate filesystem/state (git demos, database demos, file-munging demos), create a throwaway directory up front and `cd` into it:

```bash
sandbox="$(mktemp -d -t my-demo-XXXX)"
echo "(sandbox: $sandbox)"
cd "$sandbox" || exit 1
```

Leave it behind at the end with a one-liner telling the reader how to clean up. Don't `trap ... EXIT` an auto-cleanup – the reader often wants to poke around after the demo finishes.

### Show the input before operating on it

When a demo operates on input data (a file, an env var, a sample payload), a bare `cat`/`echo` of the input as its own step gives the reader ground truth to compare the output against. Without it, a later `expect` line asserts against a shape the reader has to guess at.

```bash
announce "Write test data to $tmp"
cat > "$tmp" <<'EOF'
Apple
apple
APPLE
EOF
cat "$tmp"
pause

announce "Run 'sort -u' on the input"
sort -u "$tmp"
expect "one line per fruit, case-folded" "three lines, case-preserved"
pause
```

Two steps, not one – the input is its own narrated step. The reader sees what `sort -u` is getting before they see what it produces, and the `expect` line has a concrete basis.

### Hand-rolled lines for one-offs

Not every line needs to be a primitive. The `(cookieId: $cookieId)` line at the top of many API demos is a bare `echo` – it's context, not a step. A bare `echo` is fine. Fight the instinct to add a `context` or `info` helper for every shape that appears once.

When it's obvious from the line's content that it's narration vs. output, skip the primitive. `echo "(sandbox: $sandbox)"` needs no decoration.

## Things the primitives deliberately don't do

- **No `warn`/`note`/`info`.** All three would be thin wrappers around `echo`; none appear often enough to justify a slot.
- **No automatic timing.** `expect` asserts correctness, not speed. If a demo needs to show latency (an optimization walkthrough, a slow-query demo), the author can prepend `time ` to the command – it doesn't need a primitive.
- **No retry loops.** A demo that depends on retry is demonstrating flakiness, not a reproducible flow. Fix the underlying call or document the flakiness in an `announce` line.
- **No structured logging.** The output is for a human reading a terminal. If someone needs machine-readable output, they want a different tool, not a demo script.
