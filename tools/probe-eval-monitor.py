#!/usr/bin/env python3
"""Read-only dashboard for in-flight probe-eval runs.

Walks the system process table for `tools/probe-eval.py` workers, finds
their open stream-json tempfiles via lsof, and renders a live HTML
dashboard backed by `http.server` (stdlib only -- no pip install).

Usage:
  # one-shot CLI summary
  python3 tools/probe-eval-monitor.py

  # http dashboard at http://localhost:8765
  python3 tools/probe-eval-monitor.py serve [--port 8765]

The serve mode emits one HTML page that auto-refreshes every 5 seconds
via a meta tag. Doesn't disturb the running probe-evals.
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
    r"first_skill=(?P<skill>\S+):\s+(?P<query>.*)$"
)


SESSION_MAX_AGE_HOURS = float(
    __import__("os").environ.get("DASHBOARD_MAX_AGE_HOURS", "4")
)


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


def detect_session_dir_from_self():
    """Look at THIS process's bash parent. When launched as a Claude
    Code background task, the parent bash has `tasks/<my-id>.output`
    open at fd 1 -- that's a dispositive anchor for the session's
    tasks/ dir. Returns None when launched some other way (e.g. from
    a regular terminal)."""
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
    """Fallback: youngest .output file under any `claude-*/*/*/tasks/`
    glob within the SESSION_MAX_AGE_HOURS window. Returns its parent
    (tasks/ dir) so finished runs stay visible briefly after exit, but
    stale .output files from older sessions age out and don't surface
    as "this session"."""
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


def discover_task_dirs():
    """Resolve the single session tasks/ dir to walk. Returns a one-Path
    list (or empty if no signal). Layered signals, most-precise first:

    1. Self -- our own bash parent's open .output. Works when the
       dashboard is launched as a Claude Code background task and is
       strictly session-scoped (our parent only knows about our session).
    2. Live probe-eval -- a running probe-eval's bash parent. Works when
       the dashboard is launched from a regular terminal alongside an
       in-flight eval.
    3. Recent fallback -- youngest .output globally, within
       SESSION_MAX_AGE_HOURS. Stale runs from older sessions age out;
       set DASHBOARD_MAX_AGE_HOURS to change the window. After the
       window expires the dashboard says "no runs" instead of showing
       arbitrary historical data.
    """
    d = (detect_session_dir_from_self() or
         detect_session_dir_from_probe_eval() or
         detect_session_dir_from_recent())
    return [d] if d else []


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


# ---------- HTML rendering ----------

CSS = """
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px;
       background: #0e1116; color: #e6edf3; }
