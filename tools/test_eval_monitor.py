"""Unit tests for tools/eval-monitor.py.

Run with: python3 -m unittest tools.test_eval_monitor
"""
import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "eval_monitor", THIS_DIR / "eval-monitor.py"
)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
import _eval_runner


class TestUUIDDetection(unittest.TestCase):
    def test_full_uuid_matches(self):
        self.assertTrue(monitor.UUID_RE.match(
            "0fc37026-8647-4ad2-af01-78caee89d848"))

    def test_uppercase_uuid_matches(self):
        self.assertTrue(monitor.UUID_RE.match(
            "0FC37026-8647-4AD2-AF01-78CAEE89D848"))

    def test_uuid_prefix_matches(self):
        self.assertTrue(monitor.UUID_PREFIX_RE.match("0fc37026"))
        self.assertTrue(monitor.UUID_PREFIX_RE.match("0fc3"))

    def test_short_prefix_does_not_match(self):
        # 3 hex chars is too short to disambiguate; we require >= 4.
        self.assertFalse(monitor.UUID_PREFIX_RE.match("abc"))

    def test_human_name_does_not_match(self):
        self.assertFalse(monitor.UUID_PREFIX_RE.match("test-rename-yeehaw"))
        self.assertFalse(monitor.UUID_PREFIX_RE.match("my session"))

    def test_uuid_from_tasks_dir_extracts(self):
        path = Path("/tmp/claude-501/-myrepo/"
                    "0fc37026-8647-4ad2-af01-78caee89d848/tasks")
        self.assertEqual(
            monitor._uuid_from_tasks_dir(path),
            "0fc37026-8647-4ad2-af01-78caee89d848",
        )

    def test_uuid_from_tasks_dir_returns_none_for_non_uuid_segment(self):
        path = Path("/tmp/claude-501/-myrepo/not-a-uuid/tasks")
        self.assertIsNone(monitor._uuid_from_tasks_dir(path))


