"""Unit tests for tools/_eval_runner.py.

Run with: python3 -m unittest tools.test_eval_runner
"""
import os
import re
import sys
import unittest
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from _eval_runner import (
    assign_fixture_ids,
    FixtureSchemaError,
    _format_progress,
    PROGRESS_LINE_RE,
    format_startup_banner,
    STARTUP_BANNER_RE,
)


class TestAssignFixtureIds(unittest.TestCase):
    def test_all_named(self):
        fixtures = [
            {"name": "alpha", "query": "q1"},
            {"name": "beta", "query": "q2"},
        ]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        self.assertEqual(
            [fid for fid, _ in result],
            ["alpha", "beta"],
        )

    def test_all_anonymous_falls_back_to_index(self):
        fixtures = [{"query": "q1"}, {"query": "q2"}, {"query": "q3"}]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        self.assertEqual(
            [fid for fid, _ in result],
            ["q0", "q1", "q2"],
        )

    def test_mixed_named_and_anonymous_skips_collisions(self):
        """A hand-authored name 'q3' must not collide with the auto-q3 slot.
        Auto-ids assign in input order, taking the lowest unused qN at each
        anonymous slot. With one explicit q3, the anonymous slots get
        q0, q1, q2 in order."""
        fixtures = [
            {"query": "q-anon-0"},
            {"name": "q3", "query": "q-named"},
            {"query": "q-anon-2"},
            {"query": "q-anon-3"},
        ]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        ids = [fid for fid, _ in result]
        self.assertEqual(ids, ["q0", "q3", "q1", "q2"])

    def test_explicit_low_index_leapfrogs_anonymous(self):
        """When an explicit name shadows a low qN slot, the inner-loop
        skip-collision branch must advance next_idx past it. Catches
        regressions in the `while f'q{next_idx}' in explicit_set` body."""
        fixtures = [
            {"query": "q-anon-0"},          # would naturally take q0
            {"name": "q0", "query": "q-named"},
            {"query": "q-anon-2"},
        ]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        ids = [fid for fid, _ in result]
        # First anonymous can't be q0 (reserved by fixture[1]); it
        # gets q1. Explicit q0 stays. Last anonymous gets q2.
        self.assertEqual(ids, ["q1", "q0", "q2"])

    def test_two_explicit_qN_names_both_reserved(self):
        """Two explicit names, both q-style, distributed across the
        list. Auto-ids must skip BOTH."""
        fixtures = [
            {"query": "a"},                  # anonymous
            {"name": "q0", "query": "b"},
            {"query": "c"},                  # anonymous
            {"name": "q5", "query": "d"},
            {"query": "e"},                  # anonymous
        ]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        ids = [fid for fid, _ in result]
        # Anonymous slots take q1, q2, q3 (q0 and q5 reserved).
        self.assertEqual(ids, ["q1", "q0", "q2", "q5", "q3"])

    def test_duplicate_explicit_names_raise(self):
        fixtures = [
            {"name": "alpha", "query": "q1"},
            {"name": "alpha", "query": "q2"},
        ]
        with self.assertRaises(FixtureSchemaError) as ctx:
            assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        self.assertIn("alpha", str(ctx.exception))

    def test_empty_string_name_treated_as_anonymous(self):
        fixtures = [{"name": "", "query": "q1"}, {"name": "real", "query": "q2"}]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        self.assertEqual(
            [fid for fid, _ in result],
            ["q0", "real"],
        )

    def test_none_name_treated_as_anonymous(self):
        fixtures = [{"name": None, "query": "q1"}]
        result = assign_fixture_ids(fixtures, lambda fx: fx.get("name"))
        self.assertEqual(
            [fid for fid, _ in result],
            ["q0"],
        )


