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
                # Mimic claude -p writing the transcript: copy the fixture in.
                target = Path(stdout.name)
                shutil.copyfile(FIXTURE_PATH, target)
                m = mock.MagicMock()
                m.wait.return_value = 0
                return m

            with mock.patch.object(synthesis_eval.subprocess, "Popen",
                                   side_effect=fake_popen):
                result = synthesis_eval.run_fixture_once(
                    fixture, timeout=60, cwd=td,
                    transcript_dir=transcript_dir, run_idx=1,
                )

        self.assertTrue(result["pass"])
        self.assertEqual(result["first_skill"], "dsc-scrape")
        self.assertTrue(result["expected_skill_pass"])
        self.assertTrue(all(r["pass"] for r in result["assertion_results"]))


if __name__ == "__main__":
    unittest.main()
