# iteration-merge-baseline

Status: BLOCKED. The merged skill cannot pass baseline as the plan was authored. The displacement test, with both predecessors installed, shows the merge does not displace either predecessor on Sonnet 4.6 – consistent across the data we collected before the gateway throttled the eval into repeated wall-clock aborts.

## Hypothesis tested

The merged `dsc-endpoint-help` description, with both surfaces under one skill and a runtime branch, hits ≥90% trigger / 5/5 regression / 5/5 synthesis on Sonnet 4.6 without prose-tuning beyond the merge itself – with both `dsc-endpoint-lookup` and `dsc-triage` left installed alongside it (intentional, per the task: "honest about the displacement signal Sonnet sees").

## What changed

- Task 1 (`a8f06e9`) scaffolded the merged skill.
- Task 2 (`196cf8b` + `faae1f5`) authored fresh trigger-eval (33 fixtures) and synthesis-eval (5 fixtures) sets keyed to the runtime-branch decision matrix in [`docs/superpowers/plans/2026-05-22-dsc-endpoint-help-merge.md`](../../docs/superpowers/plans/2026-05-22-dsc-endpoint-help-merge.md).
- Task 3 (this iteration): installed `~/.claude/skills/dsc-endpoint-help` clean-name symlink alongside the predecessors; ran trigger-eval and synthesis-eval; iterated the SKILL.md description once when displacement failed; concluded after gateway throttle stopped useful re-attempts.

## Eval results

**Trigger-eval (post-iteration-1, partial – aborted on wall-clock at fixture 4):**

- Total fixtures planned: 33 (20 positive, 13 decline). Total runs planned: 99.
- Runs actually executed: 4 (3 clean + 1 wall-clock timeout).
- Of the 3 clean runs (all of fixture `bare-spec-field-scopes-getProducts`): 0/3 fired `dsc-endpoint-help`. 3/3 fired `dsc-endpoint-lookup`.
- The 13 decline fixtures and 19 of the 20 positive fixtures never executed – the eval bailed before reaching them. The "13 passed" the harness reports is vacuous (declines with `runs: 0` count as pass because there were no failed runs); it is not a real measurement.
- Hard data: `evals/dsc-endpoint-help/runs/iteration-merge-baseline/trigger-results.json`.

**Synthesis-eval (post-iteration-1, partial – aborted on wall-clock at fixture 2):**

- 5 fixtures × 5 runs = 25 planned. Runs executed: 6 (5 clean + 1 wall-clock timeout).
- Of the 5 clean runs (all of fixture `synthesis-diff-insufficient-scope-shopper-baskets`): 0/5 fired `dsc-endpoint-help`. 5/5 fired `dsc-triage`.
- No `synthesis-results.json` written (per harness's documented exit-code-3 abort policy: partial throttled data isn't preserved). Per-run transcripts in `evals/dsc-endpoint-help/runs/iteration-merge-baseline/transcripts/synthesis-results/`.

**Branch-correctness:** untestable – the merged skill never ran, so no `triage.js` vs `query.js` invocation to score against `expected_branch`.

**Pass criteria status:** all four miss.

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Regression fixtures | 5/5 strict | unknown – never executed | no |
| Trigger overall | ≥90% strict | 0/3 on the only fixture that ran | no |
| Decline | 100% | unknown – never executed | no |
| Synthesis | 5/5 strict | 0/5 on the only fixture that ran | no |

## Per-fixture breakdown

The 3+5 = 8 runs we have data on:

| Fixture | Branch | Runs that completed | First-tool routing | Verdict |
|---|---|---|---|---|
| `bare-spec-field-scopes-getProducts` | lookup | 3 | 3/3 → `dsc-endpoint-lookup` | displacement loss |
| `synthesis-diff-insufficient-scope-shopper-baskets` | diff | 5 | 5/5 → `dsc-triage` | displacement loss |

