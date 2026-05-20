#!/usr/bin/env python3
"""Read-only dashboard for in-flight probe-eval runs.

Walks the system process table for `tools/probe-eval.py` workers, finds
their open stream-json tempfiles via lsof, and renders a live HTML
dashboard backed by `http.server` (stdlib only -- no pip install).

Usage:
  # one-shot CLI summary
  python3 tools/probe-eval-monitor.py

  # http dashboard at http://localhost:8765
  python3 tools/probe-eval-monitor.py serve [--port 8765] [--open]

  # pin to a specific Claude Code session by UUID, UUID prefix, or name
  python3 tools/probe-eval-monitor.py serve --session test-rename-yeehaw
  python3 tools/probe-eval-monitor.py serve --session 0fc37026

  # serve and open the dashboard in the default browser
  python3 tools/probe-eval-monitor.py serve --open

The serve mode loads its HTML shell once and polls /api/state.json
client-side -- 5s when there are active runs, 30s when idle, pauses
after ~3 min of no change. Scroll position survives polls. Click
"refresh now" to resume after an idle pause. Doesn't disturb the
running probe-evals.
"""
import argparse
import html
import json
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


REFRESH_SECONDS = 5
RETRY_RATE_AMBER = 0.3
RETRY_RATE_RED = 0.6
ATTEMPT_AMBER = 5
ATTEMPT_RED = 8


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def proc_cwd(pid):
    """Return the cwd of `pid` via lsof, or None."""
    out = run(["lsof", "-a", "-d", "cwd", "-p", str(pid), "-Fn"])
    for line in out.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


def find_probe_eval_pythons():
    """Return [(pid, skill_name, eval_path_abs)] for Python interpreters
    running tools/probe-eval.py. Resolves --eval against the Python
    process's cwd so the dashboard works regardless of where it is run
    from."""
    out = run(["ps", "-axo", "pid=,command="])
    pids = []
    for line in out.splitlines():
        if "tools/probe-eval.py" not in line:
            continue
        if "/python" not in line.lower() and "Python" not in line:
            continue
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        pid = int(parts[0])
        cmd = parts[1]
        m_skill = re.search(r"--skill-name\s+(\S+)", cmd)
        m_eval = re.search(r"--eval\s+(\S+)", cmd)
        skill = m_skill.group(1) if m_skill else "?"
        eval_path = m_eval.group(1) if m_eval else None
        if eval_path and not Path(eval_path).is_absolute():
            cwd = proc_cwd(pid)
            if cwd:
                eval_path = str(Path(cwd) / eval_path)
        pids.append((pid, skill, eval_path))
    return pids


def find_active_claude_subprocs(parent_pid):
    """[(claude_pid, worker_pid)] for claude subprocs whose grandparent
    is parent_pid."""
    out = run(["ps", "-axo", "pid=,ppid=,command="])
    workers = set()
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(.*)$", line)
        if not m:
            continue
        pid, ppid, cmd = m.groups()
        if int(ppid) == parent_pid and ("Python" in cmd or "/python" in cmd):
            workers.add(int(pid))
    out_pairs = []
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(.*)$", line)
        if not m:
            continue
        pid, ppid, cmd = m.groups()
        if int(ppid) in workers and cmd.startswith("claude -p"):
            out_pairs.append((int(pid), int(ppid)))
    return out_pairs


def find_transcript_path(worker_pid):
    """The Python worker holds the live stream-json tempfile open."""
    lsof_out = run(["lsof", "-p", str(worker_pid)])
    for line in lsof_out.splitlines():
        m = re.search(r"(/private/var/folders/\S+\.json)\b", line)
        if m:
            return m.group(1)
    return None


def transcript_stats(path):
    """Count api_retry events and find the highest attempt seen so far.

    `total_retries` is the number of api_retry events across all calls
    in this subprocess (the CLI's local attempt counter resets between
    calls). `latest_attempt` and `max_retries_field` describe the most
    recent retry event -- so latest_attempt 10 of max_retries 10 is the
    documented gateway-poisoned bail signal."""
    total_retries = 0
    latest_attempt = 0
    max_retries_field = 0
    last_error = None
    if not path or not Path(path).exists():
        return {"total_retries": 0, "latest_attempt": 0,
                "max_retries_field": 0, "last_error": None,
                "size_bytes": 0}
    size = Path(path).stat().st_size
    with open(path) as f:
        for line in f:
            if '"api_retry"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "system" and d.get("subtype") == "api_retry":
                total_retries += 1
                latest_attempt = d.get("attempt", 0)
                if d.get("max_retries", 0) > max_retries_field:
                    max_retries_field = d.get("max_retries", 0)
                last_error = d.get("error")
    return {"total_retries": total_retries, "latest_attempt": latest_attempt,
            "max_retries_field": max_retries_field, "last_error": last_error,
            "size_bytes": size}


