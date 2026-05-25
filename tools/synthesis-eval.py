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
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _eval_runner import run_eval


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


def transcript_dir_for(out_path):
    """Per-run transcript directory, namespaced by `--out` stem so
    multi-phase iterations sharing one results dir don't clobber each
    other's JSONLs."""
    return out_path.parent / "transcripts" / out_path.stem


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


def get_synthesis_query(fixture):
    """Module-level (picklable) query extractor. ProcessPoolExecutor on
    macOS spawn-mode workers unpickle this; lambdas wouldn't survive."""
    return fixture["query"]


def score_synthesis_run(fixture, transcript_path, bail):
    """Synthesis scoring callback for _eval_runner.run_eval.

    Receives the fixture, the path to the (already-written) transcript,
    and the bail dict. Returns (pass: bool, kind_extra: dict).

    On timed-out runs the runner doesn't call this -- a timed-out run
    is auto-failed in _run_one_task. So we don't need to handle the
    bail-flagged case here; we always have a parseable transcript.

    kind_extra carries first_tool + first_skill so the runner can
    surface them on the canonical stderr line; assertion_results +
    expected_skill_pass are downstream consumers (results.json).
    """
    parsed = parse_transcript(transcript_path)

    first_tool = None
    first_skill = None
    if parsed.tool_uses:
        first = parsed.tool_uses[0]
        first_tool = first.name
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

    all_pass = expected_skill_pass and all(
        r["pass"] for r in assertion_records
    )
    return all_pass, {
        "first_tool": first_tool,
        "first_skill": first_skill,
        "expected_skill_pass": expected_skill_pass,
        "assertion_results": assertion_records,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", required=True, help="Path to synthesis-eval.json")
    ap.add_argument("--out", required=True, help="Path to write results JSON")
    ap.add_argument("--runs", type=int, default=5,
                    help="Runs per fixture (default 5)")
    ap.add_argument("--lenient", action="store_true",
                    help="Pass if majority of runs pass (default: strict -- "
                         "all runs must pass)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--cwd", default=None)
    ap.add_argument(
        "--profile", choices=["default", "restricted"], default="default",
        help="Toolbelt profile for the spawned claude -p. 'default' "
             "inherits the user's MCP/Agent setup; 'restricted' mirrors "
             "a vanilla install (no MCP, no Agent) -- production-equivalent "
             "for skills that ship to users without those alternates.",
    )
    args = ap.parse_args()

    os.environ["DSC_EVAL_PROFILE"] = args.profile

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
    transcript_dir = transcript_dir_for(out_path)

    skill_name = Path(args.eval).resolve().parent.name

    def summarize(fixtures_with_runs):
        summary = []
        for entry in fixtures_with_runs:
            fx = entry["fixture"]
            runs = sorted(entry["runs"], key=lambda r: r["run_idx"])
            run_passes = [r["pass_"] for r in runs]
            triggers = sum(
                1 for r in runs
                if r["kind_extra"].get("expected_skill_pass")
            )
            if args.lenient:
                fx_pass = (
                    sum(run_passes) / len(run_passes) >= 0.5
                ) if run_passes else False
            else:
                fx_pass = (
                    all(run_passes) and len(run_passes) == args.runs
                )
            summary.append({
                "name": fx["name"],
                "query": fx["query"],
                "expected_skill": fx.get("expected_skill"),
                "hypothesis": fx.get("hypothesis", ""),
                "pass": fx_pass,
                "triggers": triggers,
                "runs": runs,
            })
        return summary

    results, exit_code = run_eval(
        kind="synthesis",
        fixtures=fixtures,
        get_fixture_id=lambda fx: fx["name"],
        get_query=get_synthesis_query,
        score_run=score_synthesis_run,
        summarize=summarize,
        runs_per_fixture=args.runs,
        workers=args.workers,
        timeout=args.timeout,
        cwd=cwd,
        transcript_dir=transcript_dir,
        summary_label="fixtures",
        skill_name=skill_name,
        eval_path=args.eval,
    )

    results["strict"] = not args.lenient
    results["fixtures_passed"] = sum(
        1 for r in results["results"] if r["pass"]
    )
    results["fixtures_failed"] = (
        len(results["results"]) - results["fixtures_passed"]
    )

    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, default=str)

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
