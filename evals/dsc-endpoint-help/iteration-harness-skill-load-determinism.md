# iteration-harness-skill-load-determinism

Status: HYPOTHESIS_CONFIRMED. Adding `--permission-mode bypassPermissions` to the `claude -p` invocation in `tools/_eval_runner.py:181` makes skill-load deterministic in non-interactive mode and unblocks measurement of every prose change shipped since the harness was authored. Predicted result – `synthesis-diff-hands-off-404-not-found` climbs to 5/5 strict on both profiles without further SKILL.md edits, since every observed SKILL_OK run already passed the regex naturally with the prose change from `ada69da` – held cleanly. **Both profiles 5/5 fixtures, 25/25 runs, 80/80 assertion-passes, 0 retries, 0 timeouts.** All 50 transcripts (25 default + 25 restricted) recorded `tool_result is_error=False content="Launching skill: dsc-endpoint-help"` – no load failures, no fallbacks, no freelance paths exercised.

## Hypothesis tested

[`iteration-skill-handoff-prose-tightening`](iteration-skill-handoff-prose-tightening.md) ended on a clear next-step: the prose change shipped in `ada69da` was load-bearing on every SKILL_OK run (8/8 across baseline + new, both profiles), but the harness's intermittent skill-load failure dominated the observed pass rate. The brief framed the fix as a one-line change to `tools/_eval_runner.py:181`'s `cmd` list: add the missing `--permission-mode` flag. Predicted: SKILL_OK rate climbs to ~100%, hand-off-404 jumps to 5/5 strict on both profiles without any SKILL.md edits.

The previous iteration explicitly avoided guessing whether the regression was prose quality or harness artifact – it observed both signals and built the cross-tab that made the harness signal dominant. This iteration tests that conclusion directly.

## What changed

`tools/_eval_runner.py` only. One additional argument in the `cmd` list constructed by `_spawn_and_bail`:

```python
"--permission-mode", "bypassPermissions",
```

Inserted before `*PROFILE_FLAGS[profile]` so it applies globally to both `default` and `restricted` profiles – the skill-load failure mode is the same on both. A short comment above the line documents the symptom (`is_error: true content="Execute skill: ..."` permission-prompt body) and points back to this iteration for the diagnosis.

No edits to `SKILL.md`, `lib/`, `scripts/`, `tests/`, `_shared/`, or `synthesis-eval.json`. The skill is correct as of `ada69da`; this iteration is harness-only.

`tools/trigger-eval.py` shares the same `_eval_runner.run_eval` path and picks up the fix automatically – no edits needed there. The same diagnosis applies: any time `claude -p` invokes the Skill tool without an explicit permission mode, the prompt body fires non-interactively and the model freelances.

## Verification before re-running

A one-off `claude -p --permission-mode bypassPermissions` invocation against the `synthesis-diff-hands-off-404-not-found` query produced the canonical SKILL_OK signal:

```
tool_use:    Skill input={"skill": "dsc-endpoint-help", ...}
tool_result: is_error=False content='Launching skill: dsc-endpoint-help'
```

Final answer was hand-off-shaped: `"The spec can't explain this 404"`, `"hands off here"`, named runtime categories without ranking causes, cited `https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=getOrder`. Exactly the prose the SKILL.md change in `ada69da` was meant to enforce, exercised cleanly for the first time since that change shipped.

## Eval results

```
python3 tools/synthesis-eval.py --eval evals/dsc-endpoint-help/synthesis-eval.json --runs 5 --workers 4 --timeout 600 --out evals/dsc-endpoint-help/runs/iteration-harness-skill-load-determinism/results-default.json
python3 tools/synthesis-eval.py --eval evals/dsc-endpoint-help/synthesis-eval.json --runs 5 --workers 4 --timeout 600 --profile restricted --out evals/dsc-endpoint-help/runs/iteration-harness-skill-load-determinism/results-restricted.json
```

Both completed: 25/25 runs each, no aborts, no harness-level timeouts, no CLI retries, exit code 0.

| Fixture | Default (this) | Default (baseline\*) | Restricted (this) | Restricted (baseline\*) | Failure mode |
|---|---|---|---|---|---|
| `synthesis-diff-insufficient-scope-shopper-baskets` | 5/5 | 5/5 | 5/5 | 5/5 | (pass) |
| `synthesis-diff-OCAPI-fault-envelope` | 5/5 | 5/5 | 5/5 | 4/5 | (pass) – baseline slip recovered |
| `synthesis-diff-content-type-415` | 5/5 | 5/5 | 5/5 | 5/5 | (pass) |
| `synthesis-diff-jwt-scope-decode` | 5/5 | 4/5 | 5/5 | 5/5 | (pass) – baseline slip recovered |
| `synthesis-diff-hands-off-404-not-found` | 5/5 | 0/5 | 5/5 | 2/5 | (pass) – the predicted recovery |

\* baseline = `iteration-skill-handoff-prose-tightening` (most recent measurement before this harness change).

**Strict pass: 5/5 fixtures both profiles** (up from 2/5 default, 3/5 restricted). **Customer-outcome assertion pass rate: 80/80 default (up from 19/25 customer-outcome asserts ~76%), 80/80 restricted (up from 21/25 ~84%).** Wall-clock 468.4s default, 426.2s restricted – both faster than the previous iteration despite identical fixture set, plausibly because no SKILL_LOAD_FAIL Read-fallback round-trips happen anymore.

