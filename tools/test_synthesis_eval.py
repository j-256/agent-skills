"""Unit tests for tools/synthesis-eval.py.

Run with: python3 -m unittest tools.test_synthesis_eval
"""
import json
import sys
import tempfile
import unittest
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


class TestScoreSynthesisRun(unittest.TestCase):
    """Replaces TestRunFixtureOnce.

    score_synthesis_run is the synthesis-eval scoring callback the
    runner invokes per (fixture, run). It receives a fixture, a
    transcript path, and the bail dict; returns (pass: bool, kind_extra:
    dict). The previous run_fixture_once shape (which spawned the
    subprocess) is now the runner's job."""

    def _write_transcript(self, td, lines):
        path = Path(td) / "fake-transcript.jsonl"
        path.write_text("".join(json.dumps(L) + "\n" for L in lines))
        return path

    def test_pass_when_expected_skill_matches_and_assertions_pass(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": "Skill",
                     "input": {"skill": "dsc-scrape"}},
                ]}},
                {"type": "result", "result": "the answer"},
            ])
            fixture = {
                "name": "happy", "query": "q",
                "expected_skill": "dsc-scrape",
                "assertions": [{"kind": "final_text_matches",
                                "pattern": "answer", "because": "..."}],
            }
            score_synthesis_run = synthesis_eval.score_synthesis_run
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_synthesis_run(fixture, str(transcript), bail)
            self.assertTrue(pass_)
            self.assertTrue(extra["expected_skill_pass"])
            self.assertEqual(extra["first_tool"], "Skill")
            self.assertEqual(extra["first_skill"], "dsc-scrape")
            self.assertEqual(len(extra["assertion_results"]), 1)
            self.assertTrue(extra["assertion_results"][0]["pass"])

    def test_fail_when_expected_skill_mismatches(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": "Skill",
                     "input": {"skill": "wrong-skill"}},
                ]}},
                {"type": "result", "result": "the answer"},
            ])
            fixture = {
                "name": "wrong-skill", "query": "q",
                "expected_skill": "dsc-scrape",
                "assertions": [],
            }
            score_synthesis_run = synthesis_eval.score_synthesis_run
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_synthesis_run(fixture, str(transcript), bail)
            self.assertFalse(pass_)
            self.assertFalse(extra["expected_skill_pass"])

    def test_fail_when_assertion_fails(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "result", "result": "the answer"},
            ])
            fixture = {
                "name": "bad-assert", "query": "q",
                "expected_skill": None,
                "assertions": [{"kind": "final_text_matches",
                                "pattern": "MISSING", "because": "..."}],
            }
            score_synthesis_run = synthesis_eval.score_synthesis_run
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_synthesis_run(fixture, str(transcript), bail)
            self.assertFalse(pass_)
            self.assertEqual(len(extra["assertion_results"]), 1)
            self.assertFalse(extra["assertion_results"][0]["pass"])


if __name__ == "__main__":
    unittest.main()
