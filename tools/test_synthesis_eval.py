"""Unit tests for tools/synthesis-eval.py.

Run with: python3 -m unittest tools.test_synthesis_eval
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

# Make tools/ importable as a package; the script's dashed name needs a hop.
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "synthesis_eval", THIS_DIR / "synthesis-eval.py"
)
synthesis_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(synthesis_eval)

import _retry_aware_subprocess  # noqa: E402

FIXTURE_PATH = THIS_DIR / "fixtures" / "mcg-walk.jsonl"


class TestParseTranscript(unittest.TestCase):
    def test_extracts_tool_uses_in_order(self):
        parsed = synthesis_eval.parse_transcript(FIXTURE_PATH)

        self.assertEqual(len(parsed.tool_uses), 14)
        self.assertEqual(parsed.tool_uses[0].name, "Skill")
        self.assertEqual(parsed.tool_uses[0].input.get("skill"), "dsc-scrape")
        self.assertEqual(parsed.tool_uses[1].name, "Bash")
        self.assertIn("/docs/apis", parsed.tool_uses[1].input.get("command", ""))
        self.assertEqual(parsed.tool_uses[3].name, "Read")
        self.assertIn("aliases.js", parsed.tool_uses[3].input.get("file_path", ""))

    def test_extracts_final_text(self):
        parsed = synthesis_eval.parse_transcript(FIXTURE_PATH)

        self.assertIsNotNone(parsed.final_text)
        self.assertIn(
            "developer.salesforce.com/docs/marketing/marketing-cloud-growth",
            parsed.final_text,
        )
        self.assertNotIn("~/.cache/", parsed.final_text)


class TestEvaluateAssertion(unittest.TestCase):
    def setUp(self):
        self.parsed = synthesis_eval.parse_transcript(FIXTURE_PATH)

    def test_final_text_matches_pass(self):
        a = {"kind": "final_text_matches",
             "pattern": r"developer\.salesforce\.com/.+marketing-cloud-growth",
             "because": "must cite MCG URL"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertTrue(result.pass_)
        self.assertEqual(result.because, "must cite MCG URL")

    def test_final_text_matches_fail(self):
        a = {"kind": "final_text_matches",
             "pattern": r"this string is definitely not in the answer",
             "because": "test"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertFalse(result.pass_)

    def test_final_text_excludes_pass(self):
        a = {"kind": "final_text_excludes", "pattern": r"~/\.cache/",
             "because": "citation-leak guard"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertTrue(result.pass_)

    def test_final_text_excludes_fail(self):
        a = {"kind": "final_text_excludes",
             "pattern": r"developer\.salesforce\.com",
             "because": "test — would falsely flag the real answer"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertFalse(result.pass_)

    def test_missing_final_text_fails_loudly(self):
        empty = synthesis_eval.ParsedTranscript()
        a = {"kind": "final_text_matches", "pattern": r".",
             "because": "test"}
        result = synthesis_eval.evaluate_assertion(a, empty)
        self.assertFalse(result.pass_)
        self.assertIn("no final answer recorded", result.message)

    def test_tool_input_matches_bash_command_pass(self):
        a = {"kind": "tool_input_matches", "tool": "Bash",
             "field": "command", "pattern": r"marketing-cloud-growth",
             "because": "MCG URL must be scraped"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertTrue(result.pass_)

    def test_tool_input_matches_bash_command_fail(self):
        a = {"kind": "tool_input_matches", "tool": "Bash",
             "field": "command", "pattern": r"this-domain-not-scraped",
             "because": "test"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertFalse(result.pass_)

    def test_tool_input_matches_wrong_tool_fails(self):
        a = {"kind": "tool_input_matches", "tool": "WebFetch",
             "field": "url", "pattern": r".",
             "because": "test – no WebFetch in MCG transcript"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertFalse(result.pass_)

    def test_tool_sequence_includes_pass(self):
        a = {"kind": "tool_sequence_includes",
             "pattern": r"Skill\nBash\nRead\nRead",
             "because": "cascade order: Skill -> catalog scrape -> _catalog -> aliases"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertTrue(result.pass_)

    def test_tool_sequence_includes_fail(self):
        a = {"kind": "tool_sequence_includes",
             "pattern": r"WebFetch\nWebFetch",
             "because": "test – no WebFetch"}
        result = synthesis_eval.evaluate_assertion(a, self.parsed)
        self.assertFalse(result.pass_)


class TestValidateFixtures(unittest.TestCase):
    def test_valid_fixtures_pass(self):
        fixtures = [{
            "name": "ok",
            "query": "anything",
            "assertions": [
                {"kind": "final_text_matches", "pattern": ".", "because": "x"}
            ],
        }]
        synthesis_eval.validate_fixtures(fixtures)  # should not raise

    def test_missing_name_raises(self):
        fixtures = [{"query": "x", "assertions": []}]
        with self.assertRaises(synthesis_eval.FixtureSchemaError):
            synthesis_eval.validate_fixtures(fixtures)

    def test_missing_query_raises(self):
        fixtures = [{"name": "x", "assertions": []}]
        with self.assertRaises(synthesis_eval.FixtureSchemaError):
            synthesis_eval.validate_fixtures(fixtures)

    def test_unknown_kind_raises(self):
        fixtures = [{
            "name": "x", "query": "x",
            "assertions": [{"kind": "made_up", "because": "x"}],
        }]
        with self.assertRaises(synthesis_eval.FixtureSchemaError):
            synthesis_eval.validate_fixtures(fixtures)

    def test_assertion_missing_pattern_raises(self):
        fixtures = [{
            "name": "x", "query": "x",
            "assertions": [{"kind": "final_text_matches", "because": "x"}],
        }]
        with self.assertRaises(synthesis_eval.FixtureSchemaError):
            synthesis_eval.validate_fixtures(fixtures)

    def test_duplicate_names_raise(self):
        fixtures = [
            {"name": "dup", "query": "x", "assertions": []},
            {"name": "dup", "query": "y", "assertions": []},
        ]
        with self.assertRaises(synthesis_eval.FixtureSchemaError):
            synthesis_eval.validate_fixtures(fixtures)


class TestTranscriptDirFor(unittest.TestCase):
    def test_namespaces_by_out_stem(self):
        cold = synthesis_eval.transcript_dir_for(
            Path("/tmp/iter-x/results-cold.json")
        )
        warm = synthesis_eval.transcript_dir_for(
            Path("/tmp/iter-x/results-warm.json")
        )
        self.assertEqual(cold, Path("/tmp/iter-x/transcripts/results-cold"))
        self.assertEqual(warm, Path("/tmp/iter-x/transcripts/results-warm"))
        self.assertNotEqual(cold, warm)


class TestRunFixtureOnce(unittest.TestCase):
    def test_uses_pinned_transcript_via_mock(self):
        """run_fixture_once with a mocked subprocess: copy fixture transcript
        to the run's transcript_path, then verify parsing + assertion."""
        fixture = {
            "name": "smoke",
            "query": "any",
            "expected_skill": "dsc-scrape",
            "assertions": [
                {"kind": "final_text_matches",
                 "pattern": r"developer\.salesforce\.com",
                 "because": "must cite DSC"}
            ],
        }
        with tempfile.TemporaryDirectory() as td:
            transcript_dir = Path(td) / "transcripts"

            def fake_popen(cmd, stdout, stderr, env, cwd):
                # Mimic claude -p writing the transcript: copy the fixture
                # in immediately, then exit. The bail-aware helper polls
                # poll() to detect exit and reads the file when it sees
                # not-None.
                target = Path(stdout.name)
                shutil.copyfile(FIXTURE_PATH, target)
                m = mock.MagicMock()
                m.poll.return_value = 0
                m.returncode = 0
                m.wait.return_value = 0
                return m

            # Patch the helper module's subprocess (where Popen is now
            # called from) instead of synthesis_eval's.
            with mock.patch.object(_retry_aware_subprocess.subprocess,
                                   "Popen", side_effect=fake_popen):
                result = synthesis_eval.run_fixture_once(
                    fixture, timeout=60, cwd=td,
                    transcript_dir=transcript_dir, run_idx=1,
                )

        self.assertTrue(result["pass"])
        self.assertEqual(result["first_skill"], "dsc-scrape")
        self.assertTrue(result["expected_skill_pass"])
        self.assertTrue(all(r["pass"] for r in result["assertion_results"]))

    def test_timeout_sets_timed_out_flag(self):
        """A wall-clock timeout sets timed_out=True and pass=False; main()
        relies on that flag to abort the eval. See exit-code-3 docs in
        CLAUDE.md."""
        fixture = {
            "name": "timeout-smoke",
            "query": "any",
            "assertions": [
                {"kind": "final_text_matches", "pattern": r".",
                 "because": "any"}
            ],
        }
        with tempfile.TemporaryDirectory() as td:
            transcript_dir = Path(td) / "transcripts"

            def fake_popen(cmd, stdout, stderr, env, cwd):
                # poll() always returns None -> process never exits.
                # The bail-aware helper times out via its wall clock.
                m = mock.MagicMock()
                m.poll.return_value = None
                m.wait.return_value = 0
                return m

            t = [0.0]
            def fake_time():
                return t[0]
            def fake_sleep_impl(_):
                t[0] += 100  # advance fast

            with mock.patch.object(_retry_aware_subprocess.subprocess,
                                   "Popen", side_effect=fake_popen), \
                 mock.patch.object(_retry_aware_subprocess.time, "sleep",
                                   side_effect=fake_sleep_impl), \
                 mock.patch.object(_retry_aware_subprocess.time, "time",
                                   side_effect=fake_time):
                result = synthesis_eval.run_fixture_once(
                    fixture, timeout=1, cwd=td,
                    transcript_dir=transcript_dir, run_idx=1,
                )

        self.assertTrue(result["timed_out"])
        self.assertFalse(result["pass"])
        self.assertFalse(result["retry_budget_exhausted"])

    def test_retry_budget_exhausted_sets_timed_out_and_flag(self):
        """When the CLI emits attempt == max_retries (gateway-poisoned
        signal), run_fixture_once aborts with timed_out=True AND sets
        retry_budget_exhausted=True so main() can name the cause."""
        fixture = {
            "name": "exhaustion-smoke",
            "query": "any",
            "assertions": [
                {"kind": "final_text_matches", "pattern": r".",
                 "because": "any"}
            ],
        }

        def fake_popen(cmd, stdout, stderr, env, cwd):
            # Write a fully-exhausted retry sequence (10 of 10) and never
            # exit. The bail-aware helper detects the retry budget being
            # exhausted on its first poll cycle.
            target = Path(stdout.name)
            with open(target, "w") as f:
                for i in range(1, 11):
                    f.write(json.dumps({
                        "type": "system", "subtype": "api_retry",
                        "attempt": i, "max_retries": 10,
                        "error": "rate_limit",
                    }) + "\n")
            m = mock.MagicMock()
            m.poll.return_value = None
            m.wait.return_value = 0
            return m

        with tempfile.TemporaryDirectory() as td:
            transcript_dir = Path(td) / "transcripts"
            with mock.patch.object(_retry_aware_subprocess.subprocess,
                                   "Popen", side_effect=fake_popen):
                result = synthesis_eval.run_fixture_once(
                    fixture, timeout=60, cwd=td,
                    transcript_dir=transcript_dir, run_idx=1,
                )

        self.assertTrue(result["timed_out"])
        self.assertTrue(result["retry_budget_exhausted"])
        self.assertFalse(result["pass"])


if __name__ == "__main__":
    unittest.main()
