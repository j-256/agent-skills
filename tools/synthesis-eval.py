#!/usr/bin/env python3
"""Synthesis-eval harness for DSC skills.

Drives `claude -p --model sonnet` against fixtures declared in
`evals/<skill>/synthesis-eval.json`, parses the stream-json transcripts,
and asserts against typed assertion records.

"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


KIND_REQUIRED_FIELDS = {
    "final_text_matches": ["pattern"],
    "final_text_excludes": ["pattern"],
    "tool_input_matches": ["tool", "field", "pattern"],
    "tool_sequence_includes": ["pattern"],
}


class FixtureSchemaError(Exception):
    pass


@dataclass
class ToolUse:
    name: str
    input: dict


@dataclass
class ParsedTranscript:
    tool_uses: list = field(default_factory=list)
    final_text: Optional[str] = None
    transcript_path: Optional[Path] = None


@dataclass
class AssertionResult:
    kind: str
    args: dict
    pass_: bool
    message: str
    because: str


def validate_fixtures(fixtures):
    if not isinstance(fixtures, list):
        raise FixtureSchemaError("top-level value must be a list of fixtures")
    seen_names = set()
    for i, fx in enumerate(fixtures):
        prefix = f"fixture[{i}]"
        if not isinstance(fx, dict):
            raise FixtureSchemaError(f"{prefix} must be an object")
        name = fx.get("name")
        if not isinstance(name, str) or not name:
            raise FixtureSchemaError(f"{prefix} missing required string 'name'")
        if name in seen_names:
            raise FixtureSchemaError(f"{prefix} duplicate name {name!r}")
        seen_names.add(name)
        if not isinstance(fx.get("query"), str) or not fx["query"]:
            raise FixtureSchemaError(f"{prefix} ({name}) missing required string 'query'")
        assertions = fx.get("assertions", [])
        if not isinstance(assertions, list):
            raise FixtureSchemaError(f"{prefix} ({name}) 'assertions' must be a list")
        for j, a in enumerate(assertions):
            apref = f"{prefix} ({name}).assertions[{j}]"
            if not isinstance(a, dict):
                raise FixtureSchemaError(f"{apref} must be an object")
            kind = a.get("kind")
            if kind not in KIND_REQUIRED_FIELDS:
                raise FixtureSchemaError(
                    f"{apref} unknown kind {kind!r}; must be one of {sorted(KIND_REQUIRED_FIELDS)}"
                )
            for required in KIND_REQUIRED_FIELDS[kind]:
                if required not in a:
                    raise FixtureSchemaError(
                        f"{apref} kind={kind} missing required field {required!r}"
                    )


def evaluate_assertion(assertion, parsed):
    kind = assertion.get("kind")
    because = assertion.get("because", "")
    args = {k: v for k, v in assertion.items() if k not in ("kind", "because")}

    if kind == "final_text_matches":
        pattern = assertion["pattern"]
        if parsed.final_text is None:
            return AssertionResult(kind, args, False,
                                   "no final answer recorded", because)
        if re.search(pattern, parsed.final_text):
            return AssertionResult(kind, args, True,
                                   "matched", because)
        return AssertionResult(kind, args, False,
                               f"pattern {pattern!r} not found", because)

    if kind == "final_text_excludes":
        pattern = assertion["pattern"]
        if parsed.final_text is None:
            return AssertionResult(kind, args, False,
                                   "no final answer recorded", because)
        if re.search(pattern, parsed.final_text):
            return AssertionResult(kind, args, False,
                                   f"pattern {pattern!r} unexpectedly matched",
                                   because)
        return AssertionResult(kind, args, True, "no match (good)", because)

    if kind == "tool_input_matches":
        tool = assertion["tool"]
        field = assertion["field"]
        pattern = assertion["pattern"]
        for tu in parsed.tool_uses:
            if tu.name != tool:
                continue
            value = tu.input.get(field, "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value)
            if re.search(pattern, str(value)):
                return AssertionResult(kind, args, True,
                                       f"matched on {tool}.{field}", because)
        return AssertionResult(kind, args, False,
                               f"no {tool} call had {field} matching {pattern!r}",
                               because)

    if kind == "tool_sequence_includes":
        pattern = assertion["pattern"]
        sequence = "\n".join(tu.name for tu in parsed.tool_uses)
        if re.search(pattern, sequence):
            return AssertionResult(kind, args, True,
                                   "sequence matched", because)
        return AssertionResult(kind, args, False,
                               f"sequence {sequence!r} did not match {pattern!r}",
                               because)

    raise ValueError(f"unknown assertion kind: {kind!r}")


def parse_transcript(path):
    """Parse a stream-json JSONL transcript.

    Walks `assistant` events for tool_use content blocks (in order) and
    extracts the final answer string from the single `result` event.
    Partial `stream_event` chunks are ignored — completed tool calls
    appear canonically in `assistant` events.
    """
    out = ParsedTranscript(transcript_path=Path(path))
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t == "assistant":
                for c in d.get("message", {}).get("content", []):
                    if c.get("type") == "tool_use":
                        out.tool_uses.append(ToolUse(
                            name=c.get("name", ""),
                            input=c.get("input", {}) or {},
                        ))
            elif t == "result":
                r = d.get("result")
                out.final_text = r if isinstance(r, str) else str(r)
    return out


def run_fixture_once(fixture, timeout, cwd, transcript_dir, run_idx):
    """Run one query, parse, evaluate all assertions. Returns a per-run dict."""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    transcript_path = transcript_dir / f"{fixture['name']}-{run_idx}.jsonl"
    transcript_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "claude",
        "-p", fixture["query"],
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", "sonnet",
    ]
    timed_out = False
    with open(transcript_path, "w") as out:
        proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.DEVNULL,
                                env=env, cwd=cwd)
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            timed_out = True

    if timed_out:
        parsed = ParsedTranscript(transcript_path=transcript_path)
    else:
        parsed = parse_transcript(transcript_path)

    first_skill = None
    if parsed.tool_uses:
        first = parsed.tool_uses[0]
        if first.name == "Skill":
            first_skill = first.input.get("skill")

    expected_skill = fixture.get("expected_skill")
    expected_skill_pass = (
        expected_skill is None or first_skill == expected_skill
    )

    assertion_records = []
    for a in fixture.get("assertions", []):
        r = evaluate_assertion(a, parsed)
        assertion_records.append({
            "kind": r.kind,
            "args": r.args,
            "pass": r.pass_,
            "message": r.message,
            "because": r.because,
        })

    all_pass = expected_skill_pass and all(r["pass"] for r in assertion_records)

    return {
        "transcript_path": str(transcript_path),
        "first_skill": first_skill,
        "expected_skill_pass": expected_skill_pass,
        "timed_out": timed_out,
        "assertion_results": assertion_records,
        "pass": all_pass,
    }


def _run_one_for_pool(args_tuple):
    """ProcessPoolExecutor target — top-level so it pickles."""
    fixture, timeout, cwd, transcript_dir_str, run_idx = args_tuple
    return run_fixture_once(fixture, timeout, Path(cwd),
                            Path(transcript_dir_str), run_idx)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", required=True, help="Path to synthesis-eval.json")
    ap.add_argument("--out", required=True, help="Path to write results JSON")
    ap.add_argument("--runs", type=int, default=5,
                    help="Runs per fixture (default 5)")
    ap.add_argument("--lenient", action="store_true",
                    help="Pass if majority of runs pass (default: strict – all runs must pass)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--cwd", default=None)
    args = ap.parse_args()

    cwd = args.cwd or os.getcwd()

    with open(args.eval) as f:
        fixtures = json.load(f)
    try:
        validate_fixtures(fixtures)
    except FixtureSchemaError as e:
        print(f"FIXTURE SCHEMA ERROR: {e}", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_dir = out_path.parent / "transcripts"

    tasks = []
    for fx in fixtures:
        for run_idx in range(1, args.runs + 1):
            tasks.append((fx, args.timeout, cwd, str(transcript_dir), run_idx))

    results_by_name = {fx["name"]: {"fixture": fx, "runs": []} for fx in fixtures}
    total = len(tasks)
    t0 = time.time()
    done = 0

    aborted_on_timeout = False
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(_run_one_for_pool, t): t for t in tasks}
        for fut in as_completed(futures):
            (fx, _to, _cwd, _td, run_idx) = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"transcript_path": None, "first_skill": None,
                     "expected_skill_pass": False, "timed_out": False,
                     "assertion_results": [],
                     "pass": False, "error": f"runner crashed: {e}"}
            results_by_name[fx["name"]]["runs"].append((run_idx, r))
            done += 1

            status = "PASS" if r["pass"] else "FAIL"
            assertion_failures = [ar for ar in r.get("assertion_results", []) if not ar["pass"]]
            asserts_passed = sum(1 for ar in r.get("assertion_results", []) if ar["pass"])
            asserts_total = len(r.get("assertion_results", []))
            extra = ""
            if not r["pass"]:
                if r.get("timed_out"):
                    extra = " (timed out)"
                elif not r.get("expected_skill_pass", True):
                    extra = f" expected_skill={fx.get('expected_skill')!r} got={r.get('first_skill')!r}"
                elif assertion_failures:
                    af = assertion_failures[0]
                    extra = f" {af['kind']} {af['args'].get('pattern','')} – {af['because']}"
            print(f"[{done}/{total}] {fx['name']} run {run_idx}/{args.runs} {status}"
                  f" (asserts {asserts_passed}/{asserts_total}){extra}",
                  file=sys.stdout)

            if r.get("timed_out"):
                aborted_on_timeout = True
                print(
                    f"\n=== ABORT: run {fx['name']}-{run_idx} timed out. "
                    f"Cancelling remaining {len(futures) - done} runs. "
                    "Eval signal is unreliable when any run hits the wall-clock; "
                    "a single timeout typically means gateway throttling, "
                    "and continuing measurements would mix real failures with "
                    "throttle noise. Re-run when the gateway has recovered.",
                    file=sys.stderr,
                )
                for pending in futures:
                    if not pending.done():
                        pending.cancel()
                break

    elapsed = time.time() - t0

    if aborted_on_timeout:
        print(
            f"\n=== synthesis-eval: ABORTED on timeout after {done}/{total} runs "
            f"({elapsed:.1f}s). No results written. ===",
            file=sys.stderr,
        )
        return 3

    summary = []
    fixtures_passed = 0
    for fx in fixtures:
        runs = sorted(results_by_name[fx["name"]]["runs"], key=lambda x: x[0])
        run_dicts = [r for _, r in runs]
        run_passes = [r["pass"] for r in run_dicts]
        triggers = sum(1 for r in run_dicts if r.get("expected_skill_pass"))
        if args.lenient:
            fx_pass = (sum(run_passes) / len(run_passes) >= 0.5) if run_passes else False
        else:
            fx_pass = all(run_passes) and len(run_passes) == args.runs
        if fx_pass:
            fixtures_passed += 1
        summary.append({
            "name": fx["name"],
            "query": fx["query"],
            "expected_skill": fx.get("expected_skill"),
            "hypothesis": fx.get("hypothesis", ""),
            "pass": fx_pass,
            "triggers": triggers,
            "runs": run_dicts,
        })

    out = {
        "eval_set": args.eval,
        "total_fixtures": len(fixtures),
        "runs_per_fixture": args.runs,
        "strict": not args.lenient,
        "fixtures_passed": fixtures_passed,
        "fixtures_failed": len(fixtures) - fixtures_passed,
        "elapsed_seconds": round(elapsed, 1),
        "results": summary,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2, default=str)

    mode = "lenient" if args.lenient else "strict"
    print(f"\n=== synthesis-eval: {fixtures_passed}/{len(fixtures)} fixtures passed "
          f"({args.runs} runs each, {mode}, {elapsed:.1f}s) ===", file=sys.stderr)

    return 0 if fixtures_passed == len(fixtures) else 1


if __name__ == "__main__":
    raise SystemExit(main())