class TestNameForUUID(unittest.TestCase):
    def test_returns_name_from_jsonl(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            uuid = "abcd1234-1111-2222-3333-444455556666"
            project_dir = home / ".claude" / "projects" / "-some-repo"
            project_dir.mkdir(parents=True)
            jsonl = project_dir / f"{uuid}.jsonl"
            jsonl.write_text(
                json.dumps({"type": "custom-title",
                            "customTitle": "my-named-session",
                            "sessionId": uuid}) + "\n"
            )
            with mock.patch.object(monitor.Path, "home", return_value=home):
                self.assertEqual(monitor._name_for_uuid(uuid),
                                 "my-named-session")

    def test_returns_latest_name_when_renamed_twice(self):
        """The user can /rename a session multiple times; we honor the
        latest customTitle entry, not the first."""
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            uuid = "abcd1234-1111-2222-3333-444455556666"
            project_dir = home / ".claude" / "projects" / "-some-repo"
            project_dir.mkdir(parents=True)
            jsonl = project_dir / f"{uuid}.jsonl"
            jsonl.write_text(
                json.dumps({"type": "custom-title",
                            "customTitle": "first-name",
                            "sessionId": uuid}) + "\n"
                + json.dumps({"type": "custom-title",
                              "customTitle": "second-name",
                              "sessionId": uuid}) + "\n"
            )
            with mock.patch.object(monitor.Path, "home", return_value=home):
                self.assertEqual(monitor._name_for_uuid(uuid),
                                 "second-name")

    def test_returns_none_when_no_jsonl(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(monitor.Path, "home",
                                   return_value=Path(td)):
                self.assertIsNone(
                    monitor._name_for_uuid(
                        "abcd1234-1111-2222-3333-444455556666"))

    def test_returns_none_for_empty_uuid(self):
        self.assertIsNone(monitor._name_for_uuid(None))
        self.assertIsNone(monitor._name_for_uuid(""))


class TestResolveSessionArg(unittest.TestCase):
    """End-to-end resolver tests over a synthetic Claude Code layout
    (~/.claude/projects/<repo>/<uuid>.jsonl + $TMPDIR/claude-<uid>/<repo>/<uuid>/tasks)."""

    def _setup(self, tmp_root, sessions):
        """sessions: list of (uuid, name_or_none, mtime_offset_seconds)."""
        home = tmp_root / "home"
        tmp = tmp_root / "tmp"
        proj = home / ".claude" / "projects" / "-myrepo"
        proj.mkdir(parents=True)
        tasks_root = tmp / "claude-501" / "-myrepo"
        tasks_root.mkdir(parents=True)
        now = 1_700_000_000
        for uuid, name, offset in sessions:
            jsonl = proj / f"{uuid}.jsonl"
            jsonl.write_text(
                (json.dumps({"type": "custom-title",
                             "customTitle": name,
                             "sessionId": uuid}) + "\n")
                if name else
                json.dumps({"type": "session-start", "sessionId": uuid}) + "\n"
            )
            os.utime(jsonl, (now + offset, now + offset))
            tasks = tasks_root / uuid / "tasks"
            tasks.mkdir(parents=True)
            (tasks / "x.output").write_text("")
        return home, tmp

    def _patch_env(self, home, tmp):
        return [
            mock.patch.object(monitor.Path, "home", return_value=home),
            mock.patch.dict(os.environ, {"TMPDIR": str(tmp)}, clear=False),
        ]

    def test_full_uuid_resolves(self):
        with tempfile.TemporaryDirectory() as td:
            home, tmp = self._setup(Path(td), [
                ("abcd1234-1111-2222-3333-444455556666", "my-name", 0),
            ])
            for p in self._patch_env(home, tmp): p.start()
            try:
                d = monitor.resolve_session_arg(
                    "abcd1234-1111-2222-3333-444455556666")
                self.assertIsNotNone(d)
                self.assertTrue(str(d).endswith(
                    "abcd1234-1111-2222-3333-444455556666/tasks"))
            finally:
                mock.patch.stopall()

    def test_uuid_prefix_resolves(self):
        with tempfile.TemporaryDirectory() as td:
            home, tmp = self._setup(Path(td), [
                ("abcd1234-1111-2222-3333-444455556666", "my-name", 0),
            ])
            for p in self._patch_env(home, tmp): p.start()
            try:
                d = monitor.resolve_session_arg("abcd1234")
                self.assertIsNotNone(d)
                self.assertTrue(str(d).endswith(
                    "abcd1234-1111-2222-3333-444455556666/tasks"))
            finally:
                mock.patch.stopall()

    def test_human_name_resolves(self):
        with tempfile.TemporaryDirectory() as td:
            home, tmp = self._setup(Path(td), [
                ("abcd1234-1111-2222-3333-444455556666",
                 "my-named-session", 0),
            ])
            for p in self._patch_env(home, tmp): p.start()
            try:
                d = monitor.resolve_session_arg("my-named-session")
                self.assertIsNotNone(d)
                self.assertTrue(str(d).endswith(
                    "abcd1234-1111-2222-3333-444455556666/tasks"))
            finally:
                mock.patch.stopall()

    def test_unknown_name_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            home, tmp = self._setup(Path(td), [
                ("abcd1234-1111-2222-3333-444455556666",
                 "my-named-session", 0),
            ])
            for p in self._patch_env(home, tmp): p.start()
            try:
                self.assertIsNone(
                    monitor.resolve_session_arg("nonexistent-name"))
            finally:
                mock.patch.stopall()

    def test_ambiguous_uuid_prefix_picks_newest(self):
        """Two sessions share a UUID prefix. The resolver picks the one
        with the most-recent tasks/ mtime so users get their latest run."""
        with tempfile.TemporaryDirectory() as td:
            home, tmp = self._setup(Path(td), [
                ("abcd1234-aaaa-1111-1111-111111111111", "older", -100),
                ("abcd1234-bbbb-2222-2222-222222222222", "newer", 0),
            ])
            # Bump the newer tasks dir's mtime explicitly.
            newer_tasks = tmp / "claude-501" / "-myrepo" / \
                "abcd1234-bbbb-2222-2222-222222222222" / "tasks"
            os.utime(newer_tasks, (1_700_000_999, 1_700_000_999))
            older_tasks = tmp / "claude-501" / "-myrepo" / \
                "abcd1234-aaaa-1111-1111-111111111111" / "tasks"
            os.utime(older_tasks, (1_700_000_000, 1_700_000_000))
            for p in self._patch_env(home, tmp): p.start()
            try:
                d = monitor.resolve_session_arg("abcd1234")
                self.assertIsNotNone(d)
                self.assertIn("bbbb", str(d))
            finally:
                mock.patch.stopall()


class TestDiscoverSessionExplicitNotFound(unittest.TestCase):
    def test_explicit_arg_does_not_fall_back_to_auto_detect(self):
        """When --session is explicit but resolves to nothing, the
        dashboard must NOT silently fall back to the current session.
        That would surface the wrong session under the user's nose."""
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            home.mkdir(parents=True)
            # No projects, no tasks dirs.
            with mock.patch.object(monitor.Path, "home", return_value=home), \
                 mock.patch.object(monitor, "_explicit_session_arg",
                                   "no-such-session"):
                rec = monitor.discover_session()
                self.assertIsNone(rec["tasks_dir"])
                self.assertEqual(rec["source"], "explicit-not-found")


class TestCanonicalProgressLine(unittest.TestCase):
    """The monitor's PROGRESS_LINE_RE must match the canonical line
    emitted by _eval_runner._format_progress."""

    def test_trigger_line_matches(self):
        line = ("[34/69] kind=trigger pass=True fixture_id=q12 run=2 "
                "elapsed=42.1s retries=2 timeout_reason=none "
                "first_tool=Skill first_skill=dsc-triage failed_asserts=0"
                ": what scopes does X need?")
        m = monitor.PROGRESS_LINE_RE.search(line)
        self.assertIsNotNone(m, f"regex did not match line: {line!r}")
        g = m.groupdict()
        self.assertEqual(g["kind"], "trigger")
        self.assertEqual(g["pass_"], "True")
        self.assertEqual(g["fixture_id"], "q12")
        self.assertEqual(g["run"], "2")
        self.assertEqual(g["elapsed"], "42.1")
        self.assertEqual(g["retries"], "2")
        self.assertEqual(g["timeout_reason"], "none")
        self.assertEqual(g["first_tool"], "Skill")
        self.assertEqual(g["first_skill"], "dsc-triage")
        self.assertEqual(g["failed_asserts"], "0")
        self.assertEqual(g["query"], "what scopes does X need?")

    def test_synthesis_line_matches(self):
        line = ("[7/10] kind=synthesis pass=False fixture_id=mcg-citation-leak "
                "run=3 elapsed=87.4s retries=0 timeout_reason=none "
                "first_tool=Skill first_skill=dsc-scrape failed_asserts=2"
                ": find the MCG reference")
        m = monitor.PROGRESS_LINE_RE.search(line)
        self.assertIsNotNone(m)
        self.assertEqual(m.group("kind"), "synthesis")
        self.assertEqual(m.group("pass_"), "False")
        self.assertEqual(m.group("fixture_id"), "mcg-citation-leak")
        self.assertEqual(m.group("failed_asserts"), "2")

    def test_old_format_no_longer_matches(self):
        """Old probe-eval stderr lines (triggered=...) must NOT match
        the new regex -- if they do, the dashboard would mis-interpret
        them. Old .output files from pre-rename runs fall through
        silently, which is the desired behavior."""
        old_line = ("  [34/69] triggered=True first_tool=Skill "
                    "first_skill=dsc-triage elapsed=42.1s retries=2: "
                    "what scopes does X need?")
        m = monitor.PROGRESS_LINE_RE.search(old_line)
        self.assertIsNone(m)

    def test_timeout_reason_retry_budget_round_trips(self):
        """A run that exhausted its retry budget emits
        timeout_reason=retry_budget. The dashboard's
        recent-completions table renders this verbatim, so the regex
        must accept it and _parse_progress_rows must surface it on the
        row dict."""
        line = ("[5/10] kind=trigger pass=False fixture_id=q4 run=1 "
                "elapsed=240.0s retries=10 timeout_reason=retry_budget "
                "first_tool=- first_skill=- failed_asserts=0"
                ": gateway pinned us")
        m = monitor.PROGRESS_LINE_RE.search(line)
        self.assertIsNotNone(m)
        self.assertEqual(m.group("timeout_reason"), "retry_budget")
        rows = monitor._parse_progress_rows(line)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["timeout_reason"], "retry_budget")
        self.assertFalse(rows[0]["pass_"])

    def test_timeout_reason_wall_clock_round_trips(self):
        """The other timeout shape: wall-clock cutoff before retries
        could finish. Same round-trip expectation."""
        line = ("[6/10] kind=synthesis pass=False fixture_id=q5 run=2 "
                "elapsed=600.0s retries=3 timeout_reason=wall_clock "
                "first_tool=Skill first_skill=dsc-scenario failed_asserts=0"
                ": query that timed out")
        m = monitor.PROGRESS_LINE_RE.search(line)
        self.assertIsNotNone(m)
        self.assertEqual(m.group("timeout_reason"), "wall_clock")
        rows = monitor._parse_progress_rows(line)
        self.assertEqual(rows[0]["timeout_reason"], "wall_clock")

    def test_first_tool_dash_sentinel_parses_as_none(self):
        """When the run produced no tool_use events (text-only response
        or a hard timeout before any tool fired), the runner emits
        first_tool=- and first_skill=-. _parse_progress_rows must
        translate the sentinel to None so the dashboard renders it as
        a blank cell, not the literal string '-'."""
        line = ("[1/3] kind=trigger pass=False fixture_id=q0 run=1 "
                "elapsed=12.0s retries=0 timeout_reason=none "
                "first_tool=- first_skill=- failed_asserts=0"
                ": text-only response, no tools")
        rows = monitor._parse_progress_rows(line)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["first_tool"])
        self.assertIsNone(rows[0]["first_skill"])


