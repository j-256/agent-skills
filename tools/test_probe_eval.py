"""Unit tests for tools/probe-eval.py.

Run with: python3 -m unittest tools.test_probe_eval
"""
import sys
import unittest
import unittest.mock as mock
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "probe_eval", THIS_DIR / "probe-eval.py"
)
probe_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe_eval)

import _retry_aware_subprocess  # noqa: E402


def retry_event(attempt, max_retries=10, error="rate_limit"):
    return {
        "type": "system",
        "subtype": "api_retry",
        "attempt": attempt,
        "max_retries": max_retries,
        "retry_delay_ms": 60000,
        "error_status": 429,
        "error": error,
    }


def assistant_tool_use(name, input_dict):
    return {
        "type": "assistant",
        "message": {"content": [{"type": "tool_use", "name": name, "input": input_dict}]},
    }


class TestClassifyLine(unittest.TestCase):
    def test_api_retry_event_classified_as_retry(self):
        kind, info = probe_eval.classify_line(retry_event(attempt=3))
        self.assertEqual(kind, "retry")
        self.assertEqual(info, {"attempt": 3, "max_retries": 10})

    def test_assistant_event_classified_as_progress(self):
        kind, info = probe_eval.classify_line(
            assistant_tool_use("Skill", {"skill": "dsc-scrape"})
        )
        self.assertEqual(kind, "progress")
        self.assertIsNone(info)

    def test_non_dict_classified_as_noise(self):
        kind, info = probe_eval.classify_line("not a dict")
        self.assertIsNone(kind)
        self.assertIsNone(info)


class TestScanForDecision(unittest.TestCase):
    def test_healthy_run_with_no_retries_returns_first_tool(self):
        """Slow, healthy run with no api_retry events at all. The CLI
        eventually emits an assistant tool_use; we report first_tool."""
        lines = [
            assistant_tool_use("Skill", {"skill": "dsc-scrape"}),
        ]
        decision = probe_eval.scan_for_decision(lines)
        self.assertFalse(decision["retry_budget_exhausted"])
        self.assertEqual(decision["first_tool"], "Skill")
        self.assertEqual(decision["first_skill"], "dsc-scrape")

    def test_transient_retry_does_not_abort(self):
        """A few rate-limit retries inside the CLI's budget are normal
        throttle; the harness must not abort. After the retries the CLI
        succeeds and we get the tool_use as usual."""
        lines = [
            retry_event(attempt=1),
            retry_event(attempt=2),
            retry_event(attempt=3),
            assistant_tool_use("Skill", {"skill": "dsc-triage"}),
        ]
        decision = probe_eval.scan_for_decision(lines)
        self.assertFalse(decision["retry_budget_exhausted"])
        self.assertEqual(decision["first_tool"], "Skill")
        self.assertEqual(decision["first_skill"], "dsc-triage")

    def test_retry_budget_exhausted_aborts(self):
        """Documented gateway-poisoned signal: the CLI's full retry budget
        was used up. The 10th attempt of 10 means the CLI is about to
        give up; the harness aborts before the next call adds noise."""
        lines = [retry_event(attempt=i) for i in range(1, 11)]
        decision = probe_eval.scan_for_decision(lines)
        self.assertTrue(decision["retry_budget_exhausted"])
        self.assertIsNone(decision["first_tool"])

    def test_progress_before_exhaustion_still_aborts(self):
        """If we already saw a tool_use and then the CLI exhausts its
        retry budget on a later call, the run is still tainted -- the
        gateway-poisoned signal wins. We report the abort honestly even
        though a first_tool was seen earlier."""
        lines = [
            assistant_tool_use("Skill", {"skill": "dsc-scrape"}),
            *[retry_event(attempt=i) for i in range(1, 11)],
        ]
        decision = probe_eval.scan_for_decision(lines)
        self.assertTrue(decision["retry_budget_exhausted"])

    def test_no_tool_use_no_retry_returns_none(self):
        """Text-only answer (no tool_use) and no retries: the run was
        healthy but didn't trigger any tool. first_tool stays None."""
        lines = [{"type": "result", "result": "some text"}]
        decision = probe_eval.scan_for_decision(lines)
        self.assertFalse(decision["retry_budget_exhausted"])
        self.assertIsNone(decision["first_tool"])
        self.assertIsNone(decision["first_skill"])

    def test_first_tool_use_is_recorded_only_once(self):
        """If the CLI emits multiple tool_use events, we only score the
        first -- the trigger contract pins on what fired *first*."""
        lines = [
            assistant_tool_use("Skill", {"skill": "dsc-scrape"}),
            assistant_tool_use("Bash", {"command": "ls"}),
        ]
        decision = probe_eval.scan_for_decision(lines)
        self.assertEqual(decision["first_tool"], "Skill")
        self.assertEqual(decision["first_skill"], "dsc-scrape")


class TestRunOneTimeoutFallback(unittest.TestCase):
    def test_absolute_wall_clock_marks_run_timed_out(self):
        """Backstop: even with no retry events at all, an absolute
        wall-clock timeout aborts. This is the 'hung process' guard."""
        def fake_popen(cmd, stdout, stderr, env, cwd):
            m = mock.MagicMock()
            # poll() always returns None -> process never exits.
            m.poll.return_value = None
            m.wait.return_value = 0
            return m

        # The bail loop lives in _retry_aware_subprocess, so the patches
        # target that module's subprocess and time attributes.
        with mock.patch.object(_retry_aware_subprocess.subprocess, "Popen",
                               side_effect=fake_popen), \
             mock.patch.object(_retry_aware_subprocess.time, "sleep") as fake_sleep:
            t = [0.0]
            def fake_time():
                return t[0]
            def fake_sleep_impl(s):
                t[0] += 100  # advance fast
            fake_sleep.side_effect = fake_sleep_impl

            with mock.patch.object(_retry_aware_subprocess.time, "time",
                                   side_effect=fake_time):
                result = probe_eval.run_one(
                    query="any",
                    target_skill="dsc-scrape",
                    timeout=1,
                    cwd=str(THIS_DIR),
                )

        self.assertTrue(result["timed_out"])
        self.assertEqual(result["first_tool"], "TIMEOUT")
        self.assertFalse(result["triggered"])


if __name__ == "__main__":
    unittest.main()
