# iteration-synthesis-baseline

Status: DONE. 10/10 strict (2 fixtures × 5 runs) on the existing `evals/dsc-scrape/synthesis-eval.json`. First synthesis run captured for dsc-scrape; pairs with the `docs/examples/scrape-agentforce-references.md` worked-example backfill committed in the same iteration.

## Hypothesis tested

The two synthesis fixtures (`mcg-alias-citation-leak`, `agentforce-alias-url-trace`) authored across `iteration-mcg-prose-citation-strength` and `iteration-agentforce-url-trace` would pass 5/5 strict against the deployed dsc-scrape skill on Sonnet 4.6 under the per-spawn worktree-isolated harness (commit 3c22bb3). Prior to this iteration, no synthesis-eval run had been recorded for dsc-scrape – only trigger-eval iterations existed under `runs/`.

## What changed

No fixture edits, no SKILL.md edits, no script edits. This iteration is purely a measurement: spawn the harness against the existing fixture set under the current isolation regime and record the result.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/dsc-scrape/synthesis-eval.json --runs 5 --workers 4 --timeout 300 --out evals/dsc-scrape/runs/iteration-synthesis-baseline/results.json`

Wall-clock 139.7s. Exit code 0. No retries, no aborts.

| Fixture | Pass count | Mean elapsed |
|---|---|---|
| `mcg-alias-citation-leak` | 5/5 | 66.0s |
| `agentforce-alias-url-trace` | 5/5 | 26.9s |

All three assertion classes fired correctly across all 10 runs:

- `tool_input_matches` (Agentforce only) on `developer.salesforce.com/docs/ai/agentforce/references` proved cascade resolution – alias map → Bash scrape call.
- `final_text_excludes` on `~/\.cache/` and `/\.claude/skills/` held: zero leaks across 10 runs.
- `final_text_matches` on the public DSC URL fired on every run for both products.

## Worked example committed

`docs/examples/scrape-agentforce-references.md` – verbatim final-answer text from the `agentforce-alias-url-trace-5.jsonl` transcript (run 5, the most complete answer; 1435 chars, full reference table). Matches the README's stated provenance: "the verbatim final text the skill produced, captured from the `synthesis-eval.py` harness against the installed skill."

## Surprises

None. Both fixtures had been authored against test cases known to pass on prior Sonnet versions; this measurement under 4.6 + the worktree-isolated harness confirms no regression.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Synthesis-eval | 10/10 strict | 10/10 strict | yes |
| Worked example committed | 1 | 1 (agentforce-references) | yes |
| Wall-clock | < 300s | 139.7s | yes |
| Citation-leak guard | 0 leaks | 0 leaks | yes |

## Next steps

dsc-scrape's synthesis coverage is now baselined on the current harness. Future fixture additions (e.g., adding a third product to the alias-cascade fixture set, or covering a non-aliased reference for non-cascade citation discipline) should reference this iteration as the floor.
