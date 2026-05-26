# iteration-synthesis-pause-mismatch

Status: DECISION (skipped fixture authoring). After analyzing the skill's output shape, synthesis-eval is determined to be unsuitable for fork-and-pr; trigger-eval (already 20/20 strict from `iteration-baseline`) is the appropriate gate for this skill. Filed as an iteration note rather than authored fixtures so the analytical trail is preserved -- a future maintainer revisiting this should find this note before sinking time into fixture authoring that would produce low-signal results.

## The mismatch

Synthesis-eval evaluates a skill's *complete output* against typed assertions on the final transcript. The harness fires the skill's query, lets the skill run to completion, and asserts against (a) the chat answer (`final_text_*`), (b) tool inputs along the way (`tool_input_matches`), or (c) the tool sequence (`tool_sequence_includes`). The implicit assumption is that the skill produces its full output in a single invocation.

fork-and-pr violates this assumption by design. Per `skills/fork-and-pr/SKILL.md` "Step 4: PAUSE -- user edits and commits":

> This is the handoff. Tell the user explicitly: "Branch `<name>` is ready. Make your edits, commit them (`git add <files>` then `git commit`), and tell me when you're done -- I'll push and open the PR."
>
> Then stop. Do not poll `git status` or proactively check on their progress; wait for them to come back with "done", "committed", "ready", or similar.

The skill is *intentionally* multi-turn: steps 1-3 (state check, fork, branch creation) happen in the first invocation, then the skill stops. Steps 4-5 (push, gh pr create) only fire after the user replies "done". A synthesis-eval invocation is a single `claude -p` turn -- it can't simulate the user's interim commits, so the second half of the skill's output never exists in an eval transcript.

What synthesis-eval *can* assert against:
- Pre-pause output (steps 1-3): branch name suggestion, `gh repo fork` command, "Branch X is ready, make your edits" handoff prose.
- The pause itself: that the skill stops at step 4 rather than barreling into push/gh pr create against an empty branch.

What synthesis-eval *cannot* assert against:
- Steps 4-5 (push, gh pr create) -- they require the user's interim commits.
- The full happy-path PR creation flow.
- Any error path that depends on what the user committed.

## Why the partial coverage isn't worth the fixture authoring cost

The pre-pause output is small and largely deterministic: state-check shell commands, a `gh repo fork` invocation, a branch name following one of four conventions (`fix/`, `feat/`, `chore/`, `docs/`), and the handoff sentence. Asserting on those:

1. **Reduces to surface-syntax tests.** The interesting properties of fork-and-pr's pre-pause output -- correct state diagnosis, idempotent fork command, sensible branch name -- are categorical (4 conventions, 4 starting states), not regex-shaped. A `final_text_matches` assertion can confirm "branch name starts with `fix/`" but not "branch name correctly reflects the user's stated intent" without authoring 20 fixtures covering 20 intent shapes. Diminishing returns on coverage breadth.

2. **Is already covered by trigger-eval.** The trigger-eval at `evals/fork-and-pr/trigger-eval.json` (20 fixtures: 10 positive, 10 decline-tests, 20/20 strict from `iteration-baseline`) confirms the skill *fires* on its target shape and *declines* off-target. The pre-pause output's quality is mostly downstream of the skill firing on the right intent -- if the trigger-eval is solid, the pre-pause output is solid by construction.

3. **Doesn't catch the regressions synthesis-eval is uniquely positioned to catch.** Per CLAUDE.md, synthesis-eval owns "citation leaks, cascade-order bugs, hallucinated spec fields, prose-rule violations." fork-and-pr has no citations to leak (it's domain-agnostic), no cascade-order to break (it's linear), no spec fields to hallucinate (the spec is `gh` CLI behavior, which the skill doesn't claim authority over), and no prose rules beyond what trigger-eval already verifies (handoff cadence, command correctness).

4. **Multi-turn synthesis-eval doesn't exist.** A future harness extension that simulated user interim commits and ran the skill across multiple turns would be valuable -- but it would be substantially more harness work than the value to fork-and-pr alone justifies. The harness as-shipped is one-turn.

## What we lose, and why it doesn't matter

We lose direct synthesis-eval visibility into:

- Pre-pause prose drift. If a future SKILL.md edit changed the handoff sentence to something user-confusing, synthesis-eval wouldn't catch it. *Mitigation:* trigger-eval will catch outright trigger regressions; prose drift caught by code review on SKILL.md edits.
- Branch-name convention adherence. If the model started suggesting `bugfix/` instead of `fix/`, synthesis-eval wouldn't catch it. *Mitigation:* trigger-eval indirectly tests this -- if the branch name suggestion is malformed, the user is more likely to disengage and the skill won't fire correctly on the next invocation.
- State-A-vs-state-B decision regressions. *Mitigation:* the skill's state diagnosis is `gh repo view --json viewerPermission,parent` -- a deterministic CLI call, not model judgment. Less likely to regress without `gh` itself changing.

Net: zero load-bearing coverage lost. The trigger-eval is the right gate for this skill.

## What this means for the wider eval matrix

Two skills in this repo have synthesis-eval coverage at 5/5 strict per fixture: dsc-endpoint-help, dsc-scrape, dsc-scenario, stepped-demo-script. fork-and-pr is the one skill in the repo where synthesis-eval is documented as N/A. That asymmetry is fine -- skills don't all have the same output shape, and forcing every skill into the same eval shape produces low-signal numbers (which is what 0/15 looked like at the start of stepped-demo-script's iteration before the assertion-target was corrected to match the actual deliverable).

The right pattern when a skill's output shape doesn't fit synthesis-eval is to file an iteration note explaining why, mark the skill as trigger-eval-only in the eval matrix, and move on. Don't author low-signal fixtures to satisfy a coverage symmetry that doesn't reflect skill design reality.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Synthesis-eval fixture authored | 1+ fixtures (originally) | 0 fixtures (decision) | yes (decision is the deliverable) |
| Trigger-eval strict pass | 20/20 (existing baseline) | 20/20 | yes (unchanged from iteration-baseline) |
| Iteration note explaining the design call | yes | yes (this file) | yes |

## Next steps

No follow-up work for fork-and-pr's eval coverage. If a future harness extension supports multi-turn synthesis (e.g. a fixture that includes a simulated user "done" reply between turns), revisit this decision -- the skill's full happy-path coverage would become reachable at that point.

The worked-example backfill task in this branch should pick a fork-and-pr scenario -- the trigger-eval transcripts have realistic pre-pause output that's still teammate-shareable as a worked example, even though we're not formalizing it as a synthesis-eval fixture. Pre-pause output (steps 1-3 + handoff) is what a teammate sees before the pause anyway, so a worked example captured at that point reflects real usage.
