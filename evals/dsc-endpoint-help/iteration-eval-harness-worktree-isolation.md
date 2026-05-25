# iteration-eval-harness-worktree-isolation

Status: SHIPPED. Eval harness now snapshots `git status` before each `claude -p` spawn, re-snapshots after, restores any newly-dirty paths (`git checkout HEAD --` for tracked, unlink for newly-appeared untracked), and surfaces a `worktree_contaminated: true` flag plus the changed-path list on the per-run result dict and the canonical stderr line. Operator's pre-existing dirty paths are subtracted from the delta so in-flight WIP isn't touched. Gating prerequisite for any future iteration that wants to use synthesis-eval as a load-bearing assertion: with this in place, "5/5 strict" claims are auditable; without it, contaminated runs masquerade as clean signal (the failure mode iteration-resolve-slug-fallback-rejected diagnosed retroactively across 3/8 historical iterations).

## Hypothesis

Three protection mechanisms were available from iteration-resolve-slug-fallback-rejected's "Next steps":

1. Tree-hash before/after each spawn; flag post-hoc, allow run to complete.
2. `chmod -w` on `skills/` before spawn, restore after; eval-Sonnet's Edit fails outright.
3. Tool-list restriction: disallow `Edit`/`Write` on absolute paths under the repo via `--disallowedTools` plumbing.

Hypothesis: option (1) tree-hash + auto-restore is the right balance. Option (2) is stronger but distorts behavior measurements (model might give up entirely rather than freelance past a failed Edit, polluting other signals on the same run). Option (3) requires CLI knobs that don't exist for path-scoped tool restrictions. Option (1) lets the run complete, lets the assertion fire on the contaminated state (so the contamination flag flows alongside the regular pass/fail signal), and the auto-restore makes the harness robust against the same contamination repeating across runs without manual intervention.