class TestRegexByteEquivalenceWithRunner(unittest.TestCase):
    """The runner emits canonical lines via its own regex constants; the
    monitor parses them via duplicate constants. The two pattern strings
    must stay byte-identical -- if they drift, the runner can emit lines
    the monitor can't read, and the dashboard silently goes blank."""

    def test_progress_line_pattern_matches_runner(self):
        self.assertEqual(
            monitor.PROGRESS_LINE_RE.pattern,
            _eval_runner.PROGRESS_LINE_RE.pattern,
        )

    def test_progress_line_flags_match_runner(self):
        self.assertEqual(
            monitor.PROGRESS_LINE_RE.flags,
            _eval_runner.PROGRESS_LINE_RE.flags,
        )

    def test_startup_banner_pattern_matches_runner(self):
        self.assertEqual(
            monitor.STARTUP_BANNER_RE.pattern,
            _eval_runner.STARTUP_BANNER_RE.pattern,
        )

    def test_startup_banner_flags_match_runner(self):
        self.assertEqual(
            monitor.STARTUP_BANNER_RE.flags,
            _eval_runner.STARTUP_BANNER_RE.flags,
        )


class TestStartupBannerParser(unittest.TestCase):
    """The monitor parses the runner's startup banner from .output
    files to bind finished runs to (skill, kind)."""

    def test_banner_parsed_from_output_file(self):
        with tempfile.TemporaryDirectory() as td:
            tasks_dir = Path(td) / "tasks"
            tasks_dir.mkdir()
            output = tasks_dir / "abc.output"
            output.write_text(
                "=== eval starting: kind=synthesis "
                "skill=dsc-scrape "
                "eval=evals/dsc-scrape/synthesis-eval.json "
                "runs=5 workers=4 total_fixtures=2 ===\n"
                "[1/10] kind=synthesis pass=True fixture_id=mcg-citation-leak "
                "run=1 elapsed=42.1s retries=0 timeout_reason=none "
                "first_tool=Skill first_skill=dsc-scrape failed_asserts=0"
                ": find MCG\n"
            )
            binding = monitor.parse_banner_from_output(str(output))
            self.assertIsNotNone(binding)
            self.assertEqual(binding["kind"], "synthesis")
            self.assertEqual(binding["skill"], "dsc-scrape")
            self.assertEqual(binding["total_fixtures"], 2)

    def test_no_banner_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "no-banner.output"
            output.write_text("just some unrelated text\n")
            self.assertIsNone(monitor.parse_banner_from_output(str(output)))

    def test_banner_shaped_substring_does_not_match(self):
        """A banner-shaped substring embedded inside a longer line (e.g.
        printed by a subagent's stdout, a copy-pasted prompt, or a test
        fixture) must NOT bind a phantom skill row. Real eval banners
        always start at column 0; tightening the regex closes this
        false-positive class."""
        line_with_embedded = (
            'subagent_output: "look at this output: '
            '=== eval starting: kind=trigger skill=dsc-other '
            'eval=evals/dsc-other/trigger-eval.json '
            'runs=3 workers=4 total_fixtures=10 ===" -- end\n'
        )
        m = monitor.STARTUP_BANNER_RE.search(line_with_embedded)
        self.assertIsNone(
            m,
            "embedded banner-shaped substring should not match; got: "
            f"{m.groupdict() if m else None!r}",
        )

    def test_live_progress_synthesizes_zero_done_before_first_row(self):
        """find_progress_for_skill must return done=0/total=expected
        when the file is banner-bound but no rows have arrived yet --
        so serialize_state renders `0/N (0%)` instead of `?`."""
        with tempfile.TemporaryDirectory() as td:
            tasks_dir = Path(td) / "tasks"
            tasks_dir.mkdir()
            output = tasks_dir / "live.output"
            output.write_text(
                "=== eval starting: kind=trigger "
                "skill=dsc-triage "
                "eval=evals/dsc-triage/trigger-eval.json "
                "runs=3 workers=4 total_fixtures=23 ===\n"
            )
            with mock.patch.object(monitor, "discover_task_dirs",
                                   return_value=[tasks_dir]):
                progress = monitor.find_progress_for_skill(
                    "dsc-triage", "trigger", expected_total=69)
            self.assertIsNotNone(progress)
            self.assertEqual(progress["done"], 0)
            self.assertEqual(progress["total"], 69)
            self.assertEqual(progress["task_file"], str(output))

    def test_live_run_binds_via_banner_before_first_row(self):
        """A freshly-started live run emits its banner immediately but
        the first progress row may not arrive for several minutes (long
        per-fixture wall time). The dashboard must bind (skill, kind) to
        the .output file from the banner alone, so the user sees progress
        0/N rather than `?` while the first row is in flight."""
        with tempfile.TemporaryDirectory() as td:
            tasks_dir = Path(td) / "tasks"
            tasks_dir.mkdir()
            output = tasks_dir / "live.output"
            output.write_text(
                "=== eval starting: kind=trigger "
                "skill=dsc-triage "
                "eval=evals/dsc-triage/trigger-eval.json "
                "runs=3 workers=4 total_fixtures=23 ===\n"
            )
            with mock.patch.object(monitor, "discover_task_dirs",
                                   return_value=[tasks_dir]):
                tf, rows = monitor.find_skill_task_file(
                    "dsc-triage", "trigger")
            self.assertEqual(tf, output,
                             "banner-only .output should bind even with no rows")
            self.assertEqual(rows, [])

    def test_banner_at_column_zero_still_matches(self):
        """Sanity check: real banners (column 0, possibly with trailing
        text) must still match after tightening."""
        line = (
            "=== eval starting: kind=synthesis skill=dsc-scrape "
            "eval=evals/dsc-scrape/synthesis-eval.json "
            "runs=5 workers=4 total_fixtures=2 ===\n"
        )
        m = monitor.STARTUP_BANNER_RE.search(line)
        self.assertIsNotNone(m)
        self.assertEqual(m.group("skill"), "dsc-scrape")