The two prior "slips" called out as run-to-run noise (OCAPI restricted 4/5, JWT default 4/5) recovered to 5/5 in this iteration, consistent with the diagnosis: those slips were also harness skill-load failures, not real regressions. Across both iterations, *every* failed run that anyone could attribute to anything has now been attributed to skill-load determinism. The brief's residual concern that hand-off-404 might still wobble even with deterministic load did not materialise.

## Skill-load determinism check

Predicted: SKILL_OK rate climbs to ~100%. Observed: **50/50 transcripts loaded SKILL.md cleanly.** Sweep over every retained `.jsonl` in `runs/iteration-harness-skill-load-determinism/transcripts/{results-default,results-restricted}/` (25 each, all 5 fixtures × 5 runs × 2 profiles):

| Profile | Transcripts | SKILL_OK | SKILL_LOAD_FAIL | Neither |
|---|---|---|---|---|
| default | 25 | 25 | 0 | 0 |
| restricted | 25 | 25 | 0 | 0 |

Compare to baseline (`iteration-skill-handoff-prose-tightening`) on `synthesis-diff-hands-off-404-not-found` alone: 0/5 SKILL_OK default, 1/5 SKILL_OK restricted. The flag fully resolves the determinism problem.

## Coverage of trigger-eval

The same `_spawn_and_bail` is the only CLI entry point in `_eval_runner.py`; both `synthesis-eval.py` and `trigger-eval.py` route through `run_eval`, so trigger-eval picks up the fix without an edit. This was confirmed by reading `tools/trigger-eval.py:57` (`from _eval_runner import run_eval`); no separate `cmd =` list exists.

Trigger-eval's first-tool-of-stream scoring still captures the right signal – Skill tool with input matching the target name – but until this iteration, "Skill tool was the first tool" wasn't a reliable proxy for "SKILL.md actually loaded." Most prior trigger-eval results that scored as triggers were Skill invocations that may have errored on permission and reverted to freelance. Future trigger-eval iterations now have a chance of measuring real SKILL.md influence; whether prior trigger-eval numbers were inflated by load-failed Skill calls (still scored as triggers) or whether trigger-eval was less affected because its scoring stops at the first tool_use is worth re-checking on the next trigger-eval pass.

## Surprises

- **Wall-clock dropped despite same fixture set.** 468.4s default and 426.2s restricted vs. the previous iteration's 870.6s default and 660.5s restricted. The Read-fallback path was apparently doing real work on the failed-load runs (the model retrying via `Read /Users/james.klein/.claude/skills/dsc-endpoint-help/SKILL.md`), and removing it removes that latency. Not a designed-for outcome but a real one.
- **No CLI retries on any of 50 runs.** Both prior iterations had occasional `retries=1` rows; this run had `retries=0` across the board. The gateway happened to be quiet, but it's a clean signal anyway – no throttle-induced abort risk in the dataset.
- **The two "noise" slips from the previous iteration both recovered.** OCAPI restricted 4→5 and JWT default 4→5. Calling those run-to-run noise was charitable; they were probably also skill-load artifacts. The previous iteration's note that the failures *happened to* hit SKILL_LOAD_FAIL was correctly flagged as the dominant pattern even on fixtures that nominally passed.
- **A `--dangerously-skip-permissions` alternate exists** (`claude --help` shows both). The explicit `--permission-mode bypassPermissions` form is the canonical one and is what `_eval_runner.py:30-45`'s comment block now refers to; the `--dangerously-` flag is an older spelling kept for compatibility. Either would work; the explicit one reads better in code.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Synthesis-eval | 5/5 strict both profiles | 5/5 / 5/5 | yes |
| Hand-off-404 recovery | 5/5 (predicted) | 5/5 / 5/5 | yes |
| Per-fixture ≥ baseline | 5/5 | 5/5 (every fixture ≥ baseline) | yes |
| Customer-outcome assertion pass rate | climb | 80/80 default (was 19/25), 80/80 restricted (was 21/25) | yes |
| Routing correctness | 25/25 | 25/25 both profiles | yes |
| `tests/run.sh` (3 skills + _shared) | all green | (no script changes) | n/a |
| SKILL.md word count | ≤ 300 | 275 (untouched) | yes |
| SKILL_OK rate | ~100% | 50/50 | yes |

The iteration ships against every stated target. The prose change from `ada69da` is now confirmed load-bearing.

## Closing the hand-off arc

The previous iteration's "Next steps" section listed two follow-ups: (1) this iteration, and (2) a gated `iteration-skill-handoff-revisit-after-harness-fix` for re-confirming the prose change at 5/5 strict. **Item (2) is no longer needed** – this iteration's hand-off-404 result (5/5 / 5/5) *is* the gated re-confirmation. The prose change is load-bearing, the harness now exercises it deterministically, and there is no residual signal to chase on this fixture.

No further SKILL.md prose iterations on hand-off-404 are needed. If a future regression appears here, the iteration to file is "what changed", not "more prose."
