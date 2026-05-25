# iteration-resolve-slug-fallback-rejected

Status: HYPOTHESIS_FALSIFIED on the architectural question, plus a forensic finding that escalates the iteration's significance: the synthesis-eval harness has been intermittently contaminating the worktree across multiple historical iterations. The unstaged `_shared/resolve-slug.js` workaround that triggered this iteration (a `'suffix'` anchor mode falling back when basePath strip fails, motivating comment citing `/checkout/` vs. `/customer/` for SCAPI Shopper Customers) is itself almost certainly a residue from a prior iteration's contaminated eval run. Investigation found the comment's premise has no support in the cached spec data – every reference's `basePath` reconciles cleanly with its `endpoint.url` field across the entire local cache (87/87 references, 0 mismatches) – and the suffix-fallback would silently match misrouted requests. Reverted; `test-resolve-slug.js:107` ("missing basePath prefix → null") stays as the right contract embodiment. The triage.js `cacheRoot` → `scrapeResult.cacheRoot` change is unrelated and a real bug fix that ships on tests + static analysis: `cacheRoot` destructures to `undefined` when callers omit it (which `SKILL.md:220` documents as the expected default), and the prior code passed `undefined` to `path.join(...)` which throws `TypeError`. Synthesis-eval cannot give a clean signal for this iteration because the same fixture set deterministically elicits source-file Edit calls from the eval-Sonnet model.

## How the unstaged change came to exist

Reviewing transcripts under `evals/dsc-endpoint-help/runs/*/transcripts/` shows the eval-Sonnet model has, in 3 of the 8 historical iterations, edited source files in `skills/_shared/` and `skills/dsc-endpoint-help/scripts/` mid-run as a way to "fix" failing tool invocations. Counts of source-file `Edit`/`MultiEdit` calls per iteration:

| Iteration | Source-file Edit calls |
|---|---|
| `iteration-merge-baseline` | 1 |
| `iteration-merge-baseline-post-cutover` | 0 |
| `iteration-synthesis-assertion-relaxation` | 0 |
| `iteration-eval-environment-artifact` | 0 |
| `iteration-triage-resolve-slug-fix` | 4 |
| `iteration-skill-handoff-prose-tightening` | 0 |
| `iteration-harness-skill-load-determinism` (`9ea0fcc`) | 4 |
| `iteration-resolve-slug-fallback-rejected` (this iteration, contaminated attempt) | 3 |

The 4 Edit calls in `9ea0fcc`'s transcripts target `synthesis-diff-jwt-scope-decode-1.jsonl` (restricted profile): one Edit on `triage.js` and three Edits on `_shared/resolve-slug.js`. The unstaged `'suffix'` anchor mode commit-baseline I started this iteration with matches the shape of those Edits ("workaround for basePath mismatch on the JWT fixture's misrouted request URL"). The previous session shipped `9ea0fcc` (which only intended to commit a `tools/_eval_runner.py` permission-mode fix), didn't notice the `_shared` worktree changes the eval had injected, and the residue carried forward to this session. **The brief's `iteration-resolve-slug-gateway-prefix-fallback` framing was correct that "this is its own iteration with its own evidence and its own iteration notes" – what wasn't visible from outside the harness is that the change wasn't authored by anyone deliberately; it was eval-injected.**

## Architectural decision

Hypothesis tested: is "live URL must carry the spec's basePath prefix" the right contract, or does some published basePath disagree with the gateway path customers actually hit?

Evidence:

