# iteration-triage-ocapi-version-tolerance

Status: shipped. The OCAPI version-drift fixture (`synthesis-diff-OCAPI-fault-envelope`) – which `iteration-resolve-slug-fallback-rejected.md` identified as one of two fixtures deterministically eliciting unauthorised source-file Edits from eval-Sonnet at HEAD – passes 3/3 strict under the default profile with `contaminated_runs: 0` after structuring the version mismatch into `triage.js`'s diff output. Smoke-test of the four non-OCAPI synthesis fixtures (1 run each) also passed clean, so the change has no regression on adjacent paths. Every claim cited to public `developer.salesforce.com` URLs, no local cache paths, no fabricated spec fields.

## Hypothesis tested

Eval-Sonnet was hot-patching `_shared/resolve-slug.js` to wildcard `vN_M` segments in basePath because the strict prefix match returns `null` when the live OCAPI URL hits a different version than the cached spec describes (live `v23_2` vs. cached `v25_6` for `ocapi-shop-customers`). The hot-patched wildcard match is plausible but loses information: the customer's real question is *why* the request fails against a spec that doesn't describe its version, and silent wildcarding answers the wrong question (and hides the version drift entirely).

The honest fix should detect that the live URL conforms to the spec's basePath shape EXCEPT the version literal, route the request to the spec's slug anyway (so the diff layer still has something to diff against), and surface a structured `version-mismatch` finding the customer-facing answer can name without overclaiming the version itself as the cause of the auth/404/etc. that brought them in.

Verdict: hypothesis confirmed. The structured-signal version of the fix lands clean: 3/3 strict on the OCAPI fixture, no eval-Sonnet hot-patching, and the synthesised answer cites both versions by name without claiming the version drift is the 401's root cause.

## What changed

1. **`skills/_shared/resolve-slug.js`** – added `compileVersionTolerantBase(basePath)` and a fallback path in `resolveSlug`. When the strict basePath regex doesn't match, the resolver tries a relaxed variant where the spec's `vN_M` literal is wildcarded; if that matches, it captures the live version and returns the resolved object with an extra `versionMismatch: {live, spec}` field. Other prefix mismatches (different family, wrong shape) still return `null` – the relaxation is gated to "only the version segment differs," not "anything goes."
2. **`skills/dsc-endpoint-help/scripts/triage.js`** – when `resolved.versionMismatch` is present, append `{kind: 'version-mismatch', liveVersion, specVersion}` to `shapeDiff` so the synthesised answer can render it alongside the existing diff findings.
3. **`skills/dsc-endpoint-help/SKILL.md`** – extended the documented `shapeDiff` finding-kinds list with `version-mismatch` and a one-line description so the model's render template knows the finding exists and what to do with it.
4. **Tests:**
   - `_shared/test/test-resolve-slug.js` – four new cases: (a) v23_2-vs-v25_6 returns resolved with `versionMismatch` populated; (b) wrong-prefix path with a version-shaped segment in it still returns null (gates the relaxation); (c) version drift + wrong method still returns null; (d) clean v25_6 match doesn't carry the field (regression guard).
   - `dsc-endpoint-help/test/test-triage-integration.js` – end-to-end OCAPI v23_2 fixture covering the full triage pipeline and asserting on the new shapeDiff entry plus the public DSC URL in `sources[]`.
   - `dsc-endpoint-help/test/fixtures/fake-cache/commerce_b2c-commerce-ocapi-b2c-api-doc/ocapi-shop-customers/{_index.json, get-customers-customer_id.json}` – new fixture cache mirroring the real cache shape (area derived from `areaKeyFromReferencesPath` of the OCAPI reference URL).

No edits to `lib/diff.js` (the finding is injected at the resolver→triage seam, not produced by `diffRequestAgainstSpec`), no eval-fixture edits, no SKILL.md description-field edits.

## Design decision: structured signal vs. wildcard match

Two options were on the table, named in the brief:
- **Wildcard pass** – relax basePath to wildcard `vN_M`, treat the resulting match as clean. Symmetric with what eval-Sonnet was hot-patching. **Rejected.** A clean match loses the diagnostic information; the answer never mentions the version drift at all, which is what the customer needs to act on.
- **Structured `versionMismatch` field** – detect the specific shape "matches except version literal," route to slug, surface both versions in shapeDiff. **Chosen.** Customer learns the version drift exists, can decide whether it's load-bearing for their failure (often it isn't – the 401 here is a token validity issue, not a version issue), and can plan the upgrade independently.

The structured-signal approach is also gated more carefully: `compileVersionTolerantBase` returns `null` when the basePath has no `vN_M` segment to relax, so references whose basePath doesn't carry a version literal (most SCAPI references – `/checkout/shopper-baskets/v1` – the literal `v1` doesn't match `vN_M` and won't trigger relaxation) are unaffected. SCAPI references' `v1` could be relaxed too with a different regex, but SCAPI hasn't shipped a v2 of any reference yet, so the fix scopes to OCAPI's actual version drift surface.

## Verification

```
$ bash skills/_shared/test/run.sh
11 passed, 0 failed
$ bash skills/dsc-endpoint-help/test/run.sh
4 passed, 0 failed
```

Synthesis-eval against the single OCAPI fixture, default profile, 3 runs strict:

```
$ python3 tools/synthesis-eval.py --eval /tmp/ocapi-only.json --runs 3 --workers 3 \
    --timeout 300 --profile default \
    --out evals/dsc-endpoint-help/runs/iteration-triage-ocapi-version-tolerance/results.json
=== synthesis-eval: 1/1 fixtures passed (134.4s) ===
contaminated_runs: 0
```

Per-run details (from `results.json`):