def proc_runtime_s(pid):
    out = run(["ps", "-o", "etime=", "-p", str(pid)]).strip()
    if not out:
        return None
    if "-" in out:
        days, rest = out.split("-", 1)
        days = int(days)
    else:
        days = 0
        rest = out
    parts = [int(x) for x in rest.split(":")]
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h, m, s = 0, parts[0], parts[1]
    else:
        h, m, s = 0, 0, parts[0]
    return days * 86400 + h * 3600 + m * 60 + s


def load_eval_queries(eval_path):
    """Load the eval JSON; return a list of {query, should_trigger} or
    [] on failure. Keep cached implicitly via the OS file cache; eval
    files don't change while a run is in flight."""
    if not eval_path or not Path(eval_path).exists():
        return []
    try:
        with open(eval_path) as f:
            return json.load(f)
    except Exception:
        return []


def total_tasks_for_eval(eval_path, runs=3):
    """The eval JSON has N queries; total tasks for the run is N * runs.
    We don't know --runs from the process command line alone (probe-eval
    doesn't echo it back), so default to 3 (the documented standard)."""
    queries = load_eval_queries(eval_path)
    return len(queries) * runs if queries else None


def query_to_should_trigger(eval_path):
    """Map first 60 chars of each query (matching probe-eval's stderr
    truncation) to its `should_trigger` bool. Used to color the
    segmented progress bar pass/fail without needing exact-string match
    against the truncated row queries."""
    out = {}
    for q in load_eval_queries(eval_path):
        key = q.get("query", "").replace("\n", " ")[:60]
        out[key] = q.get("should_trigger", True)
    return out


PROGRESS_LINE_RE = re.compile(
    r"\[(?P<n>\d+)/(?P<total>\d+)\]\s+"
    r"triggered=(?P<triggered>True|False)\s+"
    r"first_tool=(?P<tool>\S+)\s+"
    r"first_skill=(?P<skill>\S+?)"
    r"(?:\s+elapsed=(?P<elapsed>[\d.]+)s\s+retries=(?P<retries>\d+))?"
    r":\s+(?P<query>.*)$"
)


SESSION_MAX_AGE_HOURS = float(
    __import__("os").environ.get("DASHBOARD_MAX_AGE_HOURS", "4")
)

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
UUID_PREFIX_RE = re.compile(r"^[0-9a-f]{4,32}$", re.IGNORECASE)


def _session_dir_from_lsof(target_pid):
    """Run lsof against `target_pid` and extract a `.../tasks/` path
    from any open .output file it holds. Returns Path or None."""
    if not target_pid:
        return None
    lsof_out = run(["lsof", "-p", str(target_pid)])
    for line in lsof_out.splitlines():
        m = re.search(r"(\S+/tasks)/[^/]+\.output\b", line)
        if m:
            return Path(m.group(1))
    return None


def _uuid_from_tasks_dir(tasks_dir):
    """tasks_dir is `.../<repo-key>/<session-uuid>/tasks`. Return the
    session-uuid component, or None if the path doesn't match."""
    if tasks_dir is None:
        return None
    parts = Path(tasks_dir).parts
    if len(parts) < 2 or parts[-1] != "tasks":
        return None
    candidate = parts[-2]
    return candidate if UUID_RE.match(candidate) else None


def _name_for_uuid(uuid):
    """Look up the user-assigned name for a session UUID by scanning
    ~/.claude/projects/*/<uuid>.jsonl for the latest custom-title entry.

    Returns the name or None. Names persist forever in the per-session
    transcript: each /rename appends one line of shape
    {"type":"custom-title","customTitle":"<name>","sessionId":"<uuid>"}.
    """
    if not uuid:
        return None
    home = Path.home()
    matches = list((home / ".claude" / "projects").glob(f"*/{uuid}.jsonl"))
    if not matches:
        return None
    name = None
    try:
        with open(matches[0]) as f:
            for line in f:
                if '"custom-title"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") == "custom-title":
                    name = d.get("customTitle") or name
    except Exception:
        return None
    return name


def detect_session_dir_from_self():
    """Our own bash parent's open .output. When the dashboard is
    launched as a Claude Code background task, the parent bash has
    `tasks/<my-id>.output` open at fd 1 -- a dispositive anchor for
    the session's tasks/ dir. Returns None when launched some other
    way (e.g. from a regular terminal)."""
    import os
    try:
        ppid = os.getppid()
    except Exception:
        return None
    return _session_dir_from_lsof(ppid)


def detect_session_dir_from_probe_eval():
    """Find a live probe-eval python and use its bash parent's open
    .output file to anchor the session's tasks/ dir. Returns None when
    no probe-evals are running."""
    for pid, _skill, _eval in find_probe_eval_pythons():
        ppid_out = run(["ps", "-o", "ppid=", "-p", str(pid)]).strip()
        if ppid_out:
            d = _session_dir_from_lsof(ppid_out)
            if d:
                return d
    return None


