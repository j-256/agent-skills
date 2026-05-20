"""Retry-aware subprocess wrapper for the eval harnesses.

The Claude CLI emits stream-json events of the shape

  {"type":"system","subtype":"api_retry","attempt":N,"max_retries":M,
   "error":"rate_limit"|"server_error",...}

while waiting on the gateway. This module wraps `subprocess.Popen` so that
CLI internal retries don't count against the harness's wall clock, and so
that the harness bails honestly on the documented "gateway window is
poisoned" condition (`attempt == max_retries` on a retry event).

Both `probe-eval.py` and `synthesis-eval.py` use this so the bail
semantics stay consistent across the two harnesses.
"""
import json
import subprocess
import time


POLL_INTERVAL_S = 0.5


def classify_line(d):
    """Return ('retry', {attempt, max_retries}) for api_retry events,
    ('progress', None) for any other parseable line, (None, None) for
    noise."""
    if not isinstance(d, dict):
        return None, None
    if d.get("type") == "system" and d.get("subtype") == "api_retry":
        return "retry", {
            "attempt": d.get("attempt", 0),
            "max_retries": d.get("max_retries", 0),
        }
    return "progress", None


def run_with_retry_aware_bail(cmd, stdout_path, env, cwd, timeout):
    """Spawn `cmd`, redirect stdout to `stdout_path`, and stream the
    JSONL there live to detect retry-budget exhaustion.

    Bail conditions, in priority order:
    1. CLI exhausted its retry budget (api_retry attempt == max_retries
       on the most recent retry event). Returns retry_budget_exhausted=True.
    2. Absolute wall clock exceeded `timeout`. Returns wall_timed_out=True.
       Backstop only -- the api_retry signal is the primary bail.

    The caller opens stdout_path themselves before calling, and is
    responsible for parsing the file's contents after the call returns.

    Returns a dict:
      {
        "retry_budget_exhausted": bool,
        "wall_timed_out": bool,
        "total_retries": int,    # cumulative across all api_retry events seen
        "latest_attempt": int,   # attempt N on the most recent retry event
        "max_retries_field": int,
        "exit_code": int | None, # process exit code, or None if killed
      }
    """
    retry_budget_exhausted = False
    wall_timed_out = False
    total_retries = 0
    latest_attempt = 0
    max_retries_field = 0

    with open(stdout_path, "w") as out_f:
        proc = subprocess.Popen(cmd, stdout=out_f, stderr=subprocess.DEVNULL,
                                env=env, cwd=cwd)
        t0 = time.time()
        read_pos = 0

        while True:
            with open(stdout_path) as in_f:
                in_f.seek(read_pos)
                chunk = in_f.read()
                read_pos = in_f.tell()
            if chunk:
                for raw in chunk.splitlines():
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        d = json.loads(raw)
                    except Exception:
                        continue
                    kind, info = classify_line(d)
                    if kind == "retry":
                        total_retries += 1
                        latest_attempt = info["attempt"]
                        if info["max_retries"] > max_retries_field:
                            max_retries_field = info["max_retries"]
                        if info["max_retries"] and info["attempt"] >= info["max_retries"]:
                            retry_budget_exhausted = True
                            break
            if retry_budget_exhausted:
                break
            if proc.poll() is not None:
                break
            if time.time() - t0 > timeout:
                wall_timed_out = True
                break
            time.sleep(POLL_INTERVAL_S)

        if retry_budget_exhausted or wall_timed_out:
            proc.kill()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

    return {
        "retry_budget_exhausted": retry_budget_exhausted,
        "wall_timed_out": wall_timed_out,
        "total_retries": total_retries,
        "latest_attempt": latest_attempt,
        "max_retries_field": max_retries_field,
        "exit_code": proc.returncode,
    }