h1 { font-size: 18px; margin: 0 0 8px 0; }
h2 { font-size: 15px; margin: 24px 0 6px 0; color: #58a6ff; }
.meta { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
.skill { background: #161b22; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px;
         border: 1px solid #30363d; }
.skill-head { display: flex; justify-content: space-between; align-items: center;
              margin-bottom: 8px; }
.skill-name { font-weight: 600; font-size: 14px; }
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
.tag { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px;
       font-family: ui-monospace, Menlo, monospace; }
.tag.green { background: #1f5b35; color: #7ee2a4; }
.tag.amber { background: #5a4017; color: #f0c674; }
.tag.red { background: #5b1d1d; color: #ff8b8b; }
.empty { color: #8b949e; font-style: italic; padding: 12px 0; }
.recent-head { color: #8b949e; font-size: 11px; text-transform: uppercase;
               letter-spacing: 0.5px; margin: 16px 0 6px 0; }
"""


def color_for_attempt(attempt, max_attempts):
    if not attempt:
        return "green"
    if max_attempts and attempt >= ATTEMPT_RED:
        return "red"
    if max_attempts and attempt >= ATTEMPT_AMBER:
        return "amber"
    return "green"


def color_for_retry_rate(retries, calls):
    if calls == 0:
        return "green"
    rate = retries / calls
    if rate >= RETRY_RATE_RED:
        return "red"
    if rate >= RETRY_RATE_AMBER:
        return "amber"
    return "green"


def render_html(skills):
    parts = [
        f"<!doctype html><html><head><meta charset='utf-8'>",
        f"<meta http-equiv='refresh' content='{REFRESH_SECONDS}'>",
        f"<title>probe-eval monitor</title>",
        f"<style>{CSS}</style></head><body>",
        f"<h1>probe-eval monitor</h1>",
        f"<div class='meta'>auto-refresh every {REFRESH_SECONDS}s &mdash; "
        f"updated {time.strftime('%H:%M:%S')}</div>",
    ]
    if not skills:
        parts.append("<div class='empty'>No probe-eval runs in flight.</div>")
    for s in skills:
        prog = s["progress"]
        if prog and prog["total"]:
            done_str = f"{prog['done']}/{prog['total']}"
        else:
            done_str = "?"

        # Per-run pass/fail decisions for the segmented bar.
        # Pass = correct trigger or correct decline. should_trigger map
        # comes from the eval JSON; if a row's truncated query isn't in
        # the map, fall back to assuming the row is correctly classified
        # (best-effort -- the dashboard should never show "missing data"
        # for a finished run).
        st_map = s.get("should_trigger_map", {})
        passes = 0
        fails = 0
        seg_classes = []
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

        live_tag = (" <span class='tag green'>live</span>"
                    if s["live"] else " <span class='tag amber'>finished</span>")

        # Per-query verdict (eval semantics): a query passes if its
        # trigger rate >= 0.5. Group rows by query, decide per-query.
        verdict_tag = ""
        if not s["live"]:
            per_query = {}  # query (60-char key) -> [pass_bools]
            for r in s.get("all_rows") or []:
                qkey = r["query"][:60]
                should = st_map.get(qkey, True)
                per_query.setdefault(qkey, []).append(r["triggered"] == should)
            qpass = 0
            qtotal = 0
            for qkey, results in per_query.items():
                qtotal += 1
                if sum(results) / len(results) >= 0.5:
                    qpass += 1
            if qtotal:
                cls = "green" if qpass == qtotal else "red"
                verdict_tag = (f" <span class='tag {cls}'>"
                               f"{qpass}/{qtotal} queries pass</span>")

        parts.append(
            f"<div class='skill'>"
            f"<div class='skill-head'>"
            f"<div class='skill-name'>{html.escape(s['skill'])}{live_tag}{verdict_tag}</div>"
            f"<div class='skill-stats'>{done_str} done &middot; "
            f"{s['active_subprocs']} active &middot; "
            f"{s['in_flight_retries']} in-flight retries</div>"
            f"</div>"
        )
        parts.append("<div class='bar'>")
        for cls in seg_classes:
            parts.append(f"<div class='bar-seg {cls}'></div>")
        parts.append("</div>")
        if s["active"]:
            parts.append(
                "<table><thead><tr>"
                "<th>claude pid</th><th>runtime</th>"
                "<th>retries</th><th>latest attempt</th><th>last error</th>"
                "</tr></thead><tbody>"
            )
            for a in s["active"]:
                attempt_str = "&mdash;"
                color = "green"
                if a["latest_attempt"]:
                    attempt_str = f"{a['latest_attempt']}/{a['max_retries_field']}"
                    color = color_for_attempt(a["latest_attempt"],
                                              a["max_retries_field"])
                err_str = html.escape(a["last_error"]) if a["last_error"] else "&mdash;"
                rt = a["runtime_s"]
                rt_str = f"{rt//60}m{rt%60:02d}s" if rt >= 60 else f"{rt}s"
                parts.append(
                    f"<tr>"
                    f"<td>{a['claude_pid']}</td>"
                    f"<td>{rt_str}</td>"
                    f"<td>{a['total_retries']}</td>"
                    f"<td><span class='tag {color}'>{attempt_str}</span></td>"
                    f"<td>{err_str}</td>"
                    f"</tr>"
                )
            parts.append("</tbody></table>")
        else:
            parts.append("<div class='empty'>No active subprocesses.</div>")
        if s.get("recent"):
            parts.append("<div class='recent-head'>Recent completions</div>")
            parts.append(
                "<table><thead><tr>"
                "<th>n</th><th>verdict</th><th>first tool</th>"
                "<th>first skill</th><th>query</th>"
                "</tr></thead><tbody>"
            )
            for r in s["recent"]:
                qkey = r["query"][:60]
                should = st_map.get(qkey, True)
                if r["triggered"] == should:
                    verdict = "<span class='tag green'>pass</span>"
                else:
                    verdict = "<span class='tag red'>fail</span>"
                tool = r["first_tool"] or "&mdash;"
                fs = r["first_skill"] or "&mdash;"
                query_short = html.escape(r["query"][:80])
                parts.append(
                    f"<tr>"
                    f"<td>{r['n']}</td>"
                    f"<td>{verdict}</td>"
                    f"<td>{html.escape(tool) if tool != '&mdash;' else tool}</td>"
                    f"<td>{html.escape(fs) if fs != '&mdash;' else fs}</td>"
                    f"<td>{query_short}</td>"
                    f"</tr>"
                )
            parts.append("</tbody></table>")
        parts.append("</div>")
    parts.append("</body></html>")
    return "".join(parts)


# ---------- HTTP server ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        skills = gather_state()
        body = render_html(skills).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(port):
    print(f"probe-eval monitor on http://localhost:{port}")
    print(f"(auto-refreshes every {REFRESH_SECONDS}s; ctrl-c to stop)")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


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
    args = ap.parse_args()
    if args.mode == "serve":
        serve(args.port)
    else:
        return cli_summary()


if __name__ == "__main__":
    raise SystemExit(main())