def detect_session_dir_from_recent():
    """Youngest .output file under any `claude-*/*/*/tasks/` glob
    within the SESSION_MAX_AGE_HOURS window. Stale .output files from
    older sessions age out and don't surface as "this session"."""
    import os, time
    cutoff = time.time() - SESSION_MAX_AGE_HOURS * 3600
    roots = []
    if os.environ.get("TMPDIR"):
        roots.append(Path(os.environ["TMPDIR"]))
    roots.extend([Path("/tmp"), Path("/private/tmp")])
    youngest = None
    for root in roots:
        if not root.exists():
            continue
        for tf in root.glob("claude-*/*/*/tasks/*.output"):
            try:
                mtime = tf.stat().st_mtime
            except Exception:
                continue
            if mtime < cutoff:
                continue
            if youngest is None or mtime > youngest[0]:
                youngest = (mtime, tf.parent)
    return youngest[1] if youngest else None


def resolve_session_arg(arg):
    """Convert --session argument (a UUID, UUID prefix, or human name)
    into a tasks/ Path. Strategy:

    1. UUID or UUID-prefix: glob `claude-*/<repo-key>/<uuid>*/tasks` and
       pick the unique match (or newest mtime if ambiguous).
    2. Otherwise treat as a human name: scan
       ~/.claude/projects/*/*.jsonl for {"customTitle":"<arg>"}, take
       the most-recently-modified, look up its tasks/ dir.

    Returns Path or None.
    """
    import os
    if not arg:
        return None
    if UUID_RE.match(arg) or UUID_PREFIX_RE.match(arg):
        return _resolve_uuid_or_prefix(arg)
    return _resolve_name(arg)


def _resolve_uuid_or_prefix(arg):
    import os
    roots = []
    if os.environ.get("TMPDIR"):
        roots.append(Path(os.environ["TMPDIR"]))
    roots.extend([Path("/tmp"), Path("/private/tmp")])
    matches = []
    for root in roots:
        if not root.exists():
            continue
        for tasks in root.glob(f"claude-*/*/{arg}*/tasks"):
            if tasks.is_dir():
                matches.append(tasks)
    if not matches:
        return None
    # Newest-mtime wins on ambiguity.
    matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0]


def _resolve_name(name):
    """Find sessions whose latest customTitle equals `name`. Tolerates
    compact ({"k":"v"}) or spaced ({"k": "v"}) JSON since the CLI writes
    compact in production but tests and future CLI versions may differ.
    Newest-mtime wins on ambiguity."""
    home = Path.home()
    projects = home / ".claude" / "projects"
    if not projects.exists():
        return None
    candidates = []
    for jsonl in projects.glob("*/*.jsonl"):
        uuid = jsonl.stem
        if not UUID_RE.match(uuid):
            continue
        # Cheap prescreen: only parse files that reference customTitle.
        try:
            with open(jsonl) as f:
                blob = f.read()
        except Exception:
            continue
        if "customTitle" not in blob:
            continue
        # Walk to confirm: take the latest custom-title line that
        # actually sets customTitle == name.
        latest_match = False
        for line in blob.splitlines():
            if "customTitle" not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "custom-title":
                latest_match = (d.get("customTitle") == name)
        if latest_match:
            candidates.append((jsonl.stat().st_mtime, uuid))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    _, uuid = candidates[0]
    return _resolve_uuid_or_prefix(uuid)


# Module-level state set by main(), read by request handlers.
_explicit_session_arg = None


def discover_session():
    """Resolve the single session tasks/ dir to walk, plus identifying
    metadata. Returns a dict:

      {"tasks_dir": Path | None,
       "source": "explicit"|"current"|"live-probe-eval"|"recent"|None,
       "uuid": str | None,
       "name": str | None}

    Layered signals, most-precise first:
    1. --session <name-or-uuid> if supplied (explicit user choice).
    2. Self bash parent's open .output -- the current Claude Code
       session, which is strictly session-scoped (parent only knows
       about us).
    3. Any live probe-eval's bash parent.
    4. Youngest .output globally within SESSION_MAX_AGE_HOURS.
       After that window the dashboard reports "no runs" instead of
       leaking historical data.
    """
    if _explicit_session_arg:
        # User asked for a specific session; honour or refuse, never
        # silently fall back to auto-detect (that would surface the
        # wrong session under a "current" label).
        d = resolve_session_arg(_explicit_session_arg)
        if d:
            return _session_record(d, "explicit")
        return {"tasks_dir": None, "source": "explicit-not-found",
                "uuid": None, "name": None}
    d = detect_session_dir_from_self()
    if d:
        return _session_record(d, "current")
    d = detect_session_dir_from_probe_eval()
    if d:
        return _session_record(d, "live-probe-eval")
    d = detect_session_dir_from_recent()
    if d:
        return _session_record(d, "recent")
    return {"tasks_dir": None, "source": None, "uuid": None, "name": None}


def _session_record(tasks_dir, source):
    uuid = _uuid_from_tasks_dir(tasks_dir)
    name = _name_for_uuid(uuid)
    return {"tasks_dir": tasks_dir, "source": source, "uuid": uuid, "name": name}