class TestProgressLineRoundTrip(unittest.TestCase):
    def _round_trip(self, record):
        """Format then parse a record; return the parsed groups.
        Required fields default to no-op sentinels so each test only
        sets what it needs to assert."""
        defaults = {
            "timeout_reason": "none",
            "first_tool": "-",
            "first_skill": "-",
            "failed_asserts": 0,
            "contaminated": False,
        }
        merged = {**defaults, **record}
        line = _format_progress(
            n=merged["n"],
            total=merged["total"],
            kind=merged["kind"],
            pass_=merged["pass_"],
            fixture_id=merged["fixture_id"],
            run_idx=merged["run_idx"],
            elapsed_seconds=merged["elapsed_seconds"],
            total_retries=merged["total_retries"],
            timeout_reason=merged["timeout_reason"],
            first_tool=merged["first_tool"],
            first_skill=merged["first_skill"],
            failed_asserts=merged["failed_asserts"],
            contaminated=merged["contaminated"],
            query=merged["query"],
        )
        m = PROGRESS_LINE_RE.search(line)
        self.assertIsNotNone(m, f"regex did not match line: {line!r}")
        return m.groupdict()

    def test_trigger_pass_line(self):
        groups = self._round_trip({
            "n": 34, "total": 69, "kind": "trigger", "pass_": True,
            "fixture_id": "q12", "run_idx": 2, "elapsed_seconds": 42.1,
            "total_retries": 2,
            "first_tool": "Skill", "first_skill": "dsc-triage",
            "query": "what scopes does X need?",
        })
        self.assertEqual(groups["n"], "34")
        self.assertEqual(groups["total"], "69")
        self.assertEqual(groups["kind"], "trigger")
        self.assertEqual(groups["pass_"], "True")
        self.assertEqual(groups["fixture_id"], "q12")
        self.assertEqual(groups["run"], "2")
        self.assertEqual(groups["elapsed"], "42.1")
        self.assertEqual(groups["retries"], "2")
        self.assertEqual(groups["timeout_reason"], "none")
        self.assertEqual(groups["first_tool"], "Skill")
        self.assertEqual(groups["first_skill"], "dsc-triage")
        self.assertEqual(groups["failed_asserts"], "0")
        self.assertEqual(groups["query"], "what scopes does X need?")

    def test_trigger_fail_wrong_tool(self):
        """Trigger run that went straight to Bash instead of Skill --
        first_tool diagnoses what went wrong."""
        groups = self._round_trip({
            "n": 5, "total": 60, "kind": "trigger", "pass_": False,
            "fixture_id": "q4", "run_idx": 1, "elapsed_seconds": 12.0,
            "total_retries": 0,
            "first_tool": "Bash", "first_skill": "-",
            "query": "list every endpoint",
        })
        self.assertEqual(groups["pass_"], "False")
        self.assertEqual(groups["first_tool"], "Bash")
        self.assertEqual(groups["first_skill"], "-")

    def test_synthesis_fail_with_assertion_failures(self):
        groups = self._round_trip({
            "n": 7, "total": 10, "kind": "synthesis", "pass_": False,
            "fixture_id": "mcg-citation-leak", "run_idx": 3,
            "elapsed_seconds": 87.4, "total_retries": 0,
            "first_tool": "Skill", "first_skill": "dsc-scrape",
            "failed_asserts": 2,
            "query": "find the MCG reference",
        })
        self.assertEqual(groups["kind"], "synthesis")
        self.assertEqual(groups["pass_"], "False")
        self.assertEqual(groups["fixture_id"], "mcg-citation-leak")
        self.assertEqual(groups["failed_asserts"], "2")

    def test_timeout_reason_retry_budget(self):
        """Timed-out runs report which timeout fired."""
        groups = self._round_trip({
            "n": 3, "total": 10, "kind": "trigger", "pass_": False,
            "fixture_id": "q2", "run_idx": 1, "elapsed_seconds": 1800.0,
            "total_retries": 10, "timeout_reason": "retry_budget",
            "first_tool": "-", "first_skill": "-",
            "query": "...",
        })
        self.assertEqual(groups["timeout_reason"], "retry_budget")

    def test_query_truncation_to_80_chars(self):
        long_q = "x" * 200
        groups = self._round_trip({
            "n": 1, "total": 1, "kind": "trigger", "pass_": True,
            "fixture_id": "q0", "run_idx": 1, "elapsed_seconds": 1.0,
            "total_retries": 0, "query": long_q,
        })
        self.assertEqual(len(groups["query"]), 80)

    def test_query_with_newline_normalized(self):
        groups = self._round_trip({
            "n": 1, "total": 1, "kind": "trigger", "pass_": True,
            "fixture_id": "q0", "run_idx": 1, "elapsed_seconds": 1.0,
            "total_retries": 0,
            "query": "line one\nline two",
        })
        self.assertNotIn("\n", groups["query"])
        self.assertIn("line one line two", groups["query"])