Both surfaces lose to their respective predecessor. The pattern is uniform across all 8 runs and stable across the description-iteration boundary (3 runs were under the original description, the other 5 under iteration-1's tightened description; routing was identical).

## Iterations during baseline

**Iteration 1 (description tightening)** – performed after the first 14 runs of attempt 1 showed every completed run routing to `dsc-endpoint-lookup`. Edited `skills/dsc-endpoint-help/SKILL.md` description-frontmatter (commit pending if iteration is committed):

- Old leading clause: "Answer a question about a Salesforce API endpoint…" – abstract verb, broader noun.
- New leading clause: "Look up a spec field on, or diff a failing request against, one named endpoint…" – concrete verbs that mirror both predecessor leads at once.
- Added an explicit "This is the unified successor to `dsc-endpoint-lookup` and `dsc-triage`; prefer it whenever either of those would have fired" sentence mid-description.
- Length: 1974 chars (before: 1764). Predecessors: 1535 (`dsc-endpoint-lookup`) and 1503 (`dsc-triage`). Still in range.

**Outcome of iteration 1**: no change in routing behavior. The post-iteration-1 trigger-eval ran 3 fresh runs of the first lookup fixture; all 3 routed to `dsc-endpoint-lookup`, identical to the pre-iteration runs. The post-iteration-1 synthesis-eval ran 5 runs of the first diff fixture; all 5 routed to `dsc-triage`. Iteration 1 did not move the displacement signal.

**No further iterations attempted.** The signal was already conclusive on the data we had, and the gateway was throttling subsequent runs into wall-clock aborts that would have spent time without producing more data.

## Surprises

**The structural argument failed to clear baseline as designed.** The plan's load-bearing claim (per task description) was: "the routing decision they kept losing simply doesn't exist anymore" once the merge replaces both predecessors. That claim is structurally sound for the *post-cutover* state where only `dsc-endpoint-help` exists. It does not hold for the pre-cutover *baseline* state where Sonnet sees three competing skills (the merge plus both predecessors). With predecessors installed, both predecessors have stronger leading sentences for their respective input shapes than any merged description can plausibly be without becoming unreadably long. Sonnet picks the more specific match, every time.

**Gateway throttling was severe and persistent.** Four trigger-eval attempts and one synthesis-eval attempt all bailed on wall-clock timeouts, even after raising the timeout from 240s to 600s and dropping workers from 4 to 2. Individual runs that did complete took 60–175s (vs. 30–60s historically). This is a separate issue from the displacement question, but it's why the data we have is partial: under normal gateway conditions we would have run all 99 + 25 = 124 runs and had a complete picture. The 8 successful runs we did get were enough to make the displacement finding conclusive, since they all pointed the same direction with zero variance.

## Next steps

The displacement-test framing of baseline – installing the merge alongside both predecessors and expecting it to win – is empirically not workable on Sonnet 4.6 with descriptions of comparable length. Two options for moving forward:

**Option A (recommended): re-order Tasks 3 and 4.** Cut over first (uninstall predecessors), then run baseline. This tests the actual deployed state. The plan's structural argument applies cleanly there. Task 4 is reversible (the predecessor dirs aren't deleted from the repo until commit-time; the symlink unlinks are local-only), so this doesn't preclude rollback if the merge fails post-cutover for a different reason.

**Option B: keep Task 3 / Task 4 ordering, but redefine baseline pass criteria for the displacement state.** Instead of "merged skill triggers cleanly," pass criteria become "merged skill triggers OR a predecessor triggers correctly" – i.e., the user gets a working answer regardless of which skill fires. This honors the "no regression" intent of the merge but doesn't claim the merge is *better* than the predecessors at routing during co-existence (which it isn't).

Either way, the partial data we have is enough to file the iteration: the merge as a *behavioral replacement* should work fine post-cutover (no evidence to the contrary; the runtime-branch logic in the SKILL.md is unchanged from the predecessors' scripts). The merge as an *outcompetitor* during co-existence does not work, on this model, with descriptions in the size range we've authored.

This task should be marked DONE_WITH_CONCERNS or BLOCKED depending on how strictly the pass criteria are read. Recommend Task 4's plan author adjudicate which path forward they want before running another iteration here.