def discover_task_dirs():
    """Back-compat shim for code paths that just want the list-of-Paths.
    All current callers can move to discover_session() directly when
    convenient."""
    rec = discover_session()
    return [rec["tasks_dir"]] if rec["tasks_dir"] else []


def find_skill_task_file(skill, expected_total):
    """Walk the bash task output dirs and return the file produced by
    this skill's probe-eval run, plus all its progress lines parsed.
    Returns (path, [parsed_line, ...]) or (None, []).

    The probe-eval stderr lines `[N/M] triggered=...` live in those
    output files. We bind a file to a skill by matching `M` against the
    expected total for that skill, then disambiguating by the dominant
    `first_skill=` in the file (two skills can share `total` -- e.g.
    dsc-scenario and dsc-triage both at 23x3=69 -- so the histogram
    breaks the tie).
    """
    if not expected_total:
        return None, []
    candidates = []
    task_dirs = discover_task_dirs()
    if not task_dirs:
        return None, []
    output_files = [tf for d in task_dirs for tf in d.glob("*.output")]
    for tf in output_files:
        try:
            with open(tf) as f:
                content = f.read()
        except Exception:
            continue
        rows = []
        for line in content.splitlines():
            m = PROGRESS_LINE_RE.search(line)
            if m:
                rows.append({
                    "n": int(m.group("n")),
                    "total": int(m.group("total")),
                    "triggered": m.group("triggered") == "True",
                    "first_tool": m.group("tool"),
                    "first_skill": m.group("skill"),
                    "elapsed": float(m.group("elapsed")) if m.group("elapsed") else None,
                    "retries": int(m.group("retries")) if m.group("retries") else None,
                    "query": m.group("query"),
                })
        if not rows:
            continue
        last = rows[-1]
        if last["total"] != expected_total:
            continue
        # Pick the file whose target skill appears most often in
        # successfully-triggered runs. This identifies which probe-eval
        # process wrote it.
        hist = {}
        for r in rows:
            if r["triggered"] and r["first_skill"] not in (None, "None"):
                hist[r["first_skill"]] = hist.get(r["first_skill"], 0) + 1
        top = max(hist.items(), key=lambda kv: kv[1])[0] if hist else None
        candidates.append((tf, rows, top))
    matching = [c for c in candidates if c[2] == skill]
    if not matching:
        return None, []
    # Newest mtime wins (handles re-runs).
    matching.sort(key=lambda c: c[0].stat().st_mtime, reverse=True)
    tf, rows, _ = matching[0]
    return tf, rows


def find_progress_for_skill(skill, expected_total):
    tf, rows = find_skill_task_file(skill, expected_total)
    if not rows:
        return None
    last = rows[-1]
    return {"done": last["n"], "total": last["total"], "task_file": str(tf)}


def find_recent_completions(skill, expected_total, limit=5):
    """Return the last `limit` parsed progress rows for the file bound
    to this skill. These are runs that have *already finished* (either
    cleanly or as misses); their claude subprocess is gone but they
    remain visible to the user for a short window."""
    _tf, rows = find_skill_task_file(skill, expected_total)
    return rows[-limit:] if rows else []


