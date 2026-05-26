# iteration-todo-worktree-contamination

Status: TODO. Surfaced during the stepped-demo-script synthesis-baseline iteration. Filed for follow-up; not addressed in this branch because it's a SKILL.md prose tightening, not a fixture authoring task.

## The signal

During `iteration-synthesis-baseline` runs, the harness reported worktree contamination on 2 of 15 runs:

```
[10/15] ... synthesis-demo-git-squash-walkthrough run=4 ... contaminated=True
  ! WORKTREE CONTAMINATED on synthesis-demo-git-squash-walkthrough-4: 1 path(s) changed -- squash-onto-main.sh; worktree destroyed (operator repo untouched)
[15/15] ... synthesis-demo-git-squash-walkthrough run=5 ... contaminated=True
  ! WORKTREE CONTAMINATED on synthesis-demo-git-squash-walkthrough-5: 1 path(s) changed -- git-squash-walkthrough.sh; worktree destroyed (operator repo untouched)
```

The contaminating paths -- `squash-onto-main.sh`, `git-squash-walkthrough.sh` -- are *demo scripts the skill wrote into the worktree CWD* instead of `/tmp/`. Both occurrences are on the git-squash fixture; the curl-httpbin and find-delete fixtures wrote consistently to `/tmp/`.

The harness's per-spawn worktree isolation (commit 3c22bb3) caught and destroyed the contaminated worktrees; the operator repo was untouched. So the harness is doing its job. The signal is a real skill-prose issue: the model is bimodal on where to write the script.

## What's likely going on

`SKILL.md` doesn't prescribe a write location -- it tells the model to "compose a single bash file" but doesn't anchor on `/tmp/` or any other path convention. In 13 of 15 runs the model defaulted to `/tmp/<demo-name>.sh`; in 2 runs (both git-squash) it defaulted to writing in the current directory.

Plausible reason for the bimodal: the git-squash demo's *subject matter* is repository operations, which may prime the model toward writing the demo IN a repo (CWD) rather than next to a repo (`/tmp/`). The curl-httpbin and find-delete fixtures don't have that priming. If true, this is a topic-sensitive prompt-priming gap, not a general SKILL.md ambiguity -- but the fix is the same: anchor the write-location explicitly.

## What needs to change

One small SKILL.md edit. Under "The authoring flow" or as a new bullet in "Things not to do," add a write-location anchor:

> Default to `/tmp/<scenario-slug>.sh` for the script's path; write somewhere else only if the user names a different path. Don't write into the current directory by default -- the demo lives next to the user's work, not inside it.

Optionally also tighten `templates/minimal.sh` if it has CWD-implying language (it doesn't currently).

## Pass criteria for the eventual iteration

| Criterion | Target |
|---|---|
| Synthesis-eval contamination rate | 0/15 (down from 2/15) |
| Existing assertions | unchanged pass count |
| SKILL.md word count | ≤ +5 lines (one-bullet anchor, not a section rewrite) |

The fix is small enough that re-running synthesis-eval after the SKILL.md edit is sufficient verification; no fixture changes needed.

## Coupling with other findings

This sits alongside two other tracked findings from the synthesis-eval-readiness branch:

- `evals/dsc-scenario/iteration-synthesis-baseline.md` -- OCAPI path-prefix discipline (2/5 runs elide the canonical `/dw/shop/v\d+/` prefix from the runnable bash block).
- `evals/dsc-scenario/iteration-todo-slas-cross-reference-prose.md` -- SLAS-shrug prose miss + three repo-doc countersignals.

All three are SKILL.md prose tightenings that landed during synthesis-eval baseline measurement and were filed rather than fixed in-band -- the baselines need to measure current behavior, not behavior after the fix. A single follow-up branch could land all three SKILL.md tightenings together.
