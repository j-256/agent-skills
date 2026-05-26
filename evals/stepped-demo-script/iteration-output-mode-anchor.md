# iteration-output-mode-anchor

Status: SHIPPED. Resolves both `iteration-todo-worktree-contamination.md` and the bimodal output-mode regression filed in `iteration-synthesis-baseline`. stepped-demo-script synthesis-eval moves from 14/15 → 15/15 strict; worktree contamination drops from 3/15 → 0/15. One SKILL.md addition (one new step in "The authoring flow") addresses both findings.

## Hypothesis tested

The two regressions filed during the stepped-demo-script synthesis-baseline iteration share an upstream cause: SKILL.md was silent on *where* to write the script. As a result, the model picked one of two delivery shapes (Write to file / inline in chat) and one of two file paths (absolute under `/tmp/` / relative under CWD) per run, with no clear signal on which. The composition layer's "compose a single bash file" prose ambiguous on whether "file" meant a real file on disk.

Fix: one new step ("Step 7") in "The authoring flow" anchoring three things together:
- The deliverable is a real file written via the `Write` tool.
- The default path is `/tmp/<scenario-slug>.sh` (absolute, in /tmp/, slug-named).
- The chat answer is a one-line handoff, not the script.

The fix is prose-only -- no script edits, no template edits.

## What changed

One file, one new step.

### `skills/stepped-demo-script/SKILL.md` "The authoring flow" -- step 7 added

The existing flow had 6 steps covering scenario elicitation, example selection, prelude, body composition, function-extraction, and read-back. None said anything about *delivery shape*. New step 7:

> **Write the script to disk via the `Write` tool, defaulting to `/tmp/<scenario-slug>.sh`.** The chat answer is a one-line handoff pointing at the file path -- not the script itself in a fenced block. Two reasons: (a) inlining the script in chat gives the user an unnecessary copy-paste-and-save step before they can run it; (b) writing to a relative path (e.g. `./demo.sh`, `squash-demo.sh`) pollutes whatever directory the user invoked the skill from -- they may be inside a repo, and the demo doesn't belong there. Default to `/tmp/<scenario-slug>.sh`; pick a different absolute path only if the user names one. The user-facing chat answer should be ~1-2 sentences pointing at the file (e.g. "Script is at `/tmp/find-delete-demo.sh` -- run it with `bash /tmp/find-delete-demo.sh`. Each step pauses for Enter.").

The step explicitly anchors all three properties (Write tool, /tmp/, slug-named) in one paragraph because they're a single decision the model has to make once per invocation. Splitting them into separate steps would make the decision ambiguous about where to put the path-choice rationale.

The negative examples (`./demo.sh`, `squash-demo.sh`) are taken from the actual contaminating filenames in the baseline iteration's git-squash runs (`squash-demo.sh`, `squash-onto-main.sh`). The model has visibility on what the canonical regression shape was.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/stepped-demo-script/synthesis-eval.json --runs 5 --workers 4 --timeout 300 --out evals/stepped-demo-script/runs/iteration-output-mode-anchor/results.json`

Wall-clock 257.3s (down from 467.1s on the baseline iteration -- 45% reduction). Exit code 0. 0 retries, 0 aborts.

| Fixture | Pre-fix (baseline) | Post-fix | Worktree contamination delta |
|---|---|---|---|
| `synthesis-demo-curl-httpbin-uas` | 4/5 | 5/5 | 0 → 0 |
| `synthesis-demo-git-squash-walkthrough` | 5/5 | 5/5 | 3 → 0 |
| `synthesis-demo-misbehavior-two-arg-expect` | 5/5 | 5/5 | 0 → 0 |

Total: 15/15 strict (up from 14/15). Worktree contamination: 0/15 (down from 3/15). Routing correctness: 15/15.

The bimodal output-mode regression is fully resolved -- the curl-httpbin run that previously inlined the script in chat (run 1 in baseline) now writes to disk in all 5 runs of this iteration.

The worktree contamination is fully resolved -- all 5 git-squash runs now write to `/tmp/<scenario-slug>.sh` instead of contaminating the worktree CWD with relative paths.

## Surprises

- **The fix dropped wall-clock by 45%.** Mean elapsed per run dropped from ~31s to ~17s. The model spends fewer turns deliberating about the location decision when the anchor removes the choice. Speed wasn't a stated goal but the side effect is large enough to mention.
- **No regression on the 14 runs that already passed in baseline.** Adding a new mandatory step (Write tool) could in principle have flipped some passing runs to failing if the new step's path was somehow incompatible with their behavior. It wasn't. All 14 baseline-passing runs still pass; the 1 new pass is the inlined-script-in-chat run that now writes to disk.
- **The same prose anchor resolved both findings.** I'd budgeted for the possibility that the bimodal output-mode and the worktree contamination needed separate fixes (different layers of the model's decision). They didn't -- the location-decision is one decision, and anchoring it covers both shapes.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| stepped-demo-script synthesis-eval | 15/15 strict | 15/15 strict | yes |
| Worktree contamination | 0/15 | 0/15 | yes |
| No regression on existing assertions | unchanged pass count | 9 assertions × 5 runs = 45 of 45 | yes |
| Wall-clock | < 467.1s baseline | 257.3s | yes (bonus) |
| SKILL.md word count | ≤ +30 lines | +5 lines (one step) | yes |

## Next steps

stepped-demo-script is fully green at 15/15 strict, 0 contamination. Ready for the worked-example backfill task to capture a clean post-fix transcript (any of the 15 passing runs is suitable; pick whichever is closest to real teammate usage -- likely curl-httpbin or find-delete since they're shorter and more shareable).

Both filed TODO notes (`iteration-todo-worktree-contamination.md` and the bimodal-output-mode regression in `iteration-synthesis-baseline.md`) should be marked RESOLVED to close the trail.
