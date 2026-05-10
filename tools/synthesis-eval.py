#!/usr/bin/env python3
"""Synthesis-eval harness for DSC skills.

Drives `claude -p --model sonnet` against fixtures declared in
`evals/<skill>/synthesis-eval.json`, parses the stream-json transcripts,
and asserts against typed assertion records.

"""
import json
import re
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


if __name__ == "__main__":
    raise SystemExit("CLI entry not implemented yet")
