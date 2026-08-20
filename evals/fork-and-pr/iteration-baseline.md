# iteration-baseline

Status: shipped at 20/20 strict (3 runs each, default profile). The first trigger-eval for `fork-and-pr` – it had no eval coverage at all before this iteration, only unit-level skill description.

## Hypothesis tested

`fork-and-pr`'s `description` paragraph is precise about *when to fire* (PR upward to a repo the user doesn't own) and *when to skip* (user owns the repo, SAML 403 on `gh`, merge conflicts, stacked diffs). The hypothesis was that 10 positive + 10 negative queries spanning the documented surface would all route correctly under Sonnet 4.6 without any prose tightening – the description does the work.

Verdict: confirmed. 20/20 strict. Every positive query invoked `fork-and-pr` first; every negative query routed elsewhere (or text-only).

## Fixture composition

10 positive queries cover:
- Direct phrasings ("I want to make a PR to X", "contribute a fix to X", "fork this and PR up", "open a PR against upstream X")
- The four contributor-state cases the description documents (no clone yet / cloned upstream directly / fork on GitHub but not local / fork already cloned with both remotes)
- The post-`git push`-403 entry point ("just got 403 on a repo I cloned from someone else's GitHub")
- Implicit framings ("how do I send my changes upstream", "what's the standard fork-and-PR flow")

10 negative queries cover the description's "Skip when" list and adjacent confusables:
- User owns the repo (`git push origin main` on example-user/owned-repo, "open a PR for my branch in this repo -- I have write access")
- SAML SSO 403 on `gh` token (one-time per-org, not per-PR)
- Merge conflicts
- Stacked-diff workflows
- GitHub Actions configuration
- Fundamental git questions ("difference between `git pull` and `git fetch`")
- Push rejection due to remote ahead (`! [rejected] main -> main (fetch first)`)
- Setting up a brand-new repo
- "Commit and push the current changes" (commit-flow, not fork-flow)

## Verification

```
$ python3 tools/trigger-eval.py --eval evals/fork-and-pr/trigger-eval.json \
    --skill-name fork-and-pr --runs 3 --workers 4 --timeout 240 \
    --out evals/fork-and-pr/runs/iteration-baseline/results.json
=== trigger-eval: 20/20 queries passed (343.4s) ===
```

Every fixture: 3/3 runs matching its `should_trigger` expectation. Negative queries routed to:
- `commit-commands:commit-push-pr` (q15: "commit and push current changes" – correct, that's a real skill for the user-owns-repo case)
- `Bash` (q10, q12, q17 – the model just executed git directly, no skill)
- `AskUserQuestion` (q19: "set up a new repo from scratch" – model asked clarifying question first, correct)
- text-only (q11, q13, q14, q16, q18 – model answered with prose without invoking a skill, correct)

## Surprises

**Eval-Sonnet enacted the workflow on prompts naming a real upstream repo.** Five of the ten positive prompts (q2, q3, q4, q5, q7) name a real GitHub repo the model could plausibly clone (`anthropics/anthropic-sdk-python`, `cli/cli`, `facebook/react`, `anthropics/claude-code-action`). On run 1 of those fixtures, eval-Sonnet went beyond invoking `fork-and-pr` to *describe* the flow – it actually `git clone`d the upstream repo into the worktree, added it as a submodule, created a feature branch (`feat/cli-and-fork-and-pr-evals`), and committed the submodule plus the trigger-eval fixture in a single commit. By run 2 and 3 of those same prompts it didn't re-enact (probably because the harness's auto-restore had partially cleaned, and on a re-run the directory state suggested "this was already done"), but run 1 contamination persisted across the eval session.

**The harness's worktree-isolation caught the contamination but couldn't auto-restore.** `iteration-eval-harness-worktree-isolation` snapshots `git status --porcelain` per spawn and restores file-level changes, but:

1. It doesn't snapshot branch state. The phantom branch `feat/cli-and-fork-and-pr-evals` existed alongside main throughout the eval and beyond.
2. `git checkout HEAD --` can't undo a submodule index addition cleanly; `git status --porcelain` reported the contamination but the restore call failed (`worktree_restore_failures: ['cli', 'evals/fork-and-pr/trigger-eval.json']`).

8 of 60 runs were marked contaminated; manual cleanup after the eval restored to clean main. The contamination didn't affect *trigger correctness* (all 8 contaminated runs still routed to `fork-and-pr` first, matching `should_trigger: true`), but it left 108MB of cloned `cli/` content on disk and a phantom branch that needed manual `git branch -D`.

This is a follow-up gap for `iteration-eval-harness-worktree-isolation`: branch-state and submodule-add are contamination shapes the current snapshot/restore loop doesn't handle. Probably worth a `git rev-parse HEAD` and `git symbolic-ref HEAD` snapshot pre-spawn, with a checkout-back post-spawn and a `git branch -D` if a new branch was created. Submodule restoration is harder – probably needs explicit `git submodule deinit` if the index gained one. Not blocking the fork-and-pr trigger-eval shipment.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| All `should_trigger: true` queries invoke `fork-and-pr` | 10/10 | 10/10 | yes |
| All `should_trigger: false` queries do NOT invoke `fork-and-pr` | 10/10 | 10/10 | yes |
| Strict mode (every run matches expectation, not just majority) | 60/60 runs | 60/60 | yes |
| No regression to other skills | – | none observed | yes |
| Worktree clean at HEAD post-eval | clean | required manual cleanup | no (8/60 contaminated, harness gap) |

## Next steps

- Add a synthesis-eval for `fork-and-pr` later, or document why its pause-for-user shape doesn't fit synthesis-eval (the skill stops mid-flow waiting for the user's commits before pushing – an end-to-end synthesis run can't exercise the post-pause steps without real `gh`/`git` state).
- File a follow-up for `iteration-eval-harness-worktree-isolation`: snapshot+restore branch state and submodule additions, not just file-level dirt. The fork-and-pr fixture's repo-naming pattern reliably elicits enactment behavior from eval-Sonnet, so the gap is reproducible.
