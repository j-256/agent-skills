"""Unit tests for tools/synthesis-eval.py.

Run with: python3 -m unittest tools.test_synthesis_eval
"""
import json
import os
import sys
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


if __name__ == "__main__":
    unittest.main()
