#!/usr/bin/env python3
"""Trigger-accuracy eval harness for skills.

Fires claude -p runs and scores the first tool invocation. Was
probe-eval.py historically (commit 1d1c08b); the rename matches the
fixture format (`evals/<skill>/trigger-eval.json`) and disambiguates
from synthesis-eval.py.

For each query in the eval set, spawn N runs of `claude -p --model sonnet
<query>` in parallel. Parse the stream-json output; a run counts as
"triggered" iff the first tool_use event is the `Skill` tool with input
`{"skill": "<target-skill>"}`. Anything else (different skill, different
tool, text-only answer) counts as "not triggered."

A query passes when its trigger rate meets its `should_trigger` expectation
with a 0.5 threshold.

Prerequisite: the skill must already be installed under ~/.claude/skills/
with its real (clean) name. See ../CLAUDE.md for why -- skill-creator's
run_eval.py registers skills differently and produces misleading numbers
on this harness.

Bail signal is api_retry-aware. The CLI emits stream-json events of the
shape `{"type":"system","subtype":"api_retry","attempt":N,"max_retries":M,
"error":"rate_limit"|"server_error",...}` while waiting on the gateway.
The harness streams the JSONL live and treats CLI internal retries as
"waiting on gateway, not the model thinking" -- they don't count against
the model-thinking timeout. A run aborts only when the CLI's full retry
budget is exhausted (attempt == max_retries on the most recent retry
event), which is the documented "gateway window is poisoned" condition.
A generous absolute wall clock (--timeout) acts as a safety backstop for
truly hung processes.

Exit codes mirror synthesis-eval.py:
  0 -- all queries pass
  1 -- at least one query fails
  3 -- aborted on retry-budget exhaustion or absolute wall clock (no
       results.json written; throttle-corrupted partial data was the
       exact misleading state the abort is preventing -- re-run when the
       gateway has recovered)

Usage:
  python3 tools/trigger-eval.py \\
    --eval evals/dsc-triage/trigger-eval.json \\
    --skill-name dsc-triage \\
    --runs 3 --workers 4 --timeout 1800 \\
    --out evals/dsc-triage/runs/iteration-N/results.json
"""
import argparse
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _env import load_dotenv
from _retry_aware_subprocess import classify_line, run_with_retry_aware_bail

load_dotenv()
EVAL_MODEL = os.environ.get("DSC_EVAL_MODEL", "sonnet")