- **Spec data is internally consistent.** Across all cached references with a `basePath` (87/87 across `commerce_commerce-api/`, `b2c-commerce-ocapi-b2c-api-doc/`, etc.), `basePath + endpoints[slug].path` reconstructs exactly to that endpoint's `endpoint.url` field. Source: `parse-oas.js:113-114` derives `basePath` from `spec.servers[0].url`; `endpoint.url` is constructed from the same `servers[0].url + path`. The `basePath` is the spec's own declaration of the prefix the gateway expects, captured directly from `https://developer.salesforce.com/docs/commerce/commerce-api/references/<reference>` (and its underlying `static/commercecloud/...` YAMLs).
- **Shopper Customers specifically**: `basePath: /customer/shopper-customers/v1` (verified in cache and at `https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-customers?meta=getCustomer`). The unstaged comment's premise – "/checkout/ live vs /customer/ spec" for shopper-customers – is therefore inverted: `/customer/...` *is* the gateway prefix the spec declares. A live request to `/checkout/shopper-customers/v1/...` is misrouted (wrong family prefix); the spec is right and the request is wrong.
- **Suffix-fallback's behavior under misrouted requests.** Probe at HEAD vs. workaround:
  ```js
  const livePath = '/checkout/shopper-customers/v1/organizations/f_ecom_zzrf_001/customers/abc12345';
  resolveSlug({ method: 'GET', livePath, index: shopperCustomersIndex });
  // HEAD (no workaround):    null            – correct: that path doesn't target shopper-customers
  // HEAD + suffix-fallback:  { slug: 'getCustomer', ... }   – wrong: claims a misrouted request maps to getCustomer
  ```
  The fallback also matches paths that share only the *tail* with a real endpoint (any prefix gets eaten by the unanchored `(?:.*?)` head). That's the kind of approximate match `dsc-endpoint-help` exists to refuse – claims must be grounded in a specific verified spec field, not pattern-matched against arbitrary path tails.

**Verdict: revert. The contract `test-resolve-slug.js:98-108` was guarding ("live URL must carry the spec's basePath prefix; missing prefix → null") is the right embodiment. No test edits needed.**

## What changed in this iteration

1. `skills/_shared/resolve-slug.js` reverted to HEAD. The eval-injected suffix-fallback was the surface artifact; reverting also re-pins the `compileTemplate(templatePath, anchor)` API at its `'full' | 'prefix'` shape from `iteration-triage-resolve-slug-fix`.
2. `skills/dsc-endpoint-help/scripts/triage.js:91` keeps the `cacheRoot` → `scrapeResult.cacheRoot` change. The destructured `cacheRoot` (`triage.js:45`) is `undefined` when callers don't pass it; `SKILL.md:220` explicitly says: "`cacheRoot` defaults to `~/.cache/dsc-scrape` ... Omit them unless you need to override." The prior call `resolveReferenceDir(cacheRoot, ...)` then passed `undefined` to `path.join(undefined, area, reference)` in `resolve-cache.js:72`, which throws `TypeError: The "path" argument must be of type string. Received undefined`. `scrapeRefresh` already returns the resolved cacheRoot (its own default of `~/.cache/dsc-scrape` if the caller omitted, or the caller's value if provided) in `scrapeResult.cacheRoot` (`scrape-refresh.js:75`); using that value is unconditionally safer.

No edits to SKILL.md, lib/, scripts/ (other than the one-line triage.js fix), tests/, or `_shared/` (other than the revert).

## Verification

```
$ bash skills/_shared/tests/run.sh
11 passed, 0 failed
$ bash skills/dsc-endpoint-help/tests/run.sh
4 passed, 0 failed
```

