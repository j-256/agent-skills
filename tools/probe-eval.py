#!/usr/bin/env python3
"""Probe a skill's trigger accuracy by firing claude -p runs and scoring
the first tool invocation.

For each query in the eval set, spawn N runs of `claude -p --model sonnet
<query>` in parallel. Parse the stream-json output; a run counts as
"triggered" iff the first tool_use event is the `Skill` tool with input
`{"skill": "<target-skill>"}`. Everything else (different skill, different
tool, text-only answer, timeout) counts as "not triggered."

A query passes when its trigger rate meets its `should_trigger` expectation
with a 0.5 threshold.

Prerequisite: the skill must already be installed under ~/.claude/skills/
with its real (clean) name. See ../CLAUDE.md for why — skill-creator's
run_eval.py registers skills differently and produces misleading numbers
on this harness.

Usage:
  python3 tools/probe-eval.py \\
    --eval evals/dsc-triage/trigger-eval.json \\
    --skill-name dsc-triage \\
    --runs 3 --workers 4 --timeout 240 \\
    --out evals/dsc-triage/runs/iteration-N/results.json
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed


def run_one(query, target_skill, timeout, cwd):
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        out_path = f.name
    try:
        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", "sonnet",
        ]
        with open(out_path, "w") as out:
            proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.DEVNULL, env=env, cwd=cwd)
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                return {"triggered": False, "first_tool": "TIMEOUT", "first_skill": None}
        first_tool = None
        first_skill = None
        with open(out_path) as f:
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
                            if first_tool is None:
                                first_tool = c.get("name")
                                if first_tool == "Skill":
                                    first_skill = c.get("input", {}).get("skill", "")
                            break
                    if first_tool is not None:
                        break
        triggered = (first_tool == "Skill" and first_skill == target_skill)
        return {"triggered": triggered, "first_tool": first_tool, "first_skill": first_skill}
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
    ap.add_argument("--timeout", type=int, default=120)
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
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(run_one, q["query"], args.skill_name, args.timeout, cwd): q for q in tasks}
        done = 0
        for fut in as_completed(futures):
            q = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"triggered": False, "first_tool": f"ERR:{e}", "first_skill": None}
            results[q["query"]]["runs"].append(r)
            done += 1
            print(f"  [{done}/{len(tasks)}] triggered={r['triggered']} first_tool={r['first_tool']} first_skill={r['first_skill']}: {q['query'][:60]}", file=sys.stderr)

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

    elapsed = time.time() - t0
    out = {
        "skill_name": args.skill_name,
        "eval_set": args.eval,
        "total_queries": len(queries),
        "runs_per_query": args.runs,
        "passed": passed,
        "failed": len(queries) - passed,
        "elapsed_seconds": round(elapsed, 1),
        "results": summary,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n=== {args.skill_name}: {passed}/{len(queries)} passed ({elapsed:.1f}s) ===", file=sys.stderr)


if __name__ == "__main__":
    main()
