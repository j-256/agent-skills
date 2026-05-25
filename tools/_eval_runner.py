"""Shared eval-runner library for trigger-eval.py and synthesis-eval.py.

Owns: ProcessPoolExecutor dispatch, abort-on-first-timeout, the canonical
stderr progress line, the startup banner, the results-JSON envelope,
fixture-id assignment with collision detection, worktree-isolation
detect+restore around each spawn.

Does NOT own: fixture schemas, scoring (trigger vs. assertion), per-kind
defaults, transcript JSONL persistence (synthesis-only behavior toggled
by the harness passing transcript_dir=Path).

Each harness imports run_eval and supplies kind-specific callbacks
(see tools/trigger-eval.py and tools/synthesis-eval.py for examples).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _env import load_dotenv
from _retry_aware_subprocess import run_with_retry_aware_bail

load_dotenv()
EVAL_MODEL = os.environ.get("DSC_EVAL_MODEL", "sonnet")

# Toolbelt profiles for `claude -p`. The default profile inherits whatever
# MCP servers and built-in tools the user's session has wired up, which on
# this machine includes Agent (researcher subagent), several MCP search
# servers (mcp-adaptor, plugin_search, plugin_google), and other alternates
# that bypass a skill's bundled scripts. The restricted profile mirrors a
# vanilla install: no MCP servers, no Agent, only the built-in tools a
# skill author can rely on. See iteration-eval-environment-artifact for
# the diagnosis driving this knob.
PROFILE_FLAGS = {
    "default": [],
    "restricted": [
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--disallowedTools", "Agent",
    ],
}


class FixtureSchemaError(Exception):
    pass


def assign_fixture_ids(fixtures, get_name):
    """Return [(fixture_id, fixture)] in input order.

    fixture_id = get_name(fixture) if it returns a non-empty string,
    else the lowest-unused 'qN' slot. Raises FixtureSchemaError on
    duplicate explicit names.
    """
    explicit = []
    explicit_set = set()
    for fx in fixtures:
        name = get_name(fx)
        if isinstance(name, str) and name:
            if name in explicit_set:
                raise FixtureSchemaError(f"duplicate fixture name: {name!r}")
            explicit_set.add(name)
            explicit.append(name)
        else:
            explicit.append(None)
    result = []
    next_idx = 0
    for fx, name in zip(fixtures, explicit):
        if name is not None:
            result.append((name, fx))
            continue
        while f"q{next_idx}" in explicit_set:
            next_idx += 1
        fid = f"q{next_idx}"
        result.append((fid, fx))
        explicit_set.add(fid)
        next_idx += 1
    return result


QUERY_DISPLAY_MAX = 80


PROGRESS_LINE_RE = re.compile(
    r"\[(?P<n>\d+)/(?P<total>\d+)\]\s+"
    r"kind=(?P<kind>trigger|synthesis)\s+"
    r"pass=(?P<pass_>True|False)\s+"
    r"fixture_id=(?P<fixture_id>\S+)\s+"
    r"run=(?P<run>\d+)\s+"
    r"elapsed=(?P<elapsed>[\d.]+)s\s+"
    r"retries=(?P<retries>\d+)\s+"
    r"timeout_reason=(?P<timeout_reason>none|retry_budget|wall_clock)\s+"
    r"first_tool=(?P<first_tool>\S+)\s+"
    r"first_skill=(?P<first_skill>\S+)\s+"
    r"failed_asserts=(?P<failed_asserts>\d+)"
    # contaminated= is optional so the regex stays byte-identical with
    # the monitor's copy and parses log files written before
    # iteration-eval-harness-worktree-isolation added the field. The
    # runner's emitter ALWAYS includes the field on lines this version
    # produces, so the optional group fires for current-runner output;
    # absence only happens when re-parsing older logs.
    r"(?:\s+contaminated=(?P<contaminated>True|False))?"
    r":\s+(?P<query>.*)$"
)


def _format_progress(*, n, total, kind, pass_, fixture_id, run_idx,
                     elapsed_seconds, total_retries, timeout_reason,
                     first_tool, first_skill, failed_asserts,
                     contaminated, query):
    """Single source of truth for the canonical stderr progress line.

    The monitor parses this with PROGRESS_LINE_RE. Fields are KV-pair
    style for human readability when tailing logs; switching to JSONL
    later is a single function-body change.

    All trailing diagnostic fields (timeout_reason, first_tool,
    first_skill, failed_asserts, contaminated) are required on every
    line. Sentinel values for fields that don't apply to a given kind:
      - timeout_reason="none" when no timeout
      - first_tool="-" / first_skill="-" when no tool was used
      - failed_asserts=0 for trigger runs (which have no assertions)
        and for synthesis runs where every assertion passed
      - contaminated=True iff the spawn left the worktree dirtier than
        it found it (eval-Sonnet edited a tracked source file or
        created a new untracked file). A True value means the run's
        pass verdict is unaudited.
    """
    q_disp = query.replace("\n", " ")[:QUERY_DISPLAY_MAX]
    return (
        f"[{n}/{total}] "
        f"kind={kind} "
        f"pass={pass_} "
        f"fixture_id={fixture_id} "
        f"run={run_idx} "
        f"elapsed={elapsed_seconds}s "
        f"retries={total_retries} "
        f"timeout_reason={timeout_reason} "
        f"first_tool={first_tool} "
        f"first_skill={first_skill} "
        f"failed_asserts={failed_asserts} "
        f"contaminated={contaminated}"
        f": {q_disp}"
    )


STARTUP_BANNER_RE = re.compile(
    r"^\s*=== eval starting: "
    r"kind=(?P<kind>trigger|synthesis)\s+"
    r"skill=(?P<skill>\S+)\s+"
    r"eval=(?P<eval>\S+)\s+"
    r"runs=(?P<runs>\d+)\s+"
    r"workers=(?P<workers>\d+)\s+"
    r"total_fixtures=(?P<total_fixtures>\d+)\s*===",
    re.MULTILINE,
)


def format_startup_banner(*, kind, skill, eval_path, runs, workers,
                          total_fixtures):
    """The runner emits this to stderr before the first task completes.

    eval-monitor.py parses it from each .output file to bind finished
    runs to (skill, kind) without inferring from now-removed
    'first_skill=' fields. total_fixtures lets the dashboard render an
    authoritative qpass denominator from the start of the run, before
    any rows have arrived.
    """
    return (
        f"=== eval starting: "
        f"kind={kind} "
        f"skill={skill} "
        f"eval={eval_path} "
        f"runs={runs} "
        f"workers={workers} "
        f"total_fixtures={total_fixtures} ==="
    )


def _git_dirty_set(cwd):
    """Return the set of repo-relative paths git considers dirty in `cwd`
    (modified, added, deleted, renamed, untracked-not-gitignored).

    Uses `git status --porcelain=v1 -z` for unambiguous parsing: NUL
    separators tolerate spaces and renames in path names. Each record
    is `XY <path>` where XY is the two-character status code; rename
    records (`R <to>` followed by `<from>` in a separate NUL-delimited
    field) yield both `to` and `from` so a rename from one tracked path
    to another is fully captured by the snapshot.

    Returns paths as POSIX strings relative to the repo root, NOT to
    `cwd`. The two are the same when cwd is the repo root, which is the
    only configuration the harness supports today.

    A non-zero git exit -- a non-git directory, a corrupt index, a
    permissions error -- raises CalledProcessError. The caller treats
    that as fatal: an eval whose worktree status can't be observed
    cannot honestly claim "no contamination."
    """
    proc = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z"],
        cwd=cwd, capture_output=True, check=True, text=False,
    )
    out = proc.stdout
    paths = set()
    i = 0
    while i < len(out):
        # Find the next NUL.
        j = out.find(b"\x00", i)
        if j == -1:
            break
        record = out[i:j]
        i = j + 1
        if len(record) < 3:
            continue
        status = record[:2]
        path = record[3:].decode("utf-8", errors="replace")
        paths.add(path)
        # Rename records: the second NUL-delimited field is the source
        # path. Both ends should be flagged so an `R skills/old skills/new`
        # is detected even if the operator's baseline didn't include
        # either.
        if status[:1] in (b"R", b"C"):
            j2 = out.find(b"\x00", i)
            if j2 == -1:
                break
            src = out[i:j2].decode("utf-8", errors="replace")
            paths.add(src)
            i = j2 + 1
    return paths


def _git_repo_root(cwd):
    """Resolve the repo root containing `cwd`. Raises CalledProcessError
    if cwd is not inside a git work tree."""
    proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=cwd, capture_output=True, check=True, text=True,
    )
    return proc.stdout.strip()


def _restore_worktree_paths(repo_root, paths):
    """Best-effort restore: `git checkout HEAD --` for tracked paths,
    unlink for newly-appeared untracked paths. Returns the list of paths
    that could NOT be restored (caller surfaces these in the result).

    The two-step shape matters because `git checkout` on an untracked
    path is a no-op (no index entry to restore from), and `unlink` on a
    tracked-but-modified path would silently destroy the operator's
    pristine version. This split honors the actual semantics:
    "contamination delta" = (modifications to tracked) + (newly-created
    untracked) -- each remediated by the matching primitive.

    `paths` is the set of contamination-delta paths returned by
    _diff_dirty_sets; an operator's pre-existing dirty files are NOT in
    that set and so are not touched here.
    """
    failures = []
    if not paths:
        return failures
    # Bucket: tracked-modified vs. newly-untracked. `git ls-files` (no
    # flags) lists the index; a path absent from the index is untracked.
    proc = subprocess.run(
        ["git", "ls-files", "--", *sorted(paths)],
        cwd=repo_root, capture_output=True, check=False, text=True,
    )
    tracked = set(proc.stdout.splitlines()) if proc.returncode == 0 else set()
    untracked = paths - tracked

    if tracked:
        proc = subprocess.run(
            ["git", "checkout", "HEAD", "--", *sorted(tracked)],
            cwd=repo_root, capture_output=True, check=False, text=True,
        )
        if proc.returncode != 0:
            failures.extend(sorted(tracked))

    for rel in sorted(untracked):
        try:
            os.unlink(os.path.join(repo_root, rel))
        except FileNotFoundError:
            # Already gone -- harmless, the contamination self-cleared.
            pass
        except OSError:
            failures.append(rel)
    return failures


def _diff_dirty_sets(before, after):
    """Return paths that became dirty between `before` and `after`
    snapshots. Paths the operator already had dirty before the run
    (their in-flight work) are subtracted: only newly-dirty paths
    count as contamination."""
    return after - before


def _spawn_and_bail(query, transcript_path, timeout, cwd):
    """Run claude -p with the canonical command line. Returns the bail
    dict from run_with_retry_aware_bail with two extra keys:
      - worktree_contaminated (bool): paths went dirty during the run
        beyond the operator's pre-existing baseline.
      - worktree_changed_paths (list[str]): the contamination-delta
        paths, repo-relative, sorted; empty when not contaminated.
      - worktree_restore_failures (list[str]): paths the auto-restore
        could not revert (operator must clean by hand). Empty on a
        successful restore or on a clean run.

    Worktree isolation: a snapshot of `git status --porcelain` runs
    before and after the spawn. Anything that became dirty during the
    spawn is restored (`git checkout HEAD --` for tracked, unlink for
    newly-created untracked). The flag and the path list propagate up
    through _run_one_task into the per-run result dict so the harness
    can mark the run unaudited.

    Why per-spawn, not once at run_eval entry: with N parallel workers,
    one worker's contamination would leak into another worker's clean
    measurement if the snapshot/restore cycle weren't local to each
    spawn. Per-spawn pays N git-status invocations but keeps each
    worker's measurement self-consistent. See
    iteration-eval-harness-worktree-isolation for the design rationale.
    """
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    profile = os.environ.get("DSC_EVAL_PROFILE", "default")
    if profile not in PROFILE_FLAGS:
        raise ValueError(
            f"unknown DSC_EVAL_PROFILE {profile!r}; "
            f"must be one of {sorted(PROFILE_FLAGS)}"
        )
    cmd = [
        "claude",
        "-p", query,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", EVAL_MODEL,
        # bypassPermissions: without this, Skill invocations under `claude -p`
        # return is_error: true content="Execute skill: <name>" (the
        # permission-prompt body, fired in non-interactive mode). The model
        # sometimes recovers via a Read fallback on SKILL.md but
        # not deterministically – iteration-harness-skill-load-determinism
        # observed 5/5 passes when SKILL.md loaded vs. freelance from
        # training data when it didn't. Applies globally to both profiles.
        "--permission-mode", "bypassPermissions",
        *PROFILE_FLAGS[profile],
    ]

    repo_root = _git_repo_root(cwd)
    before = _git_dirty_set(repo_root)
    bail = run_with_retry_aware_bail(cmd, transcript_path, env, cwd, timeout)
    after = _git_dirty_set(repo_root)
    delta = _diff_dirty_sets(before, after)
    if delta:
        restore_failures = _restore_worktree_paths(repo_root, delta)
        bail["worktree_contaminated"] = True
        bail["worktree_changed_paths"] = sorted(delta)
        bail["worktree_restore_failures"] = restore_failures
    else:
        bail["worktree_contaminated"] = False
        bail["worktree_changed_paths"] = []
        bail["worktree_restore_failures"] = []
    return bail


def _run_one_task(fixture, run_idx, fixture_id, transcript_dir,
                  timeout, cwd, get_query, score_run):
    """Worker entry point: spawn one claude -p, score, return per-run dict.

    transcript_dir=None -> tempfile that gets unlinked. Otherwise the
    transcript is written to <transcript_dir>/<fixture_id>-<run_idx>.jsonl
    and retained.

    Returns a dict with these keys (the actual contract -- consumers
    access via r["fixture_id"], etc.):
      - fixture_id (str): id assigned by assign_fixture_ids
      - run_idx (int): 1-based run index within the fixture
      - elapsed_seconds (float): wall-clock seconds spent in claude -p
      - total_retries (int): retry count from run_with_retry_aware_bail
      - timed_out (bool): True if retry budget or wall clock tripped
      - timeout_reason (str | None): "retry_budget_exhausted",
        "wall_clock", or None
      - transcript_path (str | None): persisted path when transcript_dir
        was supplied, else None (tempfile already unlinked)
      - pass_ (bool): score_run's pass verdict; auto-False on timeout
      - kind_extra (dict): score_run's free-form per-run payload; empty
        on timeout
      - worktree_contaminated (bool): True if the spawn left the
        worktree dirtier than it found it (eval-Sonnet edited source).
        A contaminated run's pass_ is unaudited regardless of value --
        per-run scoring runs on the contaminated state, not on HEAD.
      - worktree_changed_paths (list[str]): repo-relative paths that
        became dirty during the spawn (post-baseline-subtraction).
      - worktree_restore_failures (list[str]): paths auto-restore
        couldn't revert. Operator must clean by hand if non-empty.
    """
    query = get_query(fixture)
    if transcript_dir is None:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            transcript_path = f.name
        retain = False
    else:
        Path(transcript_dir).mkdir(parents=True, exist_ok=True)
        transcript_path = str(
            Path(transcript_dir) / f"{fixture_id}-{run_idx}.jsonl"
        )
        retain = True

    t0 = time.time()
    try:
        bail = _spawn_and_bail(query, transcript_path, timeout, cwd)
        elapsed = round(time.time() - t0, 2)
        timed_out = bail["retry_budget_exhausted"] or bail["wall_timed_out"]
        if bail["retry_budget_exhausted"]:
            timeout_reason = "retry_budget_exhausted"
        elif bail["wall_timed_out"]:
            timeout_reason = "wall_clock"
        else:
            timeout_reason = None

        if timed_out:
            pass_, kind_extra = False, {}
        else:
            pass_, kind_extra = score_run(fixture, transcript_path, bail)

        return {
            "fixture_id": fixture_id,
            "run_idx": run_idx,
            "elapsed_seconds": elapsed,
            "total_retries": bail.get("total_retries", 0),
            "timed_out": timed_out,
            "timeout_reason": timeout_reason,
            "transcript_path": transcript_path if retain else None,
            "pass_": pass_,
            "kind_extra": kind_extra,
            "worktree_contaminated": bail.get("worktree_contaminated", False),
            "worktree_changed_paths": bail.get("worktree_changed_paths", []),
            "worktree_restore_failures": bail.get(
                "worktree_restore_failures", []
            ),
        }
    finally:
        if not retain:
            try:
                os.unlink(transcript_path)
            except Exception:
                pass


def _pool_target(args_tuple):
    """Top-level pickle target for ProcessPoolExecutor."""
    (fixture, run_idx, fixture_id, transcript_dir, timeout, cwd,
     get_query, score_run) = args_tuple
    return _run_one_task(fixture, run_idx, fixture_id,
                          transcript_dir, timeout, cwd,
                          get_query, score_run)


def run_eval(*, kind, fixtures, get_fixture_id, get_query, score_run,
             summarize, runs_per_fixture, workers, timeout, cwd,
             transcript_dir, summary_label,
             skill_name, eval_path,
             executor_class=ProcessPoolExecutor):
    """Drive the eval. Returns (results_dict, exit_code).

    Caller writes the JSON and propagates exit code.

    Exit codes:
      0 -- all fixtures pass
      1 -- at least one fixture fails
      3 -- aborted on retry-budget exhaustion or wall-clock timeout

    The `summarize` callback receives a list of
    {"fixture_id": str, "fixture": dict, "runs": list[dict]}
    items and must return a list of dicts each carrying a "pass" key.
    The runner counts `not item["pass"]` to determine the success/fail
    exit code, so harnesses MUST include "pass" on every summary item.

    Other kwargs:
      - kind: "trigger" | "synthesis". Emitted on the canonical stderr
        line and in the envelope's `kind` field; the monitor uses it to
        color/label rows.
      - fixtures: list of dicts; opaque to the runner. Length determines
        `total_fixtures` in the envelope and the banner.
      - get_fixture_id: callable (fixture) -> str | None. Non-empty
        string is the explicit id; anything else triggers fallback to
        `qN`. Passed to assign_fixture_ids as `get_name`.
      - get_query: callable (fixture) -> str. The query sent to
        claude -p, also used to format the human-readable tail of each
        progress line.
      - score_run: callable (fixture, transcript_path, bail) ->
        (pass: bool, kind_extra: dict). Runs only on non-timed-out
        completions (timed-out runs auto-fail with empty kind_extra).
        The bail dict comes from run_with_retry_aware_bail. kind_extra
        is the harness's free-form per-run payload; the runner extracts
        `first_tool`, `first_skill`, and `assertion_results` for the
        canonical line if present.
      - runs_per_fixture: int. Total tasks dispatched =
        len(fixtures) * runs_per_fixture.
      - cwd: str. Passed to claude -p subprocesses as their working
        directory.
      - transcript_dir: Path | None. None means each run's transcript
        goes to a tempfile that's unlinked after scoring (trigger-eval
        default); a Path means transcripts persist at
        <transcript_dir>/<fixture_id>-<run_idx>.jsonl for offline
        debugging (synthesis-eval default).
      - summary_label: str. "queries" or "fixtures" -- appears in the
        closing summary line ("=== {kind}-eval: N/M {summary_label}
        passed (..) ===").
      - skill_name: str. Emitted on the startup banner; the monitor
        uses it to bind .output files to (skill, kind) for finished
        runs.
      - eval_path: str. Path to the fixture JSON file; emitted on the
        startup banner and stored in the envelope's `eval_set` field
        for downstream tooling.

    executor_class is ProcessPoolExecutor in production. Tests pass
    ThreadPoolExecutor so mock.patch reaches workers (process-pool
    workers run in separate processes and don't see parent-process
    patches). Cancel semantics are identical for not-yet-running
    futures across both pool types.
    """
    # Print the startup banner BEFORE assigning ids -- if assignment
    # raises, the harness still gets a banner-less abort, which is fine.
    print(
        format_startup_banner(
            kind=kind, skill=skill_name, eval_path=eval_path,
            runs=runs_per_fixture, workers=workers,
            total_fixtures=len(fixtures),
        ),
        file=sys.stderr,
    )

    id_pairs = assign_fixture_ids(fixtures, get_fixture_id)

    # Round-robin by run (run-major), not by fixture (fixture-major). With
    # partial coverage – the gateway throttles, the harness aborts, the
    # user Ctrl-Cs – round-robin guarantees every fixture gets at least
    # one run before any fixture gets a second. Fixture-major ordering
    # would leave declines at the tail of the corpus with 0 measurements
    # while front-loaded fixtures got the full N runs.
    tasks = []
    for run_idx in range(1, runs_per_fixture + 1):
        for fixture_id, fixture in id_pairs:
            tasks.append((
                fixture, run_idx, fixture_id,
                str(transcript_dir) if transcript_dir else None,
                timeout, cwd, get_query, score_run,
            ))

    results_by_id = {fid: {"fixture": fx, "runs": []}
                      for fid, fx in id_pairs}
    total = len(tasks)
    t0 = time.time()
    done = 0
    aborted_on_timeout = False

    with executor_class(max_workers=workers) as ex:
        futures = {ex.submit(_pool_target, t): t for t in tasks}
        for fut in as_completed(futures):
            (fx, run_idx, fixture_id, _td, _to, _cwd,
             _gq, _sr) = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {
                    "fixture_id": fixture_id, "run_idx": run_idx,
                    "elapsed_seconds": 0.0, "total_retries": 0,
                    "timed_out": False, "timeout_reason": None,
                    "transcript_path": None, "pass_": False,
                    "kind_extra": {"error": f"runner crashed: {e}"},
                    "worktree_contaminated": False,
                    "worktree_changed_paths": [],
                    "worktree_restore_failures": [],
                }
            results_by_id[fixture_id]["runs"].append(r)
            done += 1

            # Map runner-internal timeout_reason ("retry_budget_exhausted",
            # "wall_clock", None) to the on-line vocabulary
            # ("retry_budget", "wall_clock", "none"). Shorter, no None
            # to handle on the parsing side.
            tr_internal = r.get("timeout_reason")
            if tr_internal == "retry_budget_exhausted":
                tr_line = "retry_budget"
            elif tr_internal == "wall_clock":
                tr_line = "wall_clock"
            else:
                tr_line = "none"

            kx = r.get("kind_extra") or {}
            print(
                _format_progress(
                    n=done, total=total, kind=kind,
                    pass_=r["pass_"],
                    fixture_id=r["fixture_id"],
                    run_idx=r["run_idx"],
                    elapsed_seconds=r["elapsed_seconds"],
                    total_retries=r["total_retries"],
                    timeout_reason=tr_line,
                    first_tool=kx.get("first_tool") or "-",
                    first_skill=kx.get("first_skill") or "-",
                    failed_asserts=sum(
                        1 for ar in kx.get("assertion_results") or []
                        if not ar.get("pass", False)
                    ),
                    contaminated=r.get("worktree_contaminated", False),
                    query=get_query(fx),
                ),
                file=sys.stderr,
            )

            if r.get("worktree_contaminated"):
                changed = r.get("worktree_changed_paths") or []
                failures = r.get("worktree_restore_failures") or []
                msg = (
                    f"  ! WORKTREE CONTAMINATED on "
                    f"{r['fixture_id']}-{r['run_idx']}: "
                    f"{len(changed)} path(s) changed -- "
                    f"{', '.join(changed[:5])}"
                    + (f" (+{len(changed) - 5} more)" if len(changed) > 5 else "")
                )
                if failures:
                    msg += (
                        f"; auto-restore FAILED on "
                        f"{', '.join(failures)} (clean by hand)"
                    )
                else:
                    msg += "; auto-restored to HEAD"
                print(msg, file=sys.stderr)

            if r["timed_out"]:
                aborted_on_timeout = True
                cause = (
                    "CLI's retry budget exhausted (gateway-poisoned signal)"
                    if r["timeout_reason"] == "retry_budget_exhausted"
                    else "absolute wall clock exceeded"
                )
                print(
                    f"\n=== ABORT: run {fixture_id}-{run_idx} timed out -- "
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

    fixtures_with_runs = [
        {"fixture_id": fid, "fixture": entry["fixture"],
         "runs": entry["runs"]}
        for fid, entry in results_by_id.items()
    ]
    summary = summarize(fixtures_with_runs)

    contaminated_runs = sum(
        1 for entry in results_by_id.values()
        for r in entry["runs"]
        if r.get("worktree_contaminated")
    )

    envelope = {
        "kind": kind,
        "eval_set": eval_path,
        "runs_per_fixture": runs_per_fixture,
        "total_fixtures": len(fixtures),
        "elapsed_seconds": round(elapsed, 1),
        "aborted_on_timeout": aborted_on_timeout,
        "completed_runs": done,
        "total_runs_planned": total,
        "contaminated_runs": contaminated_runs,
        "results": summary,
    }

    if aborted_on_timeout:
        return envelope, 3

    fixtures_failed = sum(1 for r in summary if not r.get("pass", False))
    closing = (
        f"\n=== {kind}-eval: {len(summary) - fixtures_failed}"
        f"/{len(summary)} {summary_label} passed "
        f"({elapsed:.1f}s) ==="
    )
    print(closing, file=sys.stderr)

    return envelope, (0 if fixtures_failed == 0 else 1)