class TestSerializeStateSegments(unittest.TestCase):
    """The segmented progress bar distinguishes four states: pass, fail,
    in-flight (worker currently processing this cell), and pending. The
    in-flight count is approximated by the number of active subprocs --
    workers don't process slots strictly in order, but the user's actual
    question ("is anything happening right now?") is answered correctly
    regardless of exact slot mapping."""

    def _row(self, n, pass_):
        return {
            "n": n, "total": 10, "kind": "trigger", "pass_": pass_,
            "fixture_id": f"q{n}", "run": 1, "elapsed": 1.0, "retries": 0,
            "timeout_reason": "none", "first_tool": "Skill",
            "first_skill": "dsc-fake", "failed_asserts": 0,
            "query": "x",
        }

    def _active_record(self):
        return {"claude_pid": 1, "worker_pid": 2, "runtime_s": 0,
                "total_retries": 0, "latest_attempt": 0,
                "max_retries_field": 0, "last_error": None,
                "size_bytes": 0}

    def _skill(self, *, all_rows, active_subprocs, expected_total=10):
        return {
            "skill": "dsc-fake", "kind": "trigger", "python_pid": 999,
            "live": True,
            "active": [self._active_record() for _ in range(active_subprocs)],
            "recent": all_rows[-5:], "all_rows": all_rows,
            "progress": {"done": len(all_rows), "total": expected_total,
                         "task_file": "x"},
            "expected_total_runs": expected_total,
            "active_subprocs": active_subprocs, "in_flight_retries": 0,
        }

    def _serialize(self, skill):
        with mock.patch.object(monitor, "gather_state",
                               return_value=[skill]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            return monitor.serialize_state()

    def test_in_flight_segments_follow_done(self):
        """3 done + 4 active workers + 10 total = 3 pass/fail, 4 in-flight,
        3 pending."""
        rows = [self._row(1, True), self._row(2, True), self._row(3, False)]
        out = self._serialize(self._skill(all_rows=rows, active_subprocs=4))
        self.assertEqual(out["skills"][0]["seg_classes"],
                         ["pass", "pass", "fail",
                          "in-flight", "in-flight", "in-flight", "in-flight",
                          "pending", "pending", "pending"])

    def test_in_flight_capped_at_remaining_slots(self):
        """If done + active_subprocs would exceed total, in-flight cells
        only fill the remaining slots; we never emit more than total
        segments."""
        rows = [self._row(i, True) for i in range(1, 9)]  # 8 done
        out = self._serialize(self._skill(all_rows=rows, active_subprocs=4))
        self.assertEqual(out["skills"][0]["seg_classes"],
                         ["pass"] * 8 + ["in-flight", "in-flight"])

    def test_no_in_flight_segments_when_no_active_subprocs(self):
        """Finished runs (live=False, active_subprocs=0) render with no
        in-flight cells -- the bar should stay readable as
        pass/fail/pending only."""
        rows = [self._row(1, True), self._row(2, False)]
        out = self._serialize(self._skill(all_rows=rows, active_subprocs=0))
        self.assertEqual(out["skills"][0]["seg_classes"],
                         ["pass", "fail"] + ["pending"] * 8)

    def test_in_flight_at_run_start(self):
        """0 done + 4 active = first 4 cells in-flight, rest pending."""
        out = self._serialize(self._skill(all_rows=[], active_subprocs=4))
        self.assertEqual(out["skills"][0]["seg_classes"],
                         ["in-flight"] * 4 + ["pending"] * 6)


class TestSerializeStateProgressLabel(unittest.TestCase):
    """The dashboard's progress label is `N/M (P%)` -- the percentage is
    the at-a-glance signal users actually need; raw `N/M` requires mental
    arithmetic. Computed server-side so the front end stays a dumb
    renderer."""

    def _fake_skill(self, done, total):
        return {
            "skill": "dsc-fake", "kind": "trigger", "python_pid": 999,
            "live": True, "active": [], "recent": [], "all_rows": [],
            "progress": {"done": done, "total": total, "task_file": "x"},
            "expected_total_runs": total,
            "active_subprocs": 0, "in_flight_retries": 0,
        }

    def test_progress_label_includes_percentage(self):
        with mock.patch.object(monitor, "gather_state",
                               return_value=[self._fake_skill(34, 69)]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            out = monitor.serialize_state()
        self.assertEqual(out["skills"][0]["progress_str"], "34/69 (49%)")

    def test_progress_label_at_zero_is_zero_percent(self):
        with mock.patch.object(monitor, "gather_state",
                               return_value=[self._fake_skill(0, 69)]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            out = monitor.serialize_state()
        self.assertEqual(out["skills"][0]["progress_str"], "0/69 (0%)")

    def test_progress_label_at_completion_is_100_percent(self):
        with mock.patch.object(monitor, "gather_state",
                               return_value=[self._fake_skill(69, 69)]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            out = monitor.serialize_state()
        self.assertEqual(out["skills"][0]["progress_str"], "69/69 (100%)")

    def test_progress_label_unknown_when_total_missing(self):
        """When the eval file can't be read, total is None and we render
        `?` -- no percentage to compute."""
        skill = self._fake_skill(0, 0)
        skill["progress"] = None
        skill["expected_total_runs"] = None
        with mock.patch.object(monitor, "gather_state",
                               return_value=[skill]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            out = monitor.serialize_state()
        self.assertEqual(out["skills"][0]["progress_str"], "?")


class TestComputeRuntimeSeverity(unittest.TestCase):
    """compute_runtime_severity bands the elapsed/timeout ratio into four
    buckets so the dashboard can color the RUNTIME column. The bands are
    coarse on purpose -- the user reads it as "is this run going to
    wall-clock soon" not "what's the exact ratio."

    Bands:
      green   : ratio < 0.60   (or timeout unknown)
      yellow  : 0.60 <= ratio < 0.80
      orange  : 0.80 <= ratio < 0.95
      red     : ratio >= 0.95
    """

    def test_green_under_60_percent(self):
        self.assertEqual(monitor.compute_runtime_severity(60, 240), "green")
        self.assertEqual(monitor.compute_runtime_severity(0, 240), "green")
        # Just under the yellow threshold.
        self.assertEqual(monitor.compute_runtime_severity(143, 240), "green")

    def test_yellow_at_60_percent_boundary(self):
        # Exactly 60% of timeout -> yellow.
        self.assertEqual(monitor.compute_runtime_severity(144, 240), "yellow")
        self.assertEqual(monitor.compute_runtime_severity(180, 240), "yellow")
        # Just under the orange threshold.
        self.assertEqual(monitor.compute_runtime_severity(191, 240), "yellow")

    def test_orange_at_80_percent_boundary(self):
        # Exactly 80% of timeout -> orange.
        self.assertEqual(monitor.compute_runtime_severity(192, 240), "orange")
        self.assertEqual(monitor.compute_runtime_severity(220, 240), "orange")
        # Just under the red threshold (95% of 240 = 228).
        self.assertEqual(monitor.compute_runtime_severity(227, 240), "orange")

    def test_red_at_95_percent_boundary(self):
        # Exactly 95% of timeout -> red.
        self.assertEqual(monitor.compute_runtime_severity(228, 240), "red")
        # At 100% -> red.
        self.assertEqual(monitor.compute_runtime_severity(240, 240), "red")
        # Past timeout (run hasn't been reaped yet) -> still red.
        self.assertEqual(monitor.compute_runtime_severity(300, 240), "red")

    def test_unknown_timeout_returns_green(self):
        """timeout=None means we couldn't parse --timeout from the
        command line. Don't render a misleading color -- default to
        green so the cell renders unchanged from pre-feature behavior."""
        self.assertEqual(monitor.compute_runtime_severity(120, None), "green")
        self.assertEqual(monitor.compute_runtime_severity(99999, None), "green")

    def test_zero_timeout_returns_green(self):
        """timeout=0 is the sentinel for "no wall clock cutoff
        configured" -- arithmetic-defensive, also wouldn't make sense to
        color. Treat the same as unknown."""
        self.assertEqual(monitor.compute_runtime_severity(120, 0), "green")

    def test_negative_timeout_returns_green(self):
        """Defensive: a misparse that returned a negative value shouldn't
        surface as red because of the resulting negative ratio."""
        self.assertEqual(monitor.compute_runtime_severity(120, -1), "green")

    def test_zero_elapsed_returns_green(self):
        """A run that just started has elapsed near 0 -- green."""
        self.assertEqual(monitor.compute_runtime_severity(0, 240), "green")

    def test_negative_elapsed_treated_as_zero(self):
        """Defensive: clock skew or a parse glitch shouldn't poison the
        color -- treat as 0 elapsed (green)."""
        self.assertEqual(monitor.compute_runtime_severity(-5, 240), "green")

    def test_elapsed_none_treated_as_zero(self):
        """proc_runtime_s can return None when ps doesn't know the pid;
        callers may forward None directly. Coalesce to 0/green."""
        self.assertEqual(monitor.compute_runtime_severity(None, 240), "green")


class TestSerializeStateRuntimeSeverity(unittest.TestCase):
    """serialize_state must surface runtime_severity per active record so
    the front end can class= the runtime cell."""

    def _skill(self, *, runtime_s, timeout_s):
        active = {"claude_pid": 1, "worker_pid": 2, "runtime_s": runtime_s,
                  "timeout_s": timeout_s,
                  "total_retries": 0, "latest_attempt": 0,
                  "max_retries_field": 0, "last_error": None,
                  "size_bytes": 0}
        return {
            "skill": "dsc-fake", "kind": "trigger", "python_pid": 999,
            "live": True,
            "active": [active],
            "recent": [], "all_rows": [],
            "progress": {"done": 0, "total": 10, "task_file": "x"},
            "expected_total_runs": 10,
            "active_subprocs": 1, "in_flight_retries": 0,
            "timeout_s": timeout_s,
        }

    def _serialize(self, skill):
        with mock.patch.object(monitor, "gather_state",
                               return_value=[skill]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            return monitor.serialize_state()

    def test_orange_at_80_seconds_with_240_timeout(self):
        """Spec example: 80s elapsed of a 100s timeout = 80% -> orange.
        (Original brief used different numbers but the principle holds:
        verify the ratio, not the absolute seconds.)"""
        out = self._serialize(self._skill(runtime_s=80, timeout_s=100))
        self.assertEqual(out["skills"][0]["active"][0]["runtime_severity"],
                         "orange")

    def test_green_at_low_ratio(self):
        out = self._serialize(self._skill(runtime_s=30, timeout_s=240))
        self.assertEqual(out["skills"][0]["active"][0]["runtime_severity"],
                         "green")

    def test_red_near_timeout(self):
        out = self._serialize(self._skill(runtime_s=235, timeout_s=240))
        self.assertEqual(out["skills"][0]["active"][0]["runtime_severity"],
                         "red")

    def test_unknown_timeout_renders_green(self):
        """No --timeout in the command line -> timeout_s=None -> the
        cell renders without any extra color class."""
        out = self._serialize(self._skill(runtime_s=120, timeout_s=None))
        self.assertEqual(out["skills"][0]["active"][0]["runtime_severity"],
                         "green")


class TestFindEvalPythons(unittest.TestCase):
    """find_eval_pythons must recognize both trigger-eval.py and
    synthesis-eval.py workers, populating `kind` correctly."""

    def test_recognizes_trigger_eval(self):
        ps_output = (
            "  12345 /usr/bin/python3 tools/trigger-eval.py "
            "--eval evals/dsc-triage/trigger-eval.json "
            "--skill-name dsc-triage --runs 3\n"
        )
        with mock.patch.object(monitor, "run", return_value=ps_output):
            results = monitor.find_eval_pythons()
        self.assertEqual(len(results), 1)
        pid, kind, skill, eval_path, timeout_s = results[0]
        self.assertEqual(pid, 12345)
        self.assertEqual(kind, "trigger")
        self.assertEqual(skill, "dsc-triage")
        self.assertIsNone(timeout_s)

    def test_recognizes_synthesis_eval(self):
        ps_output = (
            "  67890 /usr/bin/python3 tools/synthesis-eval.py "
            "--eval evals/dsc-scrape/synthesis-eval.json --runs 5\n"
        )
        with mock.patch.object(monitor, "run", return_value=ps_output):
            results = monitor.find_eval_pythons()
        self.assertEqual(len(results), 1)
        pid, kind, skill, eval_path, timeout_s = results[0]
        self.assertEqual(pid, 67890)
        self.assertEqual(kind, "synthesis")
        self.assertEqual(skill, "dsc-scrape")
        self.assertIsNone(timeout_s)

    def test_recognizes_both_in_parallel(self):
        ps_output = (
            "  11111 /usr/bin/python3 tools/trigger-eval.py "
            "--eval evals/dsc-scrape/trigger-eval.json "
            "--skill-name dsc-scrape --runs 3\n"
            "  22222 /usr/bin/python3 tools/synthesis-eval.py "
            "--eval evals/dsc-scrape/synthesis-eval.json --runs 5\n"
        )
        with mock.patch.object(monitor, "run", return_value=ps_output):
            results = monitor.find_eval_pythons()
        kinds = sorted(r[1] for r in results)
        self.assertEqual(kinds, ["synthesis", "trigger"])

    def test_extracts_timeout_arg_when_present(self):
        """--timeout N is plumbed through so the dashboard can color the
        RUNTIME column by elapsed/timeout proximity."""
        ps_output = (
            "  33333 /usr/bin/python3 tools/synthesis-eval.py "
            "--eval evals/dsc-endpoint-help/synthesis-eval.json "
            "--runs 5 --workers 2 --timeout 600 --out x.json\n"
        )
        with mock.patch.object(monitor, "run", return_value=ps_output):
            results = monitor.find_eval_pythons()
        self.assertEqual(len(results), 1)
        _pid, _kind, _skill, _eval, timeout_s = results[0]
        self.assertEqual(timeout_s, 600)


class TestParseTranscriptFilename(unittest.TestCase):
    """parse_transcript_filename splits `<basename>.jsonl` into
    (fixture_id, run_idx). The harness writes
    `<transcript_dir>/<fixture_id>-<run_idx>.jsonl`, and the regex must
    handle fixture-ids that themselves contain trailing digits -- e.g.
    `fixture-name-with-2-words-3.jsonl` parses as
    fixture_id=`fixture-name-with-2-words` (NOT
    `fixture-name-with-2`), run=3."""

    def test_simple_filename(self):
        self.assertEqual(
            monitor.parse_transcript_filename("q12-1.jsonl"),
            ("q12", 1),
        )

    def test_two_digit_run(self):
        self.assertEqual(
            monitor.parse_transcript_filename("synth-fixture-15.jsonl"),
            ("synth-fixture", 15),
        )

    def test_fixture_with_trailing_digits(self):
        """Fixture ids may contain trailing digits. Anchoring on the
        last `-<digits>.jsonl` extracts the run idx correctly without
        eating the fixture's own numbers."""
        self.assertEqual(
            monitor.parse_transcript_filename(
                "fixture-name-with-2-words-3.jsonl"),
            ("fixture-name-with-2-words", 3),
        )

    def test_multi_word_fixture_with_run(self):
        self.assertEqual(
            monitor.parse_transcript_filename(
                "synthesis-diff-content-type-415-5.jsonl"),
            ("synthesis-diff-content-type-415", 5),
        )

    def test_returns_none_for_non_jsonl(self):
        """trigger-eval tempfiles are `tmpXXXX.json` (no -<digit>, .json
        not .jsonl). They must NOT match -- the active record falls
        back to fixture_id=None."""
        self.assertIsNone(monitor.parse_transcript_filename("tmpfoo.json"))
        self.assertIsNone(
            monitor.parse_transcript_filename("results.json"))

    def test_returns_none_for_filename_without_run_idx(self):
        """`fixture.jsonl` without a `-<digit>` suffix can't be split."""
        self.assertIsNone(monitor.parse_transcript_filename("fixture.jsonl"))

    def test_returns_none_for_empty(self):
        self.assertIsNone(monitor.parse_transcript_filename(""))
        self.assertIsNone(monitor.parse_transcript_filename(None))


class TestFindActiveTranscriptInfo(unittest.TestCase):
    """find_active_transcript_info inspects a worker pid's open files
    via lsof and returns (fixture_id, run, transcript_path) when one of
    them matches the harness's `*/transcripts/<out-stem>/<basename>.jsonl`
    layout. Returns None gracefully when the worker hasn't opened the
    transcript yet, when it's a trigger-eval tempfile, or when lsof
    fails."""

    def test_resolves_fixture_id_and_run_from_lsof(self):
        """A typical synthesis-eval worker holds a transcript open at
        `<eval-dir>/runs/<iter>/transcripts/<stem>/<fixture>-<run>.jsonl`.
        The fd-walker should pick it up and extract both fields."""
        with tempfile.TemporaryDirectory() as td:
            transcript_dir = (Path(td) / "runs" / "iter-foo"
                              / "transcripts" / "synthesis-results")
            transcript_dir.mkdir(parents=True)
            transcript = transcript_dir / "fixture-name-3.jsonl"
            transcript.write_text("{}\n")
            # Mimic an lsof line that mentions the transcript path.
            fake_lsof = (
                f"python3 12345 user 5w REG 1,4 0 0 {transcript}\n"
                f"python3 12345 user 1u REG 1,4 0 0 /dev/null\n"
            )
            with mock.patch.object(monitor, "run", return_value=fake_lsof):
                info = monitor.find_active_transcript_info(12345)
            self.assertIsNotNone(info)
            self.assertEqual(info["fixture_id"], "fixture-name")
            self.assertEqual(info["run"], 3)
            self.assertEqual(info["transcript_path"], str(transcript))

    def test_returns_none_when_no_transcript_open(self):
        """Worker just spawned, no transcript fd yet. lsof shows other
        files but no `*/transcripts/...jsonl`. Must return None so
        callers degrade to (starting)."""
        fake_lsof = (
            "python3 12345 user cwd DIR 1,4 0 0 /tmp\n"
            "python3 12345 user txt REG 1,4 0 0 /usr/bin/python3\n"
        )
        with mock.patch.object(monitor, "run", return_value=fake_lsof):
            self.assertIsNone(monitor.find_active_transcript_info(12345))

    def test_returns_none_for_trigger_eval_tempfile(self):
        """trigger-eval workers write to `/private/var/folders/.../tmpXXX.json`
        -- not under `transcripts/<stem>/`. Must NOT match."""
        fake_lsof = (
            "python3 12345 user 5w REG 1,4 0 0 "
            "/private/var/folders/abc/T/tmpXYZ.json\n"
        )
        with mock.patch.object(monitor, "run", return_value=fake_lsof):
            self.assertIsNone(monitor.find_active_transcript_info(12345))

    def test_returns_none_when_lsof_fails(self):
        """If lsof raises (binary missing, permission denied), we
        return None instead of crashing the dashboard."""
        with mock.patch.object(monitor, "run",
                               side_effect=Exception("lsof failed")):
            self.assertIsNone(monitor.find_active_transcript_info(12345))

    def test_returns_none_for_empty_pid(self):
        self.assertIsNone(monitor.find_active_transcript_info(None))
        self.assertIsNone(monitor.find_active_transcript_info(0))

    def test_picks_most_recently_modified_when_multiple(self):
        """Defensive: if a worker somehow holds two matching transcript
        files open, we pick the more recently modified one."""
        with tempfile.TemporaryDirectory() as td:
            tdir = Path(td) / "transcripts" / "stem"
            tdir.mkdir(parents=True)
            older = tdir / "fixture-a-1.jsonl"
            newer = tdir / "fixture-b-2.jsonl"
            older.write_text("{}\n")
            newer.write_text("{}\n")
            os.utime(older, (1_000_000_000, 1_000_000_000))
            os.utime(newer, (1_000_000_999, 1_000_000_999))
            fake_lsof = (
                f"python3 12345 user 5w REG 1,4 0 0 {older}\n"
                f"python3 12345 user 6w REG 1,4 0 0 {newer}\n"
            )
            with mock.patch.object(monitor, "run", return_value=fake_lsof):
                info = monitor.find_active_transcript_info(12345)
            self.assertEqual(info["fixture_id"], "fixture-b")
            self.assertEqual(info["run"], 2)


class TestSerializeStateActiveFixtureId(unittest.TestCase):
    """serialize_state must surface fixture_id, run, and transcript_path
    on each active record so the dashboard can render fixture/run as
    visible columns and link the fixture cell to the on-disk JSONL."""

    def _skill(self, *, fixture_id, run, transcript_path):
        active = {
            "claude_pid": 1, "worker_pid": 2, "runtime_s": 5,
            "timeout_s": 240,
            "total_retries": 0, "latest_attempt": 0,
            "max_retries_field": 0, "last_error": None,
            "size_bytes": 0,
            "fixture_id": fixture_id,
            "run": run,
            "transcript_path": transcript_path,
        }
        return {
            "skill": "dsc-fake", "kind": "synthesis", "python_pid": 999,
            "live": True,
            "active": [active],
            "recent": [], "all_rows": [],
            "progress": {"done": 0, "total": 10, "task_file": "x"},
            "expected_total_runs": 10,
            "active_subprocs": 1, "in_flight_retries": 0,
            "timeout_s": 240,
        }

    def _serialize(self, skill):
        with mock.patch.object(monitor, "gather_state",
                               return_value=[skill]), \
             mock.patch.object(monitor, "discover_session",
                               return_value={"uuid": None, "name": None,
                                             "source": None,
                                             "tasks_dir": None}):
            return monitor.serialize_state()

    def test_active_record_carries_fixture_id_when_resolved(self):
        out = self._serialize(self._skill(
            fixture_id="my-fixture",
            run=3,
            transcript_path="/path/to/my-fixture-3.jsonl",
        ))
        active = out["skills"][0]["active"][0]
        self.assertEqual(active["fixture_id"], "my-fixture")
        self.assertEqual(active["run"], 3)
        self.assertEqual(active["transcript_path"],
                         "/path/to/my-fixture-3.jsonl")

    def test_active_record_carries_none_when_not_resolved(self):
        """Worker just spawned, no transcript fd yet. The serialized
        record must carry None values so the front end renders em-dash
        placeholders without crashing."""
        out = self._serialize(self._skill(
            fixture_id=None, run=None, transcript_path=None,
        ))
        active = out["skills"][0]["active"][0]
        self.assertIsNone(active["fixture_id"])
        self.assertIsNone(active["run"])
        self.assertIsNone(active["transcript_path"])


if __name__ == "__main__":
    unittest.main()