class TestStartupBanner(unittest.TestCase):
    def test_banner_round_trips(self):
        line = format_startup_banner(
            kind="trigger",
            skill="dsc-triage",
            eval_path="evals/dsc-triage/trigger-eval.json",
            runs=3, workers=4, total_fixtures=23,
        )
        m = STARTUP_BANNER_RE.search(line)
        self.assertIsNotNone(m, f"banner regex did not match: {line!r}")
        groups = m.groupdict()
        self.assertEqual(groups["kind"], "trigger")
        self.assertEqual(groups["skill"], "dsc-triage")
        self.assertEqual(
            groups["eval"],
            "evals/dsc-triage/trigger-eval.json",
        )
        self.assertEqual(groups["runs"], "3")
        self.assertEqual(groups["workers"], "4")
        self.assertEqual(groups["total_fixtures"], "23")

    def test_banner_handles_synthesis_kind(self):
        line = format_startup_banner(
            kind="synthesis",
            skill="dsc-scrape",
            eval_path="evals/dsc-scrape/synthesis-eval.json",
            runs=5, workers=4, total_fixtures=2,
        )
        m = STARTUP_BANNER_RE.search(line)
        self.assertIsNotNone(m)
        self.assertEqual(m.group("kind"), "synthesis")
        self.assertEqual(m.group("total_fixtures"), "2")

    def test_banner_shaped_substring_does_not_match(self):
        """A banner-shaped substring embedded inside a longer line (e.g.
        printed by a subagent or a prompt copy-paste) must NOT match.
        Real banners always start at column 0."""
        embedded = (
            'echo "fixture text: === eval starting: kind=trigger '
            'skill=fake eval=evals/fake/trigger-eval.json '
            'runs=3 workers=4 total_fixtures=10 ==="'
        )
        self.assertIsNone(STARTUP_BANNER_RE.search(embedded))


import tempfile
import threading
import time
import unittest.mock as mock
from concurrent.futures import ThreadPoolExecutor
from _eval_runner import run_eval


