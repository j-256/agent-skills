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