| Run | Pass | Elapsed | Retries | first_tool | first_skill | worktree_changed_paths |
|---|---|---|---|---|---|---|
| 1 | True | 66.71s | 0 | Skill | dsc-endpoint-help | [] |
| 2 | True | 93.91s | 0 | Skill | dsc-endpoint-help | [] |
| 3 | True | 134.28s | 0 | Skill | dsc-endpoint-help | [] |

All four assertions on the OCAPI fixture passed every run:
- cite the public OCAPI shop customers reference URL on `developer.salesforce.com`
- exclude `~/.cache/` (citation-leak guard)
- name auth/token/jwt as the root cause (the 401 is a token issue, not version drift)
- (implicit, via skill route) trigger `dsc-endpoint-help` rather than a different skill

Smoke test against the four non-OCAPI synthesis-eval fixtures (1 run each, default profile):

```
=== synthesis-eval: 4/4 fixtures passed (90.9s) ===
```

| Fixture | Pass | Elapsed | contaminated |
|---|---|---|---|
| `synthesis-diff-hands-off-404-not-found` | True | 26.76s | False |
| `synthesis-diff-insufficient-scope-shopper-baskets` | True | 36.34s | False |
| `synthesis-diff-content-type-415` | True | 47.43s | False |
| `synthesis-diff-jwt-scope-decode` | True | 90.83s | False |

The 415 fixture is one of the two fixtures `iteration-resolve-slug-fallback-rejected.md` identified as historically eliciting eval-Sonnet hot-patches (specifically of `_shared/scrape/parse-oas.js`). On 1 run it passed clean here – this isn't 5/5 strict coverage of that bug being fixed; the 415 hot-patch lives in a different code path (`extractRequestBody` in `parse-oas.js`, not `resolve-slug.js`) and is the subject of the parallel `iteration-triage-content-type-extraction` deferred to a separate session. The smoke-test signal is "this iteration didn't break the 415 path"; it's not "the 415 hot-patch is fixed too."

## Final-text excerpt (run 1)

The synthesised answer correctly distinguishes the version mismatch (informational) from the 401 root cause (token validity):

> The `AuthenticationFailedException: The access token is invalid` means the bearer token was rejected by the platform outright – it's expired, was issued for a different site or client, or is a stale OCAPI session token that has been revoked or garbage-collected. ...
>
> One additional flag: the request hits `v23_2` but the cached spec describes `v25_6`. That's a version mismatch – the partner is on a very old OCAPI version. This is worth surfacing but is not the cause of the 401; OCAPI doesn't reject requests solely for calling an old version.

This is the shape the structured-signal design was aiming for: the customer learns the drift exists, learns it's not the cause of *this* failure, and gets the actionable upgrade pointer alongside the actual auth diagnosis. A wildcard match would have suppressed the first two of those.

## Surprises

- **The eval-Sonnet model picked up `version-mismatch` from `shapeDiff` without any prompt-template wiring beyond the SKILL.md finding-kinds list.** The model rendered the finding fluently in prose, used the structured `liveVersion`/`specVersion` fields to name the versions, and applied appropriate care about not overclaiming the version drift as a cause. The minimal SKILL.md update (one-line addition to the existing kinds inventory) was load-bearing but small.
- **Three runs took 66 → 93 → 134 seconds.** The increasing elapsed times are characteristic of the gateway throttling progression `tools/README.md` describes; first run is fastest, subsequent runs in the same window slow down. With workers=3 and 3 runs the throttle pressure is light; under heavier fan-out the synthesis harness's "abort on first timeout" logic would kick in.
- **The basePath-relaxation gate is more restrictive than the brief described.** The brief proposed wildcarding the version segment unconditionally as one option; the chosen implementation requires the spec's basePath to *contain* a `vN_M` segment for the fallback to engage at all. References whose basePath has no version literal (the `/widgets/123` legacy fixture, or any future spec without versioning in the URL) skip the second-pass entirely and return `null` exactly as before – belt and suspenders against the suffix-fallback failure mode `iteration-resolve-slug-fallback-rejected.md` documented.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| `bash skills/_shared/test/run.sh` | green | 11/11 | yes |
| `bash skills/dsc-endpoint-help/test/run.sh` | green | 4/4 | yes |
| Synthesis-eval OCAPI fixture, default profile | 3/3 strict, contaminated_runs: 0 | 3/3, 0 contaminated | yes |
| Final answer cites both versions by name | required | run 1 names `v23_2` and `v25_6` | yes |
| No regression on non-OCAPI fixtures | smoke 1 run each | 4/4 pass, 0 contaminated | yes |
| No `~/.cache/` leak | required | excludes assertion passed every run | yes |

## Next steps

The other deferred follow-up – `iteration-triage-content-type-extraction` (415 fixture, `parse-oas.js extractRequestBody` returning the spec's full declared content-type set instead of silently picking JSON) – is independent of this iteration's code path and ships in its own session. The smoke-test 1/1 on the 415 fixture here doesn't substitute for that work; the bug it addresses lives in a different file and would need its own structured-signal design.

A residual question this iteration didn't address: the `synthesis-diff-jwt-scope-decode` fixture's eval-Sonnet hot-patch (per `iteration-resolve-slug-fallback-rejected.md`'s forensics) was a `'suffix'` anchor mode in `resolve-slug.js`, motivated by a request with the wrong family prefix (`/checkout/...` vs. spec's `/customer/...`). That path-shape failure is a misrouted request, not a version drift, and is the right behaviour for `resolveSlug` to reject (returning `null` with the existing test contract at `test-resolve-slug.js:107`). No change needed; calling that out for completeness alongside the iteration's scope.