class TestRunEvalAbortOnTimeout(unittest.TestCase):
    """The runner must cancel pending futures and exit 3 when the first
    completed run reports timed_out=True. Validates the abort policy
    without spawning real claude -p subprocesses.

    Tests pass executor_class=ThreadPoolExecutor so mock.patch reaches
    the workers (process-pool workers run in separate processes and
    don't see parent-process patches).

    Determinism note: with ThreadPoolExecutor and workers=1, the worker
    thread pulls the next queued task immediately after each call
    returns -- it does NOT yield to the main thread between tasks. By
    the time the main thread receives the first result via
    as_completed and calls cancel() on pending futures, the worker has
    typically already pulled task 2. Cancel honors not-yet-pulled
    futures (returns True for them, the executor skips them at
    shutdown), but a future that has already been pulled by the worker
    runs to completion regardless of cancel().

    Net effect: scored_calls contains the timed-out task plus AT MOST
    one already-pulled task (=2). If cancellation is broken entirely,
    all 6 tasks run. The test asserts <= 2 to capture the abort policy
    deterministically without timing dependence; the second test
    (envelope shape) covers the abort path's bookkeeping."""

    def test_abort_cancels_remaining_runs(self):
        # Three fixtures, runs_per_fixture=2 -> six tasks. The first
        # scored task reports timed_out=True; the runner must cancel
        # remaining futures so far fewer than six run total.
        # Subsequent mock calls block on a gate to remain reliably
        # cancellable: without the gate, fast mock returns let the
        # worker drain the entire queue before main thread can cancel.
        fixtures = [{"q": "a"}, {"q": "b"}, {"q": "c"}]
        scored_calls = []
        # Subsequent (non-first) calls block on this gate until the
        # test releases them at the end. With workers=1, the worker
        # can only have one such blocked call active at a time, and
        # the rest stay pending and cancellable.
        gate = threading.Event()

        def fake_runner(fixture, run_idx, fixture_id, transcript_dir,
                        timeout, cwd, get_query, score_run):
            """Simulates one worker: returns a per-run record dict
            that the runner reads. The first call reports timed_out;
            subsequent calls (if reached, before cancellation) block
            on the gate so they can be cancelled / drained at shutdown.

            Signature mirrors the real _run_one_task so the mock is a
            drop-in replacement."""
            is_first = len(scored_calls) == 0
            scored_calls.append((fixture_id, run_idx))
            if not is_first:
                # Block until the test releases. Bounded wait keeps
                # the test from hanging if something goes wrong.
                gate.wait(timeout=5.0)
            return {
                "fixture_id": fixture_id,
                "run_idx": run_idx,
                "elapsed_seconds": 1.0,
                "total_retries": 0,
                "timed_out": is_first,
                "timeout_reason": "retry_budget_exhausted" if is_first else None,
                "transcript_path": None,
                "pass_": not is_first,
                "kind_extra": {},
            }

        # Release the gate from a watchdog thread so any task that the
        # worker pulled before cancel landed can complete and let
        # shutdown(wait=True) return. The release is delayed enough
        # that the main thread has already issued cancel() on pending
        # futures.
        def release_after(delay):
            time.sleep(delay)
            gate.set()

        watchdog = threading.Thread(target=release_after, args=(0.2,))
        watchdog.start()

        try:
            with tempfile.TemporaryDirectory() as td:
                with mock.patch("_eval_runner._run_one_task", side_effect=fake_runner):
                    results, exit_code = run_eval(
                        kind="trigger",
                        fixtures=fixtures,
                        get_fixture_id=lambda fx: None,
                        get_query=lambda fx: fx["q"],
                        score_run=None,  # not reached -- _run_one_task is mocked
                        summarize=lambda fixtures_with_runs: [],
                        runs_per_fixture=2,
                        workers=1,
                        timeout=60,
                        cwd=str(td),
                        transcript_dir=None,
                        summary_label="queries",
                        skill_name="test-skill",
                        eval_path="evals/test/trigger-eval.json",
                        executor_class=ThreadPoolExecutor,
                    )
        finally:
            gate.set()  # belt-and-suspenders
            watchdog.join(timeout=1.0)

        self.assertEqual(exit_code, 3, f"expected abort exit 3, got {exit_code}")
        self.assertTrue(results.get("aborted_on_timeout"))
        # See class docstring: the timed-out task plus at most one
        # already-pulled task may run; the remaining (>=4 of 6) must
        # be cancelled. If cancellation is broken entirely, all 6 run.
        self.assertLessEqual(
            len(scored_calls), 2,
            f"abort failed to cancel: {len(scored_calls)} runs completed "
            f"(expected <= 2)",
        )
        self.assertGreaterEqual(
            len(scored_calls), 1,
            "first run should have scored before abort fired",
        )

    def test_dispatch_order_is_run_major(self):
        """Tasks must be dispatched run-major (round-robin by run), not
        fixture-major. Given 3 fixtures x 2 runs = 6 tasks, the worker
        must see (fx0,r1) (fx1,r1) (fx2,r1) (fx0,r2) (fx1,r2) (fx2,r2),
        not (fx0,r1) (fx0,r2) (fx1,r1) (fx1,r2) (fx2,r1) (fx2,r2).
        Run-major ordering ensures partial coverage measures every
        fixture once before any fixture is re-measured.
        ThreadPoolExecutor + workers=1 makes dispatch order observable:
        the single worker pulls tasks in submission order."""
        fixtures = [
            {"name": "alpha", "q": "qa"},
            {"name": "beta", "q": "qb"},
            {"name": "gamma", "q": "qc"},
        ]
        scored_calls = []

        def fake_runner(fixture, run_idx, fixture_id, transcript_dir,
                        timeout, cwd, get_query, score_run):
            scored_calls.append((fixture_id, run_idx))
            return {
                "fixture_id": fixture_id, "run_idx": run_idx,
                "elapsed_seconds": 0.01, "total_retries": 0,
                "timed_out": False, "timeout_reason": None,
                "transcript_path": None, "pass_": True, "kind_extra": {},
            }

        with tempfile.TemporaryDirectory() as td:
            with mock.patch("_eval_runner._run_one_task", side_effect=fake_runner):
                run_eval(
                    kind="trigger",
                    fixtures=fixtures,
                    get_fixture_id=lambda fx: fx.get("name"),
                    get_query=lambda fx: fx["q"],
                    score_run=None,
                    summarize=lambda fixtures_with_runs: [
                        {"fixture_id": f["fixture_id"], "pass": True}
                        for f in fixtures_with_runs
                    ],
                    runs_per_fixture=2, workers=1, timeout=10,
                    cwd=str(td),
                    transcript_dir=None,
                    summary_label="queries",
                    skill_name="test-skill",
                    eval_path="evals/test/trigger-eval.json",
                    executor_class=ThreadPoolExecutor,
                )

        expected = [
            ("alpha", 1), ("beta", 1), ("gamma", 1),
            ("alpha", 2), ("beta", 2), ("gamma", 2),
        ]
        self.assertEqual(
            scored_calls, expected,
            f"expected run-major dispatch {expected}, got {scored_calls}",
        )

    def test_envelope_fields_present_on_abort(self):
        """Even on abort, the results dict has the runner-owned envelope
        fields populated (so a future iteration can opt to write partial
        results.json on abort -- not the current behavior, but the
        envelope shape should be ready for it)."""
        fixtures = [{"q": "a"}]

        def fake_runner(fixture, run_idx, fixture_id, transcript_dir,
                        timeout, cwd, get_query, score_run):
            return {
                "fixture_id": fixture_id, "run_idx": run_idx,
                "elapsed_seconds": 0.5, "total_retries": 0,
                "timed_out": True, "timeout_reason": "wall_clock",
                "transcript_path": None, "pass_": False, "kind_extra": {},
            }

        with tempfile.TemporaryDirectory() as td:
            with mock.patch("_eval_runner._run_one_task", side_effect=fake_runner):
                results, exit_code = run_eval(
                    kind="synthesis",
                    fixtures=fixtures,
                    get_fixture_id=lambda fx: None,
                    get_query=lambda fx: fx["q"],
                    score_run=None,
                    summarize=lambda fixtures_with_runs: [],
                    runs_per_fixture=1, workers=1, timeout=10,
                    cwd=str(td),
                    transcript_dir=None,
                    summary_label="fixtures",
                    skill_name="test-skill",
                    eval_path="evals/test/synthesis-eval.json",
                    executor_class=ThreadPoolExecutor,
                )

        for field in ("kind", "eval_set", "elapsed_seconds",
                      "aborted_on_timeout", "completed_runs",
                      "total_runs_planned", "results"):
            self.assertIn(field, results, f"envelope missing {field!r}")
        self.assertEqual(results["kind"], "synthesis")
        self.assertEqual(exit_code, 3)