Implementation chose `git status --porcelain=v1 -z` over a custom file-tree hash because: (a) git already has the canonical "what's dirty" answer, (b) `.gitignore` exclusion comes free (so `evals/*/runs/`, `__pycache__`, `.env` don't trip detection), (c) operator-baseline subtraction (current dirty paths minus pre-spawn dirty paths) reuses the same primitive, (d) auto-restore via `git checkout HEAD --` is the most semantically correct "undo a tracked-file edit" – bytes-and-mode correct, no separate file-content-hash bookkeeping.

## Scope

Snapshot covers everything `git status --porcelain` reports under the repo root: `skills/`, `tools/`, root files (`CLAUDE.md`, `AGENTS.md`, `README.md`), `evals/<skill>/synthesis-eval.json` and `trigger-eval.json` (the eval set itself shouldn't be patched mid-run). Naturally excluded by `.gitignore`: `evals/*/runs/` (the run dir itself, where the harness writes results.json), `__pycache__`, `.env`, `node_modules`, `.playwright-mcp/`. The `_git_dirty_set` test `test_dirty_set_excludes_gitignored_paths` anchors this exclusion – a regression there would mean every successful eval reports itself as contaminated.

Per-spawn (not once at run_eval entry) because with N parallel workers, one worker's contamination would leak into another worker's clean measurement if the snapshot/restore cycle weren't local to each spawn. Per-spawn pays N `git status` invocations – measured at <50ms per invocation on this repo's tree size – but keeps each worker's measurement self-consistent.

## What changed

**`tools/_eval_runner.py`**

- New helpers above `_spawn_and_bail`: `_git_dirty_set(cwd)` (parses `git status --porcelain=v1 -z` for unambiguous path handling – NUL separators tolerate spaces and rename records), `_git_repo_root(cwd)`, `_diff_dirty_sets(before, after)`, `_restore_worktree_paths(repo_root, paths)` (buckets into tracked-modified vs. newly-untracked, applies `git checkout HEAD --` to the former and `unlink` to the latter – semantically correct undo, not a single-tool sledgehammer).
- `_spawn_and_bail` now snapshots before, runs, snapshots after, diffs, restores on contamination, and adds three keys to the bail dict: `worktree_contaminated`, `worktree_changed_paths`, `worktree_restore_failures`.
- `_run_one_task` propagates those three keys onto the per-run result dict.
- `run_eval` stamps a `contaminated_runs` count on the envelope, logs a `! WORKTREE CONTAMINATED on <id>-<run>` line to stderr per affected run with the changed paths and restore status, and adds `contaminated=True|False` to the canonical `_format_progress` line.
- `PROGRESS_LINE_RE` extends with an optional `(?:\s+contaminated=...)?` group at the tail. Optional so the regex stays byte-identical with `tools/eval-monitor.py`'s copy and back-compatible with log files written before this iteration; the runner's emitter always populates the field.
- The runner-crashed exception path in `run_eval` now stamps the three new keys with safe defaults so summarizers don't `KeyError` on a crashed-runner record.

**`tools/eval-monitor.py`**

- Mirror change to `PROGRESS_LINE_RE` (same optional `contaminated` group), and `_parse_progress_rows` populates a `contaminated` field on each row. The dashboard rendering is untouched in this iteration; the field is wired through to the row records so a follow-up iteration can surface it visually without re-parsing.

**`tools/test_eval_runner.py`**

Three test classes added/updated:

- `TestProgressLineRoundTrip`: existing `_round_trip` helper extended with `contaminated: False` default so existing tests don't need touching; the field is exercised implicitly through every progress-line round trip.
- `TestWorktreeIsolationPrimitives` (10 tests, real local git repo via tempfile.TemporaryDirectory): snapshot detects modified-tracked / new-untracked / nothing-dirty, gitignore exclusion is honored, baseline-subtraction subtracts operator dirty paths from the delta, restore reverts modified-tracked / unlinks newly-untracked / no-ops on empty / silently handles already-gone untracked / handles mixed shapes correctly. The realistic contamination shape (`test_restore_handles_mixed_tracked_and_untracked`) is the one that mirrors what eval-Sonnet was doing across the 3 historical contaminated iterations.
- `TestSpawnAndBailWorktreeProtection` (3 tests, end-to-end integration): patches `run_with_retry_aware_bail` to simulate a spawn that mutates a tracked file mid-call, validates the wired-up snapshot/diff/restore cycle catches the contamination, populates the bail dict, restores to HEAD, AND keeps the operator's pre-existing dirty paths untouched. This is the load-bearing verification (see "Verification observation" below for why a natural-fixture verification was less informative than expected).

## Verification observation

Brief expected the OCAPI-fault-envelope fixture (default profile) to deterministically contaminate via eval-Sonnet patching `_shared/resolve-slug.js` to wildcard `vN_N` segments. Ran 3x against `evals/dsc-endpoint-help/runs/iteration-eval-harness-worktree-isolation/verification-default.json`: **all three runs clean – `contaminated_runs: 0`, every per-run record has `worktree_contaminated: false`, transcripts show eval-Sonnet went straight to triage.js via Bash with zero Edit/Write/MultiEdit calls.** The brief's "deterministic" framing didn't reproduce on Sonnet 4.6 in this iteration's worktree. Two plausible reasons: (a) Sonnet's contamination behavior is gated on the parent prompt context shifting between Sonnet builds (the brief was based on prior runs that may have used a different Sonnet build than the one the gateway routes to today), (b) 0520371's `cacheRoot` fix quieted some path that previously failed and prompted Sonnet to "fix" it (the contamination shape across `_shared/resolve-slug.js` and `parse-oas.js` was always Sonnet hot-patching real triage.js bugs).

Either way the live verification can't, on this run, observe natural contamination on demand. **The load-bearing verification therefore lives in the unit and integration tests (34/34 passing, including `test_spawn_detects_and_restores_contamination` which patches `run_with_retry_aware_bail` to mutate a tracked file mid-call and asserts the wired-up cycle catches it, populates the bail dict, and restores to HEAD).** This is honest: contamination in the wild is non-deterministic across Sonnet builds, but the harness invariant – "if eval-Sonnet contaminates, we will detect, surface, and auto-restore" – is verifiable with a controlled stub spawn, and that's what the integration test does.

The verification run's existence is also useful by negation: an eval running on this branch with these helpers does not regress trigger accuracy or assertion-pass rate – 3/3 fixture passes, 3/3 expected-skill matches, no spurious flags, no errors.

## Historical contaminated runs that are now retroactively suspect

Per iteration-resolve-slug-fallback-rejected's transcript audit, three iterations in this skill's history have eval-Sonnet source-file Edit/MultiEdit calls in their transcripts. With the harness fix in place, the re-audit can be done by re-running synthesis-eval against each iteration's commit and reading the new `contaminated_runs` count, but the historical results.json files already shipped with no contamination flag – so "did this iteration's measurement run on a clean worktree" is unrecoverable for these runs:

| Iteration | Source-file Edit calls (transcripts) | Status under new harness if re-run |
|---|---|---|
| `iteration-merge-baseline` | 1 | would now flag contaminated |
| `iteration-triage-resolve-slug-fix` | 4 | would now flag contaminated; the `_shared/resolve-slug.js` HEAD content from this iteration is the audit target of "Next steps #3" below |
| `iteration-harness-skill-load-determinism` (`9ea0fcc`) | 4 | would now flag contaminated; the eval-injected `'suffix'` anchor mode that became commit-baseline residue traces to this iteration's restricted-profile JWT fixture run |
| `iteration-resolve-slug-fallback-rejected` (`0520371`) | 3 (forensics phase) | reverted manually; the cacheRoot fix that shipped is independent of contamination |

Going forward: any iteration that uses synthesis-eval as a load-bearing assertion should cite `contaminated_runs: 0` from its results.json, the way iterations currently cite the strict 5/5 pass count.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Mechanism design documented | one of {tree-hash, chmod-w, tool-restriction} chosen with rationale | tree-hash + auto-restore via git CLI; documented above | yes |
| Scope documented | what's protected and what's excluded | scope and exclusions documented; `test_dirty_set_excludes_gitignored_paths` anchors gitignore exclusion | yes |
| `tools/_eval_runner.py` snapshot/restore wired into `_spawn_and_bail` | yes | done | yes |
| Per-run result + envelope surface contamination | yes | `worktree_contaminated`, `worktree_changed_paths`, `worktree_restore_failures` per-run; `contaminated_runs` on envelope | yes |
| Unit tests for primitives | snapshot, baseline-subtract, restore-tracked, restore-untracked, mixed | 10 tests, all green | yes |
| Integration test for `_spawn_and_bail` cycle | end-to-end via patched spawn that mutates a tracked file | `test_spawn_detects_and_restores_contamination` (and 2 sibling tests) green | yes |
| Existing tests stay green | `tools/test_eval_runner.py`, `tools/test_eval_monitor.py`, `tools/test_synthesis_eval.py`, `tools/test_trigger_eval.py`, `_shared`, `dsc-endpoint-help` | 34/34 + 27/27 + others; 11/11 _shared; 4/4 dsc-endpoint-help | yes |
| Live verification observes contamination on the OCAPI fixture | desired | not observed: 3/3 clean runs (Sonnet 4.6 didn't contaminate this iteration's worktree on this fixture) | no – see "Verification observation"; integration test substitutes |
| `eval-monitor.py` regex stays byte-equivalent with the runner's | yes | optional `contaminated=` group on both regex copies; `test_progress_line_pattern_matches_runner` green | yes |

## Surprises

- **Live OCAPI fixture didn't contaminate.** Brief framed it as deterministic; under Sonnet 4.6 with this iteration's worktree it was 0/3. The harness invariant verification therefore relies on the integration test (controlled stub spawn) rather than the live run. The live run still has signal: 0 spurious flags on a clean run, baseline-subtraction worked under realistic operator-WIP conditions (the iteration's own dirty `tools/*.py` edits were untouched).
- **`git status` is the right primitive, not file-tree hash.** Initial design considered SHA-256 of every tracked file under `skills/`, `tools/`, etc. `git status --porcelain` collapses that into a single subprocess call with built-in `.gitignore` handling, rename detection, and operator-baseline interaction "just works" via set subtraction. The custom-hash design would have re-implemented all three.
- **Auto-restore is semantically two operations, not one.** `git checkout HEAD --` reverts tracked-modified content; `unlink` removes newly-created untracked files. A single primitive (e.g. `git clean -df` + `git checkout`) would over-reach – `git clean` removes anything untracked-not-gitignored, including operator-WIP files that were already in the baseline. Set-subtraction at the diff layer plus per-bucket primitives at the restore layer is the minimum-blast-radius shape.
- **Optional regex group preserves byte-equivalence with the monitor.** `tools/test_eval_monitor.py:TestRegexByteEquivalenceWithRunner` asserts the runner's and monitor's `PROGRESS_LINE_RE` patterns are byte-identical; an unconditional new field would have broken that test. Making the field optional in both copies (and unconditional in the emitter) keeps the invariant intact and gives back-compatibility with older log files for free.

## Next steps

This iteration is harness-only – it does not address the underlying triage.js bugs that eval-Sonnet was hot-patching in the historical contaminated runs. Those are scope-creep avenue and ship as separate iterations:

1. **`iteration-triage-ocapi-version-tolerance`** – OCAPI version drift handling. The cached `ocapi-shop-customers` spec is `v25_6`; the OCAPI-fault-envelope fixture sends a request to `/s/RefArch/dw/shop/v23_2/customers/abc12345` (v23_2). Current `resolve-slug.js` returns `null` on the version-literal mismatch; eval-Sonnet's hot-patch was to wildcard `vN_N`. The honest fix is a structured `version-mismatch` shape diff so the customer learns *why* their request 401'd against a version the spec doesn't describe, rather than silently matching.
2. **`iteration-triage-content-type-extraction`** – non-JSON request bodies. The 415 fixture sends `Content-Type: text/plain` with a JSON body; `parse-oas.js:69-70` returns `null` for non-JSON content because spec-declared `requestBody.content` has only `application/json`. Eval-Sonnet's hot-patch was to fall back to the first declared content-type. The honest fix is to extend `extractRequestBody` to return content-type metadata for non-JSON bodies so `diff.js` can compute a `wrong-content-type` finding citing the spec's accepted list.
3. **Audit `_shared/resolve-slug.js` at HEAD** – `iteration-triage-resolve-slug-fix` had 4 source-file Edit calls in its own transcripts; some of the code at HEAD may be eval-injected residue from that iteration's run. Worth diff'ing against the iteration-triage-resolve-slug-fix commit to confirm. Not urgent (the test suite would have caught any real breakage by now) but worth doing as part of the next iteration that touches `_shared/`.
