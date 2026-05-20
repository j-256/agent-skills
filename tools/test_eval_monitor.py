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


if __name__ == "__main__":
    unittest.main()