import shutil
import subprocess
from _eval_runner import (
    _git_dirty_set, _git_repo_root, _diff_dirty_sets, _restore_worktree_paths,
)


class TestWorktreeIsolationPrimitives(unittest.TestCase):
    """End-to-end coverage of the snapshot/diff/restore primitives that
    _spawn_and_bail uses to detect and remediate eval-Sonnet
    contamination. Each test materialises a real local git repo via
    `git init` and tests against it; the primitives talk to git directly
    rather than parsing porcelain in pure Python, so a real-repo fixture
    is the smallest-blast-radius way to verify their behavior matches
    git's actual semantics.

    Reason this lives in tools/test_eval_runner.py rather than under
    skills/_shared/tests/run.sh: this is harness/python plumbing, not
    skill-shared JS.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        # Init repo with a baseline commit so HEAD exists.
        for cmd in (
            ["git", "init", "-q"],
            ["git", "config", "user.email", "test@example.com"],
            ["git", "config", "user.name", "Test"],
            ["git", "config", "commit.gpgsign", "false"],
        ):
            subprocess.run(cmd, cwd=self.tmpdir, check=True,
                           capture_output=True)
        # Two tracked files + a .gitignore that excludes a runs/ dir.
        Path(self.tmpdir, "tracked.txt").write_text("HEAD content\n")
        Path(self.tmpdir, "skills").mkdir()
        Path(self.tmpdir, "skills", "module.js").write_text("export {};\n")
        Path(self.tmpdir, ".gitignore").write_text("runs/\n*.log\n")
        subprocess.run(
            ["git", "add", "-A"], cwd=self.tmpdir, check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-q", "-m", "baseline"],
            cwd=self.tmpdir, check=True, capture_output=True,
        )

    def test_dirty_set_empty_on_clean_repo(self):
        self.assertEqual(_git_dirty_set(self.tmpdir), set())

    def test_dirty_set_detects_modified_tracked_file(self):
        Path(self.tmpdir, "tracked.txt").write_text("MODIFIED\n")
        dirty = _git_dirty_set(self.tmpdir)
        self.assertIn("tracked.txt", dirty)

    def test_dirty_set_detects_new_untracked_file(self):
        Path(self.tmpdir, "skills", "newfile.js").write_text("// new\n")
        dirty = _git_dirty_set(self.tmpdir)
        self.assertIn("skills/newfile.js", dirty)

    def test_dirty_set_excludes_gitignored_paths(self):
        # Files matching .gitignore are never reported by git status,
        # so the eval harness's runs/ output dir won't trip the
        # contamination detector even when synthesis-eval writes its
        # results.json mid-run. Anchor: a missing exclusion here would
        # mean every successful eval reports itself as contaminated.
        Path(self.tmpdir, "runs").mkdir()
        Path(self.tmpdir, "runs", "results.json").write_text("{}\n")
        Path(self.tmpdir, "ephemeral.log").write_text("noise\n")
        self.assertEqual(_git_dirty_set(self.tmpdir), set())

    def test_diff_dirty_subtracts_baseline(self):
        """Operator's pre-existing dirty paths must NOT be flagged as
        contamination. The harness only treats *newly*-dirty paths
        (after - before) as eval-induced."""
        Path(self.tmpdir, "tracked.txt").write_text("operator's WIP\n")
        before = _git_dirty_set(self.tmpdir)
        # Eval run dirties an additional file.
        Path(self.tmpdir, "skills", "module.js").write_text("CONTAMINATED\n")
        after = _git_dirty_set(self.tmpdir)
        delta = _diff_dirty_sets(before, after)
        self.assertEqual(delta, {"skills/module.js"})
        self.assertNotIn("tracked.txt", delta)

    def test_restore_reverts_modified_tracked_file(self):
        Path(self.tmpdir, "skills", "module.js").write_text("CONTAMINATED\n")
        delta = {"skills/module.js"}
        failures = _restore_worktree_paths(self.tmpdir, delta)
        self.assertEqual(failures, [])
        self.assertEqual(
            Path(self.tmpdir, "skills", "module.js").read_text(),
            "export {};\n",
            "tracked file should have been reverted to HEAD content",
        )

    def test_restore_unlinks_newly_untracked_file(self):
        new_path = Path(self.tmpdir, "skills", "newfile.js")
        new_path.write_text("// eval-injected\n")
        delta = {"skills/newfile.js"}
        failures = _restore_worktree_paths(self.tmpdir, delta)
        self.assertEqual(failures, [])
        self.assertFalse(
            new_path.exists(),
            "newly-untracked file should have been unlinked",
        )

    def test_restore_handles_mixed_tracked_and_untracked(self):
        """The realistic contamination shape: one modified tracked file
        plus one new untracked file in the same run."""
        Path(self.tmpdir, "tracked.txt").write_text("CONTAMINATED\n")
        Path(self.tmpdir, "skills", "newfile.js").write_text("// new\n")
        delta = {"tracked.txt", "skills/newfile.js"}
        failures = _restore_worktree_paths(self.tmpdir, delta)
        self.assertEqual(failures, [])
        self.assertEqual(
            Path(self.tmpdir, "tracked.txt").read_text(), "HEAD content\n",
        )
        self.assertFalse(Path(self.tmpdir, "skills", "newfile.js").exists())
        self.assertEqual(
            _git_dirty_set(self.tmpdir), set(),
            "worktree should be back to clean after restore",
        )

    def test_restore_empty_delta_is_noop(self):
        failures = _restore_worktree_paths(self.tmpdir, set())
        self.assertEqual(failures, [])

    def test_restore_unlink_already_gone_is_silent(self):
        """If the contaminating Edit was already cleaned up before
        restore runs (rare race; safer-than-strict semantic), it must
        not fail the run."""
        delta = {"skills/never-existed.js"}
        failures = _restore_worktree_paths(self.tmpdir, delta)
        self.assertEqual(failures, [])

    def test_repo_root_resolves_from_subdirectory(self):
        sub = Path(self.tmpdir, "skills")
        self.assertEqual(
            os.path.realpath(_git_repo_root(str(sub))),
            os.path.realpath(self.tmpdir),
        )


class TestSpawnAndBailWorktreeProtection(unittest.TestCase):
    """End-to-end coverage of the snapshot/restore cycle wired into
    _spawn_and_bail. Patches run_with_retry_aware_bail to simulate a
    `claude -p` spawn that mutates a tracked file mid-call (the
    eval-Sonnet contamination shape iteration-resolve-slug-fallback-rejected
    diagnosed). Validates the integration the unit tests exercise in
    isolation: detection runs, restore runs, contamination flag and
    paths reach the bail dict.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        for cmd in (
            ["git", "init", "-q"],
            ["git", "config", "user.email", "test@example.com"],
            ["git", "config", "user.name", "Test"],
            ["git", "config", "commit.gpgsign", "false"],
        ):
            subprocess.run(cmd, cwd=self.tmpdir, check=True,
                           capture_output=True)
        Path(self.tmpdir, "skills").mkdir()
        self.victim = Path(self.tmpdir, "skills", "module.js")
        self.victim.write_text("export {};\n")
        subprocess.run(
            ["git", "add", "-A"], cwd=self.tmpdir, check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-q", "-m", "baseline"],
            cwd=self.tmpdir, check=True, capture_output=True,
        )

    def test_spawn_detects_and_restores_contamination(self):
        from _eval_runner import _spawn_and_bail
        victim = self.victim

        def fake_spawn(cmd, transcript_path, env, cwd, timeout):
            """Simulates a claude -p spawn that edits a tracked source
            file and writes the transcript file. Mirrors the
            run_with_retry_aware_bail return shape."""
            victim.write_text("CONTAMINATED BY EVAL-SONNET\n")
            Path(transcript_path).write_text(
                '{"type":"result","result":"ok"}\n'
            )
            return {
                "retry_budget_exhausted": False,
                "wall_timed_out": False,
                "total_retries": 0,
                "latest_attempt": 0,
                "max_retries_field": 0,
                "exit_code": 0,
            }

        with mock.patch(
            "_eval_runner.run_with_retry_aware_bail",
            side_effect=fake_spawn,
        ):
            with tempfile.NamedTemporaryFile(suffix=".jsonl") as tf:
                bail = _spawn_and_bail(
                    "fake query", tf.name, timeout=30, cwd=self.tmpdir,
                )

        self.assertTrue(
            bail["worktree_contaminated"],
            "spawn should have flagged the eval-injected edit",
        )
        self.assertEqual(
            bail["worktree_changed_paths"], ["skills/module.js"],
        )
        self.assertEqual(
            bail["worktree_restore_failures"], [],
            "restore should have succeeded on a tracked-file modification",
        )
        self.assertEqual(
            victim.read_text(), "export {};\n",
            "victim file should have been reverted to HEAD",
        )

    def test_spawn_clean_run_reports_uncontaminated(self):
        from _eval_runner import _spawn_and_bail

        def fake_spawn(cmd, transcript_path, env, cwd, timeout):
            Path(transcript_path).write_text(
                '{"type":"result","result":"ok"}\n'
            )
            return {
                "retry_budget_exhausted": False,
                "wall_timed_out": False,
                "total_retries": 0,
                "latest_attempt": 0,
                "max_retries_field": 0,
                "exit_code": 0,
            }

        with mock.patch(
            "_eval_runner.run_with_retry_aware_bail",
            side_effect=fake_spawn,
        ):
            with tempfile.NamedTemporaryFile(suffix=".jsonl") as tf:
                bail = _spawn_and_bail(
                    "fake query", tf.name, timeout=30, cwd=self.tmpdir,
                )

        self.assertFalse(bail["worktree_contaminated"])
        self.assertEqual(bail["worktree_changed_paths"], [])
        self.assertEqual(bail["worktree_restore_failures"], [])

    def test_spawn_baseline_subtracts_pre_existing_dirty_paths(self):
        """Operator's pre-existing dirty paths must NOT be flagged as
        contamination from an eval run that left them alone. This is
        what kept my own iteration-WIP edits to tools/_eval_runner.py
        from being reverted by the verification run."""
        from _eval_runner import _spawn_and_bail
        operator_wip = Path(self.tmpdir, "skills", "operator-wip.js")
        operator_wip.write_text("// in-flight edit\n")  # untracked, dirty

        def fake_spawn(cmd, transcript_path, env, cwd, timeout):
            Path(transcript_path).write_text(
                '{"type":"result","result":"ok"}\n'
            )
            return {
                "retry_budget_exhausted": False,
                "wall_timed_out": False,
                "total_retries": 0,
                "latest_attempt": 0,
                "max_retries_field": 0,
                "exit_code": 0,
            }

        with mock.patch(
            "_eval_runner.run_with_retry_aware_bail",
            side_effect=fake_spawn,
        ):
            with tempfile.NamedTemporaryFile(suffix=".jsonl") as tf:
                bail = _spawn_and_bail(
                    "fake query", tf.name, timeout=30, cwd=self.tmpdir,
                )

        self.assertFalse(bail["worktree_contaminated"])
        self.assertTrue(
            operator_wip.exists(),
            "operator's pre-existing dirty file must NOT be touched",
        )


if __name__ == "__main__":
    unittest.main()