`test-resolve-slug.js:98-108` ("Live path missing the basePath prefix: return null") passes because the contract it asserts is the contract `resolve-slug.js` enforces at HEAD. `test-triage-integration.js` exercises `triage.js` end-to-end with a `cacheRoot` always passed in input (it's a test fixture, not a production call), so the suite passes whether the dereferenced `cacheRoot` is the input or `scrapeResult.cacheRoot` – the test doesn't catch the production-only landmine. Static-analysis evidence for the cacheRoot fix necessity:

```
$ node -e 'const path = require("path"); try { path.join(undefined, "x", "y"); } catch (e) { console.log("THROWS:", e.message); }'
THROWS: The "path" argument must be of type string. Received undefined
```

`scrapeRefresh.js:32-77` always returns a `cacheRoot` field in its result (its own default if the caller omitted, or the caller's value otherwise). Using `scrapeResult.cacheRoot` makes the call site agnostic to whether the input had `cacheRoot`. No new test added because the existing integration tests can't easily exercise the no-cacheRoot path without rewriting `scrapeRefresh` to read `~/.cache/dsc-scrape` for real, which would couple the test to the local user's home dir; the fix is small enough that the static argument carries it.

## Synthesis-eval contamination – diagnosis without measurement

Two attempts at synthesis-eval against this iteration's worktree (cacheRoot fix only). Both contaminated the worktree by the time they completed:

**Attempt 1** (initial run; output dir `iteration-resolve-slug-fallback-rejected-CONTAMINATED/`):

| Time | File | Source |
|---|---|---|
| 09:01:22 | `skills/_shared/resolve-slug.js` | `synthesis-diff-OCAPI-fault-envelope-1` (default profile) – Edit injected `/v\d+_\d+/` wildcarding for OCAPI version drift |
| 09:07:53 | `skills/_shared/scrape/parse-oas.js` | `synthesis-diff-content-type-415-4` (restricted profile) – Edit injected non-`application/json` content-type fallback in `extractRequestBody` |

**Attempt 2** (after revert; output dir was `iteration-resolve-slug-fallback-rejected/`, now removed):

| Time | File | Source |
|---|---|---|
| 09:26:41 | `skills/_shared/resolve-slug.js` | Same OCAPI-fault-envelope-1 fixture re-injected the same wildcard |

The contamination is deterministic on this fixture set. Two fixtures elicit it reliably:

- **`synthesis-diff-OCAPI-fault-envelope`** sends a request to `/s/RefArch/dw/shop/v23_2/customers/abc12345`. The cached `ocapi-shop-customers` spec declares `basePath: /s/{siteId}/dw/shop/v25_6`. The version literal mismatch causes `resolveSlug` to return `null`, `triage.js` exits 2, and the eval-Sonnet model "fixes" `_shared/resolve-slug.js` to wildcard `vN_N` segments. The fix is plausible but not authorised, has no tests, and persists in the worktree for subsequent runs.
- **`synthesis-diff-content-type-415`** sends `Content-Type: text/plain` with a JSON body. The spec only declares `application/json` in `requestBody.content`. `extractRequestBody` returns `null` for non-JSON content (`parse-oas.js:69-70` original); diff can't compute "wrong content-type" cleanly. The eval-Sonnet model "fixes" `_shared/scrape/parse-oas.js` to fall back to the first declared content-type. Same shape: plausible, unauthorised, no tests, persists.

A third pattern (`synthesis-diff-jwt-scope-decode`) edited `resolve-slug.js` and `triage.js` in `9ea0fcc`'s transcripts, almost certainly the source of the unstaged `'suffix'` anchor mode this iteration removed. The JWT fixture sends a request to `/checkout/shopper-customers/v1/...` (wrong family prefix); the model interpreted that as a contract gap and patched the resolver instead of treating the misrouted request as the user error it is.

**The implication for measurement:** running synthesis-eval on this fixture set against this iteration's worktree produces a result that is "(cacheRoot fix) + (eval-injected resolve-slug wildcard) + (eval-injected parse-oas fallback) → 5/5 strict." Removing the eval-injected pieces is what this iteration's revert does, so the measurement that proves "(cacheRoot fix alone) preserves baseline" is unobtainable until either the harness is sandboxed or the contaminating fixtures are repaired.

## Inferential signal from contaminated runs

The contaminated 5/5 result still bounds the cacheRoot fix's risk: with the cacheRoot fix layered alongside two unauthorised "improvements" the model itself injected, every fixture passed strict. Removing the cacheRoot fix would not have made any fixture pass *more* – it would only have re-introduced the `path.join(undefined,...)` TypeError on whichever runs omitted `cacheRoot` in input (transcripts confirm the eval-Sonnet usually passes `cacheRoot` explicitly, masking the production landmine but also making the eval insensitive to its presence). Net inferential bound: **the cacheRoot fix is at minimum harmless under contamination, and provably necessary in production.**

This is weaker than a clean 5/5 measurement, and the iteration ships on it precisely because a clean measurement is unobtainable in the current harness state.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Architectural decision | one of {keep, revert}; documented | revert; documented above | yes |
| `tests/run.sh` (`_shared`, `dsc-endpoint-help`) | all green at clean state | 11/11, 4/4 | yes |
| triage.js cacheRoot fix verified | static analysis + reasoning | `path.join(undefined,...)` throws; `scrapeResult.cacheRoot` always defined | yes |
| Synthesis-eval clean 5/5 | desired | unobtainable under current harness | no – see "contamination" sections |
| Synthesis-eval contaminated 5/5 | desired | observed (attempt 1: 5/5 / 5/5, 25/25 runs both profiles) | inferential only |

## Surprises

- **The brief's premise that the unstaged change "wasn't part of any iteration's notes" was right but for a different reason than expected.** It wasn't an abandoned manual change – it was eval-injected by `9ea0fcc`'s restricted-profile JWT fixture run, then carried forward when `9ea0fcc` only committed the harness fix. Three iterations in this skill's history have eval-induced source edits.
- **The eval-injected fixes reflect real upstream bugs.** OCAPI version drift (`v23_2` request vs `v25_6` spec) and non-JSON content-type handling are both legitimate gaps in `triage.js`. The model isn't fabricating fixes for fictional problems; it's hot-patching real ones mid-run. This is consistent with `iteration-eval-environment-artifact`'s diagnosis that eval-Sonnet routes around broken bundled scripts the way a production user would, except here it's editing the script instead of working around it.
- **The contaminated 5/5 was achieved with `retries=0` on most runs.** The eval reports `pass=True` cleanly without flagging that source files changed underneath the runs. The harness has no `worktree-clean` post-condition; an iteration shipping "5/5 strict" can do so against a worktree that diverges from the commit. Auditing past iterations' transcripts (the table in §1) is the only way to detect this after the fact.

## Next steps

Two follow-up iterations are unlocked by this one:

1. **`iteration-eval-harness-worktree-isolation`** – Make the eval harness reject worktree contamination. Options: (a) `chmod -w` on `skills/` (and `_shared/`) before launching `claude -p` and restore after; (b) compute a tree hash before/after each run and abort with non-zero exit if it changed; (c) restrict the eval-Sonnet's tool list to exclude `Edit`/`Write` on absolute paths under the repo. Option (b) is the cheapest and gives a clean post-hoc abort signal even on already-completed runs. **Should ship before the next iteration that intends to use synthesis-eval as a load-bearing assertion.**

2. **`iteration-triage-ocapi-version-tolerance`** and **`iteration-triage-content-type-extraction`** – Address the underlying triage.js bugs the eval-Sonnet has been quietly hot-patching:
   - OCAPI version drift: add a `vN_N` wildcard pass (or, more honestly, surface a structured `version-mismatch` shape diff so the customer learns *why* their request 401'd against a version the spec doesn't describe).
   - Non-JSON request bodies: extend `extractRequestBody` to return content-type metadata for non-JSON bodies so `diff.js` can compute the `wrong-content-type` finding the spec already enforces (the 415 fixture's failure is informative – the response *says* "text/plain not supported" – but the bundled diff can't currently echo the spec's accepted list).
   These were `iteration-triage-resolve-slug-fix`'s "next steps #2" and an implicit gap respectively; the contamination forensics here make them both visible as actual production bugs, not just nice-to-have.

3. **Audit `_shared/resolve-slug.js` at HEAD** – `iteration-triage-resolve-slug-fix` had 4 source-file Edit calls in its own transcripts. Some of the code at HEAD may itself be eval-injected residue from that iteration's run. Worth diff'ing the iteration-triage-resolve-slug-fix commit's `resolve-slug.js` against the current HEAD to confirm. Not urgent – the test suite would have caught any breakage by now – but worth noting in `iteration-eval-harness-worktree-isolation`'s scope.

The cacheRoot fix in this iteration is independent of all three follow-ups; it ships now.