def gather_state():
    """Returns a list of skill records for the dashboard.

    Two sources:
      1. Live probe-eval python processes (gives access to in-flight
         claude subprocs with retry stats).
      2. Recent task output files (gives access to *finished* runs whose
         python parent has already exited -- otherwise the skill would
         vanish from the dashboard the moment the run completes).
    """
    parents = find_probe_eval_pythons()
    seen_skills = set()
    skills = []

    # 1. Live runs first -- these have active subprocs and retry stats.
    for pid, skill, eval_path in parents:
        seen_skills.add(skill)
        claude_pairs = find_active_claude_subprocs(pid)
        active = []
        for cpid, wpid in claude_pairs:
            tpath = find_transcript_path(wpid)
            stats = transcript_stats(tpath)
            runtime = proc_runtime_s(cpid) or 0
            active.append({"claude_pid": cpid, "worker_pid": wpid,
                           "runtime_s": runtime, **stats})
        active.sort(key=lambda r: r["runtime_s"], reverse=True)
        expected_total = total_tasks_for_eval(eval_path)
        all_rows = find_skill_task_file(skill, expected_total)[1]
        progress = find_progress_for_skill(skill, expected_total)
        recent = all_rows[-5:] if all_rows else []
        skill_total_retries = sum(a["total_retries"] for a in active)
        skills.append({
            "skill": skill, "python_pid": pid, "live": True,
            "active": active, "recent": recent, "all_rows": all_rows,
            "should_trigger_map": query_to_should_trigger(eval_path),
            "progress": progress,
            "expected_total_runs": expected_total,
            "active_subprocs": len(active),
            "in_flight_retries": skill_total_retries,
        })

    # 2. Finished runs: walk task output files, skip skills already seen
    # live. Bind file -> skill via the dominant first_skill in triggered
    # rows. Unlike live mode we don't have eval_path, so we look up the
    # eval file by the conventional path -- the four DSC skills follow a
    # standard layout.
    bound = {}  # skill -> (path, rows, mtime)
    for d in discover_task_dirs():
        for tf in d.glob("*.output"):
            try:
                with open(tf) as f:
                    content = f.read()
            except Exception:
                continue
            rows = []
            for line in content.splitlines():
                m = PROGRESS_LINE_RE.search(line)
                if m:
                    rows.append({
                        "n": int(m.group("n")),
                        "total": int(m.group("total")),
                        "triggered": m.group("triggered") == "True",
                        "first_tool": m.group("tool"),
                        "first_skill": m.group("skill"),
                        "query": m.group("query"),
                    })
            if not rows:
                continue
            hist = {}
            for r in rows:
                if r["triggered"] and r["first_skill"] not in (None, "None"):
                    hist[r["first_skill"]] = hist.get(r["first_skill"], 0) + 1
            target = max(hist.items(), key=lambda kv: kv[1])[0] if hist else None
            if not target or target in seen_skills:
                continue
            mtime = tf.stat().st_mtime
            if target in bound and bound[target][2] >= mtime:
                continue
            bound[target] = (tf, rows, mtime)

    for skill, (tf, rows, mtime) in bound.items():
        # Best-effort eval path for `should_trigger` lookup. Resolve
        # against the cwd this dashboard was launched from (fall back
        # to the conventional repo-root layout if absent).
        eval_path = Path("evals") / skill / "trigger-eval.json"
        if not eval_path.exists():
            eval_path = (Path("/repo/claude-code-skills/evals") /
                         skill / "trigger-eval.json")
        expected_total = rows[-1]["total"] if rows else None
        skills.append({
            "skill": skill, "python_pid": None, "live": False,
            "active": [], "recent": rows[-5:], "all_rows": rows,
            "should_trigger_map": query_to_should_trigger(str(eval_path)),
            "progress": {"done": rows[-1]["n"], "total": expected_total,
                         "task_file": str(tf)},
            "expected_total_runs": expected_total,
            "active_subprocs": 0,
            "in_flight_retries": 0,
            "finished_at": mtime,
        })

    # Stable sort: live skills first (alphabetical), then finished
    # (most-recently-finished first).
    skills.sort(key=lambda s: (
        0 if s["live"] else 1,
        s["skill"] if s["live"] else -s.get("finished_at", 0),
    ))
    return skills


# ---------- state serialization for /api/state.json ----------


def color_for_attempt(attempt, max_attempts):
    if not attempt:
        return "green"
    if max_attempts and attempt >= ATTEMPT_RED:
        return "red"
    if max_attempts and attempt >= ATTEMPT_AMBER:
        return "amber"
    return "green"


def serialize_state():
    """Return a JSON-friendly dict combining session metadata and per-skill
    derived state. The browser-side JS DOM-updates against this; nothing
    in the front end re-derives. Computing everything here once keeps the
    server authoritative."""
    session = discover_session()
    skills = gather_state()
    out_skills = []
    has_active = False
    for s in skills:
        prog = s["progress"]
        st_map = s.get("should_trigger_map", {})

        # Per-run pass/fail decisions for the segmented bar.
        # Pass = correct trigger or correct decline. If a row's truncated
        # query isn't in should_trigger_map, fall back to assuming the
        # row is correctly classified -- best-effort, the dashboard
        # should never show "missing data" for a finished run.
        seg_classes = []
        passes = 0
        fails = 0
        for r in s.get("all_rows") or []:
            qkey = r["query"][:60]
            should = st_map.get(qkey, True)
            if r["triggered"] == should:
                seg_classes.append("pass")
                passes += 1
            else:
                seg_classes.append("fail")
                fails += 1
        total_segs = s.get("expected_total_runs") or len(seg_classes)
        while len(seg_classes) < total_segs:
            seg_classes.append("pending")

        # Per-query verdict (eval semantics): query passes if trigger
        # rate >= 0.5.
        per_query = {}
        for r in s.get("all_rows") or []:
            qkey = r["query"][:60]
            should = st_map.get(qkey, True)
            per_query.setdefault(qkey, []).append(r["triggered"] == should)
        qpass = sum(1 for results in per_query.values()
                    if sum(results) / len(results) >= 0.5)
        qtotal = len(per_query)

        active = []
        for a in s["active"]:
            color = "green"
            attempt_str = None
            if a["latest_attempt"]:
                color = color_for_attempt(a["latest_attempt"],
                                          a["max_retries_field"])
                attempt_str = f"{a['latest_attempt']}/{a['max_retries_field']}"
            rt = a["runtime_s"]
            rt_str = f"{rt//60}m{rt%60:02d}s" if rt >= 60 else f"{rt}s"
            active.append({
                "claude_pid": a["claude_pid"],
                "runtime_str": rt_str,
                "total_retries": a["total_retries"],
                "attempt_str": attempt_str,
                "attempt_color": color,
                "last_error": a["last_error"],
            })

        recent = []
        for r in s.get("recent") or []:
            qkey = r["query"][:60]
            should = st_map.get(qkey, True)
            recent.append({
                "n": r["n"],
                "passed": r["triggered"] == should,
                "first_tool": r["first_tool"],
                "first_skill": r["first_skill"],
                "elapsed": r.get("elapsed"),
                "retries": r.get("retries"),
                "query": r["query"][:80],
            })

        out_skills.append({
            "skill": s["skill"],
            "live": s["live"],
            "progress_str": (f"{prog['done']}/{prog['total']}"
                             if prog and prog["total"] else "?"),
            "active_subprocs": s["active_subprocs"],
            "in_flight_retries": s["in_flight_retries"],
            "qpass": qpass,
            "qtotal": qtotal,
            "seg_classes": seg_classes,
            "active": active,
            "recent": recent,
        })
        if s["active_subprocs"] > 0:
            has_active = True

    return {
        "session": {
            "uuid": session["uuid"],
            "uuid_short": (session["uuid"][:8] + "..."
                           if session["uuid"] else None),
            "name": session["name"],
            "source": session["source"],
        },
        "skills": out_skills,
        "has_active": has_active,
        "updated_at": time.strftime("%H:%M:%S"),
    }


