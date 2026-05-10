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


if __name__ == "__main__":
    unittest.main()
