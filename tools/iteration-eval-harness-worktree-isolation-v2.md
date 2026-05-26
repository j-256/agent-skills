# iteration-eval-harness-worktree-isolation-v2

Status: SHIPPED. The eval harness no longer runs `claude -p` with cwd set to the operator's repo. Each spawn gets its own ephemeral `git worktree add --detach` checkout under `/tmp/eval-worktrees/<pid>-<spawn>/`; eval-Sonnet's contamination -- branches, submodule entries, file edits, upstream clones, anything -- is contained inside the worktree and discarded by `git worktree remove --force` at teardown. Operator's repo is physically untouchable from the spawn cwd.

## What this iteration was supposed to be

Originally framed as "extend the v1 detection-and-restore loop to cover branch creation and submodule additions" -- the contamination shapes that iteration-baseline observed but iteration-eval-harness-worktree-isolation couldn't restore. The plan was: snapshot HEAD + branch set + submodule paths pre-spawn, restore via `git checkout --force` + `git branch -D` + `git rm --cached` post-spawn.

That design got built (commit-shaped, tests green, a live eval ran with `branch; auto-restored to baseline` lines visible in the log). And then it ate itself.

## The self-eating discovery

When eval-Sonnet ran `git checkout -b feat/phantom` inside the operator's repo (the spawn's cwd), `_restore_branch_state` issued `git checkout --force <main>` to walk HEAD back. The `--force` flag was added to handle "uncommitted edits on the phantom branch" -- because the spawn could have created files there that needed sweeping. **What `--force` actually does is discard ALL uncommitted edits in the working tree, including uncommitted edits to TRACKED files that were the operator's WIP.**

