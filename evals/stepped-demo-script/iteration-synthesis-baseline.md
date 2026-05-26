# iteration-synthesis-baseline

Status: SHIPPED WITH FINDINGS. 14/15 runs strict (2 of 3 fixtures pass 5/5; curl-httpbin fixture passes 4/5 due to a bimodal output-mode regression: the skill sometimes writes the script to a file via Write, sometimes inlines it in a fenced bash block in the chat answer. First synthesis-eval run captured for stepped-demo-script.

## Hypothesis tested

The stepped-demo-script skill should pass synthesis-eval baselines on three fixture shapes seeded from `trigger-eval.json`:

1. **API-style demo** -- 3 cURL calls with pause-between (smallest possible API repro).
2. **CLI-style walkthrough** -- git rebase flow (non-API, non-curl; same primitives must apply uniformly).
3. **Misbehavior demo with own-sandbox** -- `find -delete` reproduction in a tempdir (exercises the two-arg `expect` form per SKILL.md).

The skill's deliverable is a bash script. After an initial fixture-authoring miss using `final_text_matches` (returned 0/15 because the bash never lands in the chat -- it's written to a file), the assertions were rewritten to target `tool_input_matches` on `Write.content`. This is NOT the same artifact-class as the dropped tool-path assertions in `iteration-synthesis-assertion-relaxation`: that iteration removed assertions where alternate paths (`Agent` / MCP search / `WebFetch`) produced equivalent customer outcomes. Here the file IS the customer outcome -- there's no alternate path where the bash content lands somewhere else (with one bimodal exception, see below).

## What changed

New file `evals/stepped-demo-script/synthesis-eval.json` with 3 fixtures, 9 assertions total. All assertions are `tool_input_matches` on `Write.content` (the file the skill writes is the deliverable; the chat answer is just a 50-650 char handoff). Per CLAUDE.md, the no-helper-bloat assertion (`final_text_excludes` on invented helpers like `info()`, `warn()`, `summary()`) was dropped from the original fixture design because the harness has no `tool_input_excludes` kind -- adding the kind to the harness would be the right move if that guard becomes load-bearing later.