# ---------- static HTML shell ----------

# CSS + JS shell served once at GET /. Subsequent updates flow through
# /api/state.json without page reloads, so scroll position and any
# expanded UI state survives.
SHELL_HTML = """<!doctype html>
<html><head><meta charset='utf-8'>
<title>probe-eval monitor</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px;
       background: #0e1116; color: #e6edf3; }
h1 { font-size: 18px; margin: 0 0 8px 0; display: flex; align-items: center;
     gap: 10px; }
.session-name { font-family: ui-monospace, Menlo, monospace; color: #58a6ff; }
.meta { color: #8b949e; font-size: 12px; margin-bottom: 20px;
        display: flex; align-items: center; gap: 12px; }
.skill { background: #161b22; border-radius: 8px; padding: 14px 16px;
         margin-bottom: 14px; border: 1px solid #30363d; }
.skill-head { display: flex; justify-content: space-between; align-items: center;
              margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
.skill-name { font-weight: 600; font-size: 14px; display: flex;
              align-items: center; gap: 6px; flex-wrap: wrap; }
.skill-stats { font-size: 12px; color: #8b949e; }
.bar { height: 14px; background: #21262d; border-radius: 4px; overflow: hidden;
       margin: 6px 0 10px 0; display: flex; gap: 1px; }
.bar-seg { flex: 1; background: #21262d; }
.bar-seg.pass { background: #2ea043; }
.bar-seg.fail { background: #f85149; }
.bar-seg.pending { background: #21262d; }
table { width: 100%; border-collapse: collapse; font-size: 12px;
        font-family: ui-monospace, Menlo, monospace; }
th, td { padding: 4px 10px; text-align: left; border-bottom: 1px solid #21262d; }
th { color: #8b949e; font-weight: 500; font-size: 11px; text-transform: uppercase;
     letter-spacing: 0.5px; }
.tag { display: inline-block; padding: 2px 6px; border-radius: 3px;
       font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
.tag.green { background: #1f5b35; color: #7ee2a4; }
.tag.amber { background: #5a4017; color: #f0c674; }
.tag.red { background: #5b1d1d; color: #ff8b8b; }
.tag.gray { background: #2a2f37; color: #8b949e; }
.empty { color: #8b949e; font-style: italic; padding: 12px 0; }
.recent-head { color: #8b949e; font-size: 11px; text-transform: uppercase;
               letter-spacing: 0.5px; margin: 16px 0 6px 0; }
button { background: #21262d; color: #e6edf3; border: 1px solid #30363d;
         border-radius: 4px; padding: 4px 10px; font-size: 11px;
         cursor: pointer; font-family: inherit; }
button:hover { background: #30363d; }
.status-dot { display: inline-block; width: 8px; height: 8px;
              border-radius: 50%; }
.status-dot.live { background: #2ea043; }
.status-dot.idle { background: #8b949e; }
.status-dot.stopped { background: #f85149; }
</style></head>
<body>
<h1>probe-eval monitor <span id='session' class='session-name'>...</span></h1>
<div class='meta'>
  <span><span id='status-dot' class='status-dot idle'></span>
    <span id='status-label'>connecting...</span></span>
  <span>updated <span id='updated-at'>--:--:--</span></span>
  <span>poll <span id='poll-cadence'>every ?s</span></span>
  <button id='refresh-now'>refresh now</button>
</div>
<div id='content'><div class='empty'>Loading...</div></div>

<script>
const ACTIVE_INTERVAL_MS = 5000;
const IDLE_INTERVAL_MS = 30000;
const IDLE_POLLS_BEFORE_PAUSE = 6;  // ~3 min of idle = stop polling

const $session = document.getElementById('session');
const $statusDot = document.getElementById('status-dot');
const $statusLabel = document.getElementById('status-label');
const $updatedAt = document.getElementById('updated-at');
const $cadence = document.getElementById('poll-cadence');
const $content = document.getElementById('content');
const $refresh = document.getElementById('refresh-now');

let pollTimer = null;
let idleStreak = 0;
let lastSig = '';
let stopped = false;

function el(tag, attrs={}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function tag(cls, text) {
  return el('span', {class: 'tag ' + cls, text});
}

function renderSession(sess) {
  if (!sess.uuid) {
    $session.textContent = '(no session)';
    return;
  }
  const label = sess.name ? sess.name : sess.uuid_short;
  const sourceLabel = {
    'explicit': '--session',
    'current': 'current session',
    'live-probe-eval': 'live probe-eval',
    'recent': 'recent fallback',
  }[sess.source] || sess.source;
  $session.replaceChildren(
    document.createTextNode(label),
    el('span', {class: 'tag gray', text: sourceLabel,
                style: 'margin-left: 8px; vertical-align: middle;'}),
  );
}

function renderSkill(s) {
  const head = el('div', {class: 'skill-head'},
    el('div', {class: 'skill-name'},
      document.createTextNode(s.skill),
      tag(s.live ? 'green' : 'amber', s.live ? 'live' : 'finished'),
      s.qtotal > 0
        ? tag(s.qpass === s.qtotal ? 'green' : 'red',
              `${s.qpass}/${s.qtotal} queries pass`)
        : null,
    ),
    el('div', {class: 'skill-stats',
               text: `${s.progress_str} done | ${s.active_subprocs} active | `
                     + `${s.in_flight_retries} in-flight retries`}),
  );

  const bar = el('div', {class: 'bar'});
  for (const c of s.seg_classes) {
    bar.appendChild(el('div', {class: 'bar-seg ' + c}));
  }

  const children = [head, bar];

  if (s.active.length) {
    const tbl = el('table',
      {},
      el('thead', {}, el('tr', {},
        el('th', {text: 'claude pid'}), el('th', {text: 'runtime'}),
        el('th', {text: 'retries'}), el('th', {text: 'latest attempt'}),
        el('th', {text: 'last error'}),
      )),
      el('tbody'),
    );
    const tbody = tbl.querySelector('tbody');
    for (const a of s.active) {
      tbody.appendChild(el('tr', {},
        el('td', {text: String(a.claude_pid)}),
        el('td', {text: a.runtime_str}),
        el('td', {text: String(a.total_retries)}),
        el('td', {}, a.attempt_str
          ? tag(a.attempt_color, a.attempt_str)
          : document.createTextNode('\u2014')),
        el('td', {text: a.last_error || '\u2014'}),
      ));
    }
    children.push(tbl);
  } else {
    children.push(el('div', {class: 'empty', text: 'No active subprocesses.'}));
  }

  if (s.recent.length) {
    children.push(el('div', {class: 'recent-head', text: 'Recent completions'}));
    const tbl = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {text: 'n'}), el('th', {text: 'verdict'}),
        el('th', {text: 'first tool'}), el('th', {text: 'first skill'}),
        el('th', {text: 'elapsed'}), el('th', {text: 'retries'}),
        el('th', {text: 'query'}),
      )),
      el('tbody'),
    );
    const tbody = tbl.querySelector('tbody');
    for (const r of s.recent) {
      const elapsedTxt = (r.elapsed == null) ? '\u2014'
                        : (r.elapsed < 60 ? r.elapsed.toFixed(1) + 's'
                                          : Math.floor(r.elapsed / 60) + 'm' + String(Math.floor(r.elapsed % 60)).padStart(2, '0') + 's');
      const retriesTxt = (r.retries == null) ? '\u2014' : String(r.retries);
      tbody.appendChild(el('tr', {},
        el('td', {text: String(r.n)}),
        el('td', {}, tag(r.passed ? 'green' : 'red', r.passed ? 'pass' : 'fail')),
        el('td', {text: r.first_tool || '\u2014'}),
        el('td', {text: r.first_skill || '\u2014'}),
        el('td', {text: elapsedTxt}),
        el('td', {text: retriesTxt}),
        el('td', {text: r.query}),
      ));
    }
    children.push(tbl);
  }

  return el('div', {class: 'skill'}, ...children);
}

function render(state) {
  renderSession(state.session);
  $updatedAt.textContent = state.updated_at;
  if (!state.skills.length) {
    $content.replaceChildren(el('div', {class: 'empty',
                                        text: 'No probe-eval runs in flight.'}));
    return;
  }
  // Diff-replace by skill name -- if the skill list & order match the
  // existing DOM, mutate in place to preserve scroll & focus. Otherwise
  // just rebuild.
  const existing = Array.from($content.querySelectorAll('.skill'))
    .map(n => n.dataset.skill);
  const incoming = state.skills.map(s => s.skill);
  if (existing.length === incoming.length
      && existing.every((n, i) => n === incoming[i])) {
    const nodes = $content.querySelectorAll('.skill');
    state.skills.forEach((s, i) => {
      const fresh = renderSkill(s);
      fresh.dataset.skill = s.skill;
      nodes[i].replaceWith(fresh);
    });
  } else {
    $content.replaceChildren(...state.skills.map(s => {
      const node = renderSkill(s);
      node.dataset.skill = s.skill;
      return node;
    }));
  }
}

function setStatus(state) {
  if (stopped) {
    $statusDot.className = 'status-dot stopped';
    $statusLabel.textContent = 'paused';
    $cadence.textContent = '(click refresh to resume)';
    return;
  }
  const interval = state && state.has_active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
  $statusDot.className = 'status-dot ' + (state && state.has_active ? 'live' : 'idle');
  $statusLabel.textContent = state && state.has_active ? 'live runs' : 'idle';
  $cadence.textContent = `every ${interval / 1000}s`;
}

async function poll() {
  try {
    const r = await fetch('/api/state.json', {cache: 'no-store'});
    if (!r.ok) throw new Error(r.statusText);
    const state = await r.json();
    render(state);
    const sig = JSON.stringify({
      uuid: state.session.uuid,
      n: state.skills.map(s => [s.skill, s.progress_str, s.active_subprocs]),
    });
    const changed = sig !== lastSig;
    lastSig = sig;
    if (state.has_active || changed) {
      idleStreak = 0;
    } else {
      idleStreak += 1;
    }
    setStatus(state);

    if (idleStreak >= IDLE_POLLS_BEFORE_PAUSE) {
      stopped = true;
      setStatus(state);
      return;
    }
    const next = state.has_active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    pollTimer = setTimeout(poll, next);
  } catch (err) {
    $statusDot.className = 'status-dot stopped';
    $statusLabel.textContent = 'fetch failed: ' + err.message;
    pollTimer = setTimeout(poll, IDLE_INTERVAL_MS);
  }
}

$refresh.addEventListener('click', () => {
  stopped = false;
  idleStreak = 0;
  if (pollTimer) clearTimeout(pollTimer);
  poll();
});

poll();
</script>
</body></html>
"""