def scan_for_first_tool(stdout_path):
    """Read the stream-json transcript and return (first_tool, first_skill)
    for the first tool_use event. (None, None) if no tool was used."""
    first_tool = None
    first_skill = None
    with open(stdout_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "assistant":
                for c in d.get("message", {}).get("content", []):
                    if c.get("type") == "tool_use":
                        first_tool = c.get("name")
                        if first_tool == "Skill":
                            first_skill = c.get("input", {}).get("skill", "")
                        break
                if first_tool is not None:
                    break
    return first_tool, first_skill


def scan_for_decision(lines):
    """Walk a list of stream-json dicts and return either:
      - {"retry_budget_exhausted": True, ...}  on attempt >= max_retries
      - {"first_tool": ..., "first_skill": ...}  on first tool_use seen
      - {"first_tool": None, "first_skill": None}  if neither happened

    Pure-data version of the bail+parse decision, used by tests.
    Production paths use run_with_retry_aware_bail() + scan_for_first_tool()
    on the resulting transcript file.
    """
    first_tool = None
    first_skill = None
    for d in lines:
        kind, info = classify_line(d)
        if kind == "retry":
            if info["max_retries"] and info["attempt"] >= info["max_retries"]:
                return {"retry_budget_exhausted": True,
                        "first_tool": None, "first_skill": None}
        elif kind == "progress":
            if first_tool is None and d.get("type") == "assistant":
                for c in d.get("message", {}).get("content", []):
                    if c.get("type") == "tool_use":
                        first_tool = c.get("name")
                        if first_tool == "Skill":
                            first_skill = c.get("input", {}).get("skill", "")
                        break
    return {"retry_budget_exhausted": False,
            "first_tool": first_tool, "first_skill": first_skill}


def run_one(query, target_skill, timeout, cwd):
    """Spawn `claude -p` and score the first tool invocation.

    Bail conditions are delegated to run_with_retry_aware_bail():
    1. CLI exhausted its retry budget (gateway-poisoned signal).
    2. Absolute wall clock exceeded `timeout` (hung-process backstop).
    """
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        out_path = f.name
    t0 = time.time()
    try:
        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", EVAL_MODEL,
        ]
        bail = run_with_retry_aware_bail(cmd, out_path, env, cwd, timeout)
        elapsed = round(time.time() - t0, 2)
        retry_info = {
            "total_retries": bail.get("total_retries", 0),
            "latest_attempt": bail.get("latest_attempt", 0),
            "elapsed_seconds": elapsed,
        }

        if bail["retry_budget_exhausted"]:
            return {"triggered": False, "first_tool": "RETRY_BUDGET_EXHAUSTED",
                    "first_skill": None, "timed_out": True, **retry_info}
        if bail["wall_timed_out"]:
            return {"triggered": False, "first_tool": "TIMEOUT",
                    "first_skill": None, "timed_out": True, **retry_info}

        first_tool, first_skill = scan_for_first_tool(out_path)
        triggered = (first_tool == "Skill" and first_skill == target_skill)
        return {"triggered": triggered, "first_tool": first_tool,
                "first_skill": first_skill, "timed_out": False, **retry_info}
    finally:
        try:
            os.unlink(out_path)
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", required=True, help="Path to trigger-eval.json")
    ap.add_argument("--skill-name", required=True, help="Clean skill name, e.g. dsc-triage")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=1800,
                    help="Absolute wall-clock backstop in seconds (default 1800). "
                         "Primary bail signal is api_retry budget exhaustion; "
                         "this only fires for a hung process.")
    ap.add_argument("--cwd", default=None, help="CWD for claude -p subprocesses (default: current dir)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cwd = args.cwd or os.getcwd()
    queries = json.load(open(args.eval))
    tasks = []
    for q in queries:
        for _ in range(args.runs):
            tasks.append(q)

    results = {q["query"]: {"query": q["query"], "should_trigger": q["should_trigger"], "runs": []} for q in queries}

    t0 = time.time()
    aborted_on_timeout = False
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(run_one, q["query"], args.skill_name, args.timeout, cwd): q for q in tasks}
        done = 0
        for fut in as_completed(futures):
            q = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"triggered": False, "first_tool": f"ERR:{e}", "first_skill": None, "timed_out": False}
            results[q["query"]]["runs"].append(r)
            done += 1
            extra = ""
            if "elapsed_seconds" in r:
                extra = f" elapsed={r['elapsed_seconds']}s retries={r.get('total_retries', 0)}"
            print(f"  [{done}/{len(tasks)}] triggered={r['triggered']} first_tool={r['first_tool']} first_skill={r['first_skill']}{extra}: {q['query'][:60]}", file=sys.stderr)

            if r.get("timed_out"):
                aborted_on_timeout = True
                reason = r.get("first_tool")
                if reason == "RETRY_BUDGET_EXHAUSTED":
                    cause = ("CLI's retry budget exhausted (gateway-poisoned signal)")
                else:
                    cause = "absolute wall clock exceeded"
                print(
                    f"\n=== ABORT: run timed out on query {q['query'][:60]!r} -- "
                    f"{cause}. Cancelling remaining {len(futures) - done} runs. "
                    "Continuing measurements after a budget-exhaustion event "
                    "would mix real failures with throttle noise. Re-run when "
                    "the gateway has recovered.",
                    file=sys.stderr,
                )
                for pending in futures:
                    if not pending.done():
                        pending.cancel()
                break

    elapsed = time.time() - t0

    summary = []
    passed = 0
    for q in queries:
        runs = results[q["query"]]["runs"]
        triggers = sum(1 for r in runs if r["triggered"])
        rate = triggers / len(runs) if runs else 0
        did_pass = (rate >= 0.5) if q["should_trigger"] else (rate < 0.5)
        if did_pass:
            passed += 1
        summary.append({
            "query": q["query"],
            "should_trigger": q["should_trigger"],
            "triggers": triggers,
            "runs": len(runs),
            "pass": did_pass,
            "run_details": runs,
        })

    out = {
        "skill_name": args.skill_name,
        "eval_set": args.eval,
        "total_queries": len(queries),
        "runs_per_query": args.runs,
        "passed": passed,
        "failed": len(queries) - passed,
        "elapsed_seconds": round(elapsed, 1),
        "aborted_on_timeout": aborted_on_timeout,
        "completed_runs": done,
        "total_runs_planned": len(tasks),
        "results": summary,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    if aborted_on_timeout:
        print(
            f"\n=== trigger-eval: ABORTED on timeout after {done}/{len(tasks)} runs "
            f"({elapsed:.1f}s). Partial results written to {args.out}. ===",
            file=sys.stderr,
        )
        return 3

    print(f"\n=== {args.skill_name}: {passed}/{len(queries)} passed ({elapsed:.1f}s) ===", file=sys.stderr)

    return 0 if passed == len(queries) else 1


if __name__ == "__main__":
    raise SystemExit(main())