No SKILL.md edits, no script edits.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/stepped-demo-script/synthesis-eval.json --runs 5 --workers 4 --timeout 300 --out evals/stepped-demo-script/runs/iteration-synthesis-baseline/results.json`

Wall-clock 467.1s. Exit code 1 (one fixture under-passes; harness correctly surfaces this). 0 retries, 0 aborts.

| Fixture | Pass count | Mean elapsed | Failure mode |
|---|---|---|---|
| `synthesis-demo-misbehavior-two-arg-expect` | 5/5 | 76.6s | -- |
| `synthesis-demo-git-squash-walkthrough` | 5/5 | 130.0s | -- (3 of 5 contaminated worktrees, see below) |
| `synthesis-demo-curl-httpbin-uas` | 4/5 | 47.6s | run 1: skill emitted the bash inline in a fenced chat block instead of writing to a file; see "Bimodal output-mode regression" below |

14/15 runs strict pass (93.3%). Routing correctness (`expected_skill: stepped-demo-script` matched): 15/15.

## Bimodal output-mode regression (real finding, not fixture noise)

`synthesis-demo-curl-httpbin-uas` run 1 produced a chat answer of the form:

> Here's the script:
>
> ```bash
> #!/bin/bash
> # --- Demo prelude ----------------------------------------------------
> command -v jq >/dev/null 2>&1 && _jq() { jq ${NO_COLOR:+-M} "$@"; } || _jq() { cat; }
> ...full script with prelude, three announce/curl/expect/pause blocks, etc...
> ```
>
> Save it, `chmod +x demo.sh`, and run.

The bash content was complete and correct -- prelude verbatim, three `pause` invocations, no helper bloat. It would have passed all the original `final_text_matches` regexes. But it does NOT call `Write` -- the script is delivered as a fenced block in the chat for the user to copy out, not as a file at a deterministic path.

The other 4 runs of the same fixture (and all 10 runs of the other two fixtures) wrote the script to a file via `Write`, with a 50-650 char chat answer pointing at the file. This is bimodal output-mode behavior: the skill picks one of two delivery shapes per run, with no clear signal on which.

**Consequence for users:** if a teammate runs this skill and gets the chat-inline mode, they have to copy out the bash and save it themselves before they can run it. If they get the Write-to-file mode, the path is given and they `bash /tmp/<demo>.sh` directly. The two modes have meaningfully different ergonomics.

**SKILL.md doesn't prescribe a delivery shape.** The relevant section reads "compose a single bash file" -- ambiguous about whether the file is on disk or in chat. The fix is one prose anchor under "The authoring flow" or "Things not to do":

> Default to writing the script to disk via the `Write` tool at `/tmp/<scenario-slug>.sh`. Don't inline the entire script in a chat code block -- the chat answer should be a one-line handoff pointing at the file. Inlining gives the user a copy-paste step they don't need.

Filing this as a tracked open finding for the SKILL.md prose-tightening iteration that's already accumulating from the dsc-scenario synthesis-baseline (OCAPI path-prefix + SLAS shrug).

**Why this fixture isn't relaxed:** The assertions correctly identify the bimodal behavior. Relaxing them to `final_text_matches OR tool_input_matches` (whichever path the model chose this run) would mask the regression -- the customer-outcome difference between modes is real. Don't tune fixtures to make red turn green.

## Worktree contamination on git-squash fixture (separate finding)

3 of 5 `synthesis-demo-git-squash-walkthrough` runs (1, 3, 4) contaminated their per-spawn worktree by writing the demo script into the worktree CWD instead of `/tmp/`. Specific paths: `squash-demo.sh`, `squash-onto-main.sh`. The harness's per-spawn worktree isolation (commit 3c22bb3) destroyed the contaminated worktrees; operator repo untouched.

This is a different bug from the inline-vs-file mode above: in these runs the skill did write to a file (Write tool was called), but to the wrong path. The 13 of 15 runs that wrote to `/tmp/<path>.sh` are correct; these 3 used a relative path that landed in CWD. All 3 contamination occurrences are on the git-squash fixture; the curl-httpbin and find-delete fixtures wrote consistently to `/tmp/`.

Plausible reason for the topic-correlated bias: the git-squash demo's *subject matter* is repository operations, which may prime the model toward writing the demo IN a repo (CWD) rather than next to a repo (`/tmp/`). The fix is the same one-line SKILL.md anchor: default to `/tmp/<scenario-slug>.sh`. Filed separately at `evals/stepped-demo-script/iteration-todo-worktree-contamination.md` because it's a topic-priming gap, not the inline-vs-file mode confusion.

## Surprises

- **The original fixture-authoring miss (asserting against `final_text_matches`) returned 0/15.** The signal that "all 15 runs failed every assertion at the same regex" is what surfaced the file-vs-chat mode in the first place; if even one run had passed I might have iterated on regex tuning before noticing the customer-outcome shape.
- **The bimodal output-mode regression and the worktree-contamination regression have the same upstream fix.** A SKILL.md prose anchor at `/tmp/<scenario-slug>.sh` addresses both: (a) makes Write-to-file the explicit default (vs inline-in-chat), and (b) anchors the path under `/tmp/` (vs CWD relative). One follow-up iteration of ~5 SKILL.md lines should resolve both findings.
- **The `tool_input_matches Write.content` design choice was the right call.** Trying to assert against the chat answer first (the dsc-* family pattern) was wrong for this skill's output shape; the file is the deliverable. This is a useful precedent for any future skill whose deliverable is a written artifact rather than a chat answer.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Synthesis-eval (overall) | 15/15 strict | 14/15 strict | partial -- 1 fixture under-passes; finding documented |
| Routing correctness | 15/15 | 15/15 | yes |
| Worked example committed | 1 | (deferred -- pick after this note ships) | partial |
| Worktree contamination | 0/15 | 3/15 (git-squash topic priming) | no -- filed for follow-up |

## Next steps

This iteration ships at 14/15 strict with two tracked findings (one merging into a single SKILL.md tightening that should also address the dsc-scenario findings):

1. Bimodal output-mode (inline-in-chat vs Write-to-file) -- fix is `/tmp/<scenario-slug>.sh` anchor in SKILL.md.
2. Worktree contamination on git-squash fixture -- fix is the same anchor.

Worked example for stepped-demo-script will be backfilled from a passing run as a separate task in this branch (per the original deliverable list); pick from the misbehavior or git-squash 5/5 runs once that task starts.
