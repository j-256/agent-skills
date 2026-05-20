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
        pid, kind, skill, eval_path = results[0]
        self.assertEqual(pid, 12345)
        self.assertEqual(kind, "trigger")
        self.assertEqual(skill, "dsc-triage")

    def test_recognizes_synthesis_eval(self):
        ps_output = (
            "  67890 /usr/bin/python3 tools/synthesis-eval.py "
            "--eval evals/dsc-scrape/synthesis-eval.json --runs 5\n"
        )
        with mock.patch.object(monitor, "run", return_value=ps_output):
            results = monitor.find_eval_pythons()
        self.assertEqual(len(results), 1)
        pid, kind, skill, eval_path = results[0]
        self.assertEqual(pid, 67890)
        self.assertEqual(kind, "synthesis")
        self.assertEqual(skill, "dsc-scrape")

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


if __name__ == "__main__":
    unittest.main()