# ---------- HTTP server ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            body = SHELL_HTML.encode("utf-8")
            ctype = "text/html; charset=utf-8"
        elif self.path == "/api/state.json":
            body = json.dumps(serialize_state()).encode("utf-8")
            ctype = "application/json; charset=utf-8"
        elif self.path == "/healthz":
            body = b"ok"
            ctype = "text/plain"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def serve(port, open_browser=False):
    import webbrowser
    url = f"http://localhost:{port}"
    print(f"probe-eval monitor on {url}")
    print(f"(JS polling: 5s when active, 30s when idle, pauses after "
          f"~3 min idle; ctrl-c to stop)")
    server = HTTPServer(("127.0.0.1", port), Handler)
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping.", file=sys.stderr)
    finally:
        server.server_close()


# ---------- one-shot CLI ----------

def cli_summary():
    skills = gather_state()
    if not skills:
        print("No probe-eval runs in flight.")
        return 0
    print(f"=== probe-eval monitor at {time.strftime('%H:%M:%S')} ===")
    grand_active = 0
    grand_retries = 0
    for s in skills:
        prog = s["progress"]
        prog_str = (f"{prog['done']}/{prog['total']}"
                    if prog and prog["total"] else "?")
        print(f"\n[{s['skill']}] python pid {s['python_pid']}: "
              f"{s['active_subprocs']} active, progress {prog_str}")
        for a in s["active"]:
            attempt_str = (f" attempt {a['latest_attempt']}/{a['max_retries_field']}"
                           f" ({a['last_error']})" if a["latest_attempt"] else "")
            print(f"  pid {a['claude_pid']:6d}  {a['runtime_s']:>5}s  "
                  f"retries={a['total_retries']}{attempt_str}")
        grand_active += s["active_subprocs"]
        grand_retries += s["in_flight_retries"]
    print(f"\nTotal active claude subprocesses: {grand_active}")
    print(f"Total in-flight api_retry events: {grand_retries}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", nargs="?", default="cli", choices=["cli", "serve"])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument(
        "--session",
        help="Pin the dashboard to a specific Claude Code session: "
             "full UUID, UUID prefix (>=4 hex chars), or the name set "
             "via /rename. Without --session the dashboard auto-detects "
             "the current session.",
    )
    ap.add_argument(
        "--open",
        action="store_true",
        dest="open_browser",
        help="Open the dashboard URL in the default browser after the "
             "server starts. Only meaningful in `serve` mode.",
    )
    args = ap.parse_args()
    if args.session:
        global _explicit_session_arg
        _explicit_session_arg = args.session
        # Validate up front so the user gets immediate feedback.
        rec = discover_session()
        if not rec["tasks_dir"]:
            print(f"error: no Claude Code session matched --session "
                  f"{args.session!r}", file=sys.stderr)
            return 2
        label = rec["name"] or rec["uuid"] or "(unknown)"
        print(f"--session {args.session!r} -> {label} ({rec['uuid']})",
              file=sys.stderr)
    if args.mode == "serve":
        serve(args.port, open_browser=args.open_browser)
    else:
        return cli_summary()


if __name__ == "__main__":
    raise SystemExit(main())