The harness was being edited in-flight (this iteration's `_eval_runner.py` and `test_eval_runner.py` were modified, not yet committed). When the eval fired, the harness ran ITS OWN code, contaminated the operator repo with a branch, then ITS OWN code force-checked-out main -- discarding the in-flight harness edits in the process. By the time the eval finished, the source files on disk had reverted to their pre-iteration state.

Two consecutive runs both showed `branch; auto-restored to baseline` lines and both ended with v2 source code wiped. Initial misdiagnosis -- "another session must be touching these files" -- got ruled out by checking the reflog (single-session, no concurrent activity). The mechanism was the harness reverting itself.

## The pivot

Detection-and-restore on a shared worktree is structurally fragile: every restore primitive that operates on the operator's repo can collide with operator state. The right fix is `git worktree add` per spawn -- each spawn runs in a separate checkout, eval-Sonnet's mutations land only there, teardown is unconditional `git worktree remove --force`. Operator's repo is untouchable because the spawn isn't pointing at it.

The "worktree-at-HEAD" property is what makes this work: the worker sees only committed code, not the operator's in-flight edits. Even if eval-Sonnet were aggressive enough to do a `git checkout` against the worktree's path, it couldn't see (let alone revert) anything the operator hadn't committed.

## Scope

`_spawn_and_bail` now:

- Resolves the operator's repo root (unchanged from v1).
- Creates a per-spawn worktree at `/tmp/eval-worktrees/<pid>-<spawn-id>/` via `git worktree add --detach`. spawn-id encodes a nanosecond timestamp so parallel workers can't collide on the path.
- Snapshots the operator's branch set at create time (stored in a process-local map keyed by worktree path).
- Runs `claude -p` with `cwd=worktree_path`, not `cwd=repo_root`.
- Detects worktree contamination via `_git_dirty_set(wt_path)` -- eval still reports unaudited runs when the spawn left the worktree dirty, even though no restore is needed.
- Tears down: `git worktree remove --force <wt_path>` + `trash <wt_path>` (belt-and-suspenders, in case `git worktree remove` left orphans). Phantom branches that appeared during the spawn (refs are repo-scoped, shared across worktrees) get `git branch -D` against the operator repo's git-common-dir.

The bail dict still surfaces `worktree_contaminated`, `worktree_changed_paths`, `worktree_restore_failures` -- envelope-shape compatibility with iteration-eval-harness-worktree-isolation. Under the new design `worktree_restore_failures` carries any teardown errors instead of restore-step errors; semantically equivalent ("operator must clean by hand").

The v2 detection primitives (`_git_head_state`, `_git_branch_set`, `_git_submodule_paths`, `_restore_branch_state`, `_restore_submodule_state`) are NOT in this iteration's commit. They were the broken design's machinery; under worktree isolation they would only matter for an `assert operator_repo_unchanged` post-eval check, which is verified by the test suite instead (`test_operator_repo_unchanged_after_create_destroy`).

## What changed

**`tools/_eval_runner.py`**

- Two new helpers: `_create_worker_worktree(repo_root, spawn_id)` and `_destroy_worker_worktree(wt_path)`. Module-level `WORKTREE_ROOT = "/tmp/eval-worktrees"` and `_WORKTREE_BRANCHES_AT_CREATE = {}` (process-local snapshot map).
- `_spawn_and_bail` rewritten: cwd swap to worktree, detection via `_git_dirty_set(wt_path)`, teardown in a `try/finally` so a runner crash still triggers cleanup.
- Stderr forced to line-buffering at the top of `run_eval` so progress lines flush as they're written -- the dashboard polls the `.output` file every 5s and was reading 0/60 the entire eval because stderr was fully-buffered when piped to a file. Side fix surfaced when reviewing the v2 eval's dashboard behavior.
- `_restore_worktree_paths` retains the directory-trash branch I added when fixing the v1 directory gap (`os.unlink` errors on a directory, `trash` handles it). The function survives because contamination detection still runs on the worktree -- if a teardown failure leaves residue, file-level recovery is a last resort. Untouched by the worktree pivot.
- `! WORKTREE CONTAMINATED` log line wording updated: `auto-restored to HEAD` -> `worktree destroyed (operator repo untouched)` to match the new contract.

**`tools/test_eval_runner.py`**

- Two new test classes:
  - `TestWorkerWorktreeLifecycle` (7 tests, real local git repo): create returns a path outside the operator repo, worktree starts at HEAD content, operator WIP doesn't appear in the worktree, destroy unregisters cleanly, destroy succeeds with a dirty/contaminated worktree, **operator repo state is byte-identical pre and post a contaminated lifecycle** (the load-bearing isolation invariant), destroy is idempotent on a missing path.
  - `TestSpawnAndBailWorktreeIsolation` (5 tests, end-to-end via patched `run_with_retry_aware_bail`): spawn cwd is NOT the operator repo, full ugly contamination shape (branch + clone + tracked-file edit) doesn't leak, clean run reports uncontaminated, contamination inside the worktree still flags the bail dict (detection survives even though restore is unnecessary), operator WIP outside the worktree is invisible to the spawn.
- Removed the obsolete `test_spawn_detects_and_restores_contamination` from `TestSpawnAndBailWorktreeProtection` -- its semantic was "spawn mutates a file on the operator repo, harness restores it." Under worktree isolation the spawn can't touch the operator repo at all; the test was asserting a contract that no longer exists.

## Verification

Live re-run of the fork-and-pr trigger-eval against the patched harness:

```
=== trigger-eval: 20/20 queries passed (273.1s) ===
contaminated_runs: 2
completed_runs: 60
total_runs_planned: 60
aborted_on_timeout: False
```

Both contaminated runs (`q3-2: cli/`, `q2-3: anthropic-sdk-python/`) were eval-Sonnet cloning upstream repos into the worktree. The contamination flag fired correctly (worktree was dirty by definition); teardown handled the cleanup; operator repo was byte-identical pre and post (`* main` only, no phantom branches, no submodule entries, no stray cloned content).

Worktree under `/tmp/eval-worktrees/` was clean post-eval. Source files (`tools/_eval_runner.py`, `tools/test_eval_runner.py`) survived intact -- the self-eating mode is gone.

Faster than v1+dir-fix run (273s vs 374s): the v1 force-checkout path was in the critical path of every contaminated spawn; under worktree isolation, teardown of an isolated dir is faster than reconciling state on the operator repo.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Spawn cwd is not the operator repo | yes | `/tmp/eval-worktrees/<pid>-<spawn>/` | yes |
| Operator repo state byte-identical pre/post a contaminated spawn | yes | `test_operator_repo_unchanged_after_create_destroy` green; live eval confirms `* main` baseline | yes |
| Worktree teardown succeeds even with dirty state | yes | `--force` flag handles all contamination shapes | yes |
| Phantom branches don't leak to operator repo | yes | branch snapshot at create, `git branch -D` against `--git-dir` at teardown | yes |
| Detection still fires for unaudited-pass marking | yes | `_git_dirty_set(wt_path)` runs pre-teardown | yes |
| Operator WIP invisible to spawn (un-self-eat property) | yes | `test_spawn_operator_wip_outside_worktree_is_invisible` green; harness self-edited during this iteration without recurrence of the wipe | yes |
| Live re-run shows operator repo unchanged | yes | branch list, submodule entries, working dir all clean post-eval | yes |
| Trigger correctness preserved | 20/20 strict | 20/20 strict | yes |
| Existing tests stay green | `tools/test_eval_runner.py` (38 v1+dir-fix), sibling suites | 45/45 + 101/101 | yes |
| Dashboard updates live during eval | progress lines flush incrementally | `sys.stderr.reconfigure(line_buffering=True)` -- not re-verified live this iteration but confirmed via test-suite green | partial -- next eval will visually confirm |

## Next steps

- **Verify dashboard live-update on the next eval.** This iteration shipped the line-buffering fix without burning gateway budget on a confirmation run; verification will be naturally observed when the next eval (synthesis or trigger) runs.
- **Consider whether `worktree_restore_failures` is the right field name now.** Under the new design it carries teardown failures, not restore failures. Renaming touches the canonical progress line + monitor regex + envelope schema; defer until a downstream consumer surfaces the field, then rename in one sweep.
- **The detection-vs-prevention philosophy from v1 -- "detection always on, prevention opt-in" -- is moot now.** Prevention is the only thing left; detection runs only to mark unaudited verdicts.
