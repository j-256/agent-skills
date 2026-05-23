"""Unit tests for tools/trigger-eval.py.

Run with: python3 -m unittest tools.test_trigger_eval
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "trigger_eval", THIS_DIR / "trigger-eval.py"
)
trigger_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trigger_eval)
score_trigger_run = trigger_eval.score_trigger_run


class TestTranscriptDirFor(unittest.TestCase):
    def test_namespaces_by_out_stem(self):
        cold = trigger_eval.transcript_dir_for(
            Path("/tmp/iter-x/results-cold.json")
        )
        warm = trigger_eval.transcript_dir_for(
            Path("/tmp/iter-x/results-warm.json")
        )
        self.assertEqual(cold, Path("/tmp/iter-x/transcripts/results-cold"))
        self.assertEqual(warm, Path("/tmp/iter-x/transcripts/results-warm"))
        self.assertNotEqual(cold, warm)


class TestScoreTriggerRun(unittest.TestCase):
    """Replaces TestRunOne.

    score_trigger_run is the trigger-eval scoring callback the runner
    invokes per (fixture, run). It receives a fixture, a transcript
    path, and the bail dict; returns (pass: bool, kind_extra: dict).
    """

    def _write_transcript(self, td, lines):
        path = Path(td) / "fake-transcript.jsonl"
        path.write_text("".join(json.dumps(L) + "\n" for L in lines))
        return path

    def test_pass_when_correct_skill_fires(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": "Skill",
                     "input": {"skill": "dsc-triage"}},
                ]}},
            ])
            fixture = {"query": "q", "should_trigger": True}
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_trigger_run(
                fixture, str(transcript), bail,
                target_skill="dsc-triage",
            )
            self.assertTrue(pass_)
            self.assertTrue(extra["triggered"])
            self.assertEqual(extra["first_tool"], "Skill")
            self.assertEqual(extra["first_skill"], "dsc-triage")

    def test_fail_when_wrong_skill_fires(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": "Skill",
                     "input": {"skill": "wrong-skill"}},
                ]}},
            ])
            fixture = {"query": "q", "should_trigger": True}
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_trigger_run(
                fixture, str(transcript), bail,
                target_skill="dsc-triage",
            )
            self.assertFalse(pass_)
            self.assertFalse(extra["triggered"])
            self.assertEqual(extra["first_skill"], "wrong-skill")

    def test_fail_when_non_skill_tool_fires(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": "Bash", "input": {}},
                ]}},
            ])
            fixture = {"query": "q", "should_trigger": True}
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_trigger_run(
                fixture, str(transcript), bail,
                target_skill="dsc-triage",
            )
            self.assertFalse(pass_)
            self.assertEqual(extra["first_tool"], "Bash")

    def test_pass_when_no_tool_used_and_should_not_trigger(self):
        """The harness's pass criterion is per-query rate-based, but
        the per-run callback returns (triggered, ...). The rate-based
        decision happens in summarize(), not here. So a single run that
        correctly didn't trigger reports pass_=False (didn't trigger),
        and the summarize step decides whether the rate matches
        should_trigger=False at the fixture level."""
        with tempfile.TemporaryDirectory() as td:
            transcript = self._write_transcript(td, [
                {"type": "result", "result": "text-only answer"},
            ])
            fixture = {"query": "q", "should_trigger": False}
            bail = {"retry_budget_exhausted": False, "wall_timed_out": False}
            pass_, extra = score_trigger_run(
                fixture, str(transcript), bail,
                target_skill="dsc-triage",
            )
            # pass_ here means "this individual run triggered the skill".
            # It correctly didn't, so triggered=False -> pass_=False.
            self.assertFalse(extra["triggered"])
            self.assertIsNone(extra["first_tool"])


if __name__ == "__main__":
    unittest.main()
