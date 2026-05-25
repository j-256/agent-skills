# iteration-triage-content-type-extraction

Status: shipped. The 415 fixture (`synthesis-diff-content-type-415`) – the second of the two fixtures `iteration-resolve-slug-fallback-rejected.md` flagged as historically eliciting unauthorised source-file Edits from eval-Sonnet at HEAD – passes 3/3 strict under the default profile with `contaminated_runs: 0` after extending `extractRequestBody` in `_shared/scrape/parse-oas.js` to surface the spec's full declared content-type set, and updating `wrong-content-type` finding emission in `scripts/diff.js` to compare against that set. Smoke-test of the four non-415 synthesis fixtures (1 run each) also passed clean. Every claim in the synthesised answers cited to public `developer.salesforce.com` URLs.

## Hypothesis tested

Eval-Sonnet was hot-patching `_shared/scrape/parse-oas.js` `extractRequestBody` at HEAD because it returns `null` for non-`application/json` request bodies (`parse-oas.js:69-70` original short-circuits on `body.content['application/json']`). When the customer-supplied request sent `Content-Type: text/plain`, the bundled diff couldn't compute `wrong-content-type` even though the live response *says* "text/plain not supported." The hot-patch was to fall back to the first declared content-type silently. That's wrong: it loses the diagnostic information the customer needs (the spec's *declared* set), and silently passing arbitrary content-types into the schema validator breaks the JSON-only schema walker.

The honest fix should extend `extractRequestBody` to surface the spec's full declared content-type set as `contentTypes: [...]`, alongside the existing JSON schema. `diff.js` then compares the request's `Content-Type` against that set and the finding payload names the accepted media types – customer-facing answers can quote the accepted set verbatim instead of relying on the model to infer it from world-knowledge.

Verdict: hypothesis confirmed. The structured-set version of the fix lands clean: 3/3 strict on the 415 fixture, no eval-Sonnet hot-patching attempts in the transcripts, and the synthesised answers cite "the spec declares `application/json` as the only accepted media type" rather than reading the value off the error body alone.

## What changed

1. **`skills/_shared/scrape/parse-oas.js`** – `extractRequestBody` now returns `{contentTypes: Object.keys(body.content), ...}` for *every* spec with a non-empty `body.content` map. JSON schema, `schemaRef`, and `examples` continue to come from the `application/json` entry when one is present (and are absent when the spec only declares non-JSON media types). Empty `body.content` still returns `null` (preserves the prior "no body" contract).
2. **`skills/_shared/scrape/parse-swagger2.js`** – `extractRequestBody` updated to the same shape: `contentTypes` reflects `op.consumes || spec.consumes` (defaulting to `['application/json']` when the spec doesn't declare). Non-JSON-only specs no longer return `null` – they return `{contentTypes, required}` without a schema, so the diff layer can still compute `wrong-content-type`. AMF (`parse-amf.js`) wasn't touched – it already emits a `mediaType` string per payload, and `diff.js` normalizes that into the accepted set (see below).
3. **`skills/dsc-endpoint-help/scripts/diff.js`** – the `wrong-content-type` finding now compares the request's `Content-Type` (with `;charset=...` suffix stripped, lowercased) against the spec's accepted *set*. The finding payload's `expected` field is the array of accepted media types; the prose-rendering layer can quote them verbatim. Added `collectAcceptedContentTypes(body)` to normalize the three parser shapes into one canonical list: oas-3 + swagger-2 → `body.contentTypes[]`; AMF → `body.mediaType` string; legacy fixtures → `body.contentType` string. All three normalize to a single accepted-set list before the comparison.
4. **`skills/dsc-endpoint-help/SKILL.md`** – the documented `shapeDiff` finding-kinds list now includes the `wrong-content-type` finding's payload fields (`expected` array, `actual` string) and a one-line rendering guide ("quote the accepted set verbatim in the answer"), parallel to the `version-mismatch` entry from `iteration-triage-ocapi-version-tolerance`.
5. **Tests:**
   - `_shared/tests/test-parse-oas.js` (new) – five cases: (a) JSON-only → `contentTypes:['application/json']` with schema; (b) multi-content declaration → all media types listed in declaration order, schema sourced from JSON; (c) non-JSON-only → `contentTypes` set, no JSON schema; (d) empty `body.content` → null body (regression guard); (e) no `requestBody` at all → null body.
   - `dsc-endpoint-help/tests/test-diff.js` – four new cases on top of the existing wrong-content-type test, which is now stricter (asserts `expected` is an array): (a) charset suffix on Content-Type doesn't false-positive; (b) multi-content accepting set + request matches one → no finding; (c) multi-content accepting set + request matches none → finding names the full set; (d) backward-compat: legacy `body.contentType` (string) still produces a finding with `expected` normalized to a single-element array; (e) AMF body shape (`body.mediaType` string) drives the accepted set.
   - `dsc-endpoint-help/tests/test-triage-integration.js` – new end-to-end 415 case: pipes the same `text/plain` request shape from the synthesis-eval fixture into `triage.js` and asserts the structured `wrong-content-type` finding with `expected:['application/json']` and `actual:'text/plain'`, plus the public DSC URL in `sources[]`.
   - `dsc-endpoint-help/tests/fixtures/{spec-createBasket.json, fake-cache/.../createBasket.json}` – migrated from legacy `contentType: "application/json"` to the new `contentTypes: ["application/json"]` shape, matching what `parse-oas.js` now emits.

No edits to `scripts/triage.js` (the finding flows through the existing `shapeDiff` channel without rewiring), no eval-fixture edits, no SKILL.md description-field edits.

## Design decision: backward-compatibility shape

Three shapes end up in `body` across the parser ecosystem:

- **OAS 3 + Swagger 2** (after this iteration): `body.contentTypes: string[]` – the spec's declared accepted set.
- **AMF/RAML** (unchanged): `body.mediaType: string` – per-payload media type from RAML's `apiContract:payload` shape.
- **Legacy fixtures + any cache file written before this iteration**: `body.contentType: string` – the prior single-value shape.

`diff.js` normalizes all three at the seam (`collectAcceptedContentTypes`) rather than rewriting the parsers to one shape. Reasons:

1. Cached spec files written before this iteration are still valid – no cache invalidation needed for the fix to work on existing installs (the legacy `contentType` string is recognised). The 1-hour TTL re-scrapes them naturally.
2. AMF's per-payload `mediaType` shape comes from `parse-amf.js:230-237` which emits `payload.mediaType` directly; rewiring it to emit `contentTypes:[mediaType]` would be a breaking change to the type schemas already shipping in cache files for Einstein/cQuotient references.
3. The normalization is one helper in `diff.js`, no API surface area added.

The legacy + AMF backward-compat is genuinely necessary, not speculative – the user has cached spec files on disk written under the prior shape, and AMF specs (Einstein references) have always used `mediaType`. Per the repo's "don't add error handling for scenarios that can't happen" principle, this stops at three shapes; future parser additions would have to extend `collectAcceptedContentTypes`.

## Verification

```
$ bash skills/_shared/tests/run.sh
12 passed, 0 failed
$ bash skills/dsc-endpoint-help/tests/run.sh
4 passed, 0 failed
```

Synthesis-eval against the single 415 fixture, default profile, 3 runs strict:

```
$ python3 tools/synthesis-eval.py --eval /tmp/415-only.json --runs 3 --workers 3 \
    --timeout 300 --profile default \
    --out evals/dsc-endpoint-help/runs/iteration-triage-content-type-extraction/results.json
=== synthesis-eval: 1/1 fixtures passed (28.9s) ===
contaminated_runs: 0
```

Per-run details (from `results.json`):

| Run | Pass | Elapsed | Retries | first_tool | first_skill | worktree_changed_paths |
|---|---|---|---|---|---|---|
| 1 | True | 24.75s | 0 | Skill | dsc-endpoint-help | [] |
| 2 | True | 26.25s | 0 | Skill | dsc-endpoint-help | [] |
| 3 | True | 28.82s | 0 | Skill | dsc-endpoint-help | [] |

All four assertions on the 415 fixture passed every run:
- name `Content-Type` as the root cause
- name `application/json` as the expected media type per the spec
- cite the public shopper-baskets reference URL on `developer.salesforce.com`
- exclude `~/.cache/` (citation-leak guard)

Smoke test against the four non-415 synthesis-eval fixtures (1 run each, default profile):

```
=== synthesis-eval: 4/4 fixtures passed (96.4s) ===
```

| Fixture | Pass | Elapsed | contaminated |
|---|---|---|---|
| `synthesis-diff-hands-off-404-not-found` | True | 25.78s | False |
| `synthesis-diff-insufficient-scope-shopper-baskets` | True | 34.83s | False |
| `synthesis-diff-OCAPI-fault-envelope` | True | 89.33s | False |
| `synthesis-diff-jwt-scope-decode` | True | 96.30s | False |

The OCAPI fixture passing here is a happy regression check on `iteration-triage-ocapi-version-tolerance`'s structured `version-mismatch` path – the parse-oas / diff.js changes in this iteration left it untouched, and the `version-mismatch` finding still flows through.

## Cache-staleness footnote

The first attempted run before this iteration (against the existing cache populated by prior iterations' scrapes) passed assertions but for the wrong reason: the cached `createBasket.json` predated the parse-oas change, so it had no `contentTypes` field, and `triage.js`'s `shapeDiff` came back empty. The synthesised answers still passed because the model could read `'text/plain' is not supported` directly off the 415 error body and infer `application/json` from world-knowledge. After invalidating the cached `commerce_commerce-api/shopper-baskets/` directory and re-running, the fresh cache had `body.contentTypes: ['application/json']` and `triage.js`'s `shapeDiff` carried a real `wrong-content-type: {expected:['application/json'], actual:'text/plain'}` finding the answer cited verbatim. This is the structured-signal path the iteration was designed around, and it's the path the eval ran against for the recorded 3/3.

The 1-hour TTL on `scrapeRefresh` means existing user installs with stale `createBasket.json` (or any other cached spec) will rely on the model inferring content-type from the error body until the TTL expires and a fresh scrape runs – in practice this is self-healing; the structured signal turns on within the hour. Pre-emptive cache invalidation isn't part of this iteration's scope (and would conflict with the shared-cache invariant in `tools/README.md`).

## Final-text excerpt (run 1, fresh cache)

The synthesised answer cites the spec's declared accepted set, not the error body:

> The 415 is caused by a wrong `Content-Type` header. The spec requires `application/json` for `createBasket`'s request body; the integration is sending `text/plain`. The fix is a one-header change: replace `-H 'Content-Type: text/plain'` with `-H 'Content-Type: application/json'`.
>
> ## Diff
>
> ### Request shape
> - **Content-Type mismatch** – sent `text/plain`, spec requires `application/json`
>
> ## Sources
> - https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket

The structured `wrong-content-type` finding from `triage.js`'s `shapeDiff` is the source of the "spec requires `application/json`" claim – the model is no longer inferring from the error body alone.

## Surprises

- **The eval initially passed against a stale cache for the wrong reason.** Three runs hit assertions cleanly because the model could quote `application/json` from world-knowledge of SCAPI conventions, even though `triage.js`'s `shapeDiff` was empty (the cache predated this iteration's parse-oas change). One transcript even said "the script isn't yet detecting content-type mismatches from the 415 error class. The answer here is spec-correct regardless, but that's worth filing." That's the model correctly identifying the structured-signal gap *while still delivering a passing answer* – the assertion design is robust to inference-from-error-body, but the iteration's actual *intended* fix (structured signal flowing end-to-end) only validates with a fresh cache.
- **Backward-compat normalization in `diff.js` was load-bearing.** Migrating the test fixture to the new `contentTypes` shape was easy; migrating real cache files on disk would have required a one-shot invalidation step that conflicts with the shared-cache invariant. Normalizing at the seam keeps existing caches working.
- **`parse-swagger2.js` had a parallel bug** that wasn't called out in the brief: it short-circuited on non-JSON `consumes` and returned `null`, same shape as `parse-oas.js`. Fixed in the same iteration since it's the same surface area; covered by `parse-swagger2`'s use as the OCAPI parser (although OCAPI specs almost universally `consumes: [application/json]`, so the bug was latent).

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| `bash skills/_shared/tests/run.sh` | green | 12/12 | yes |
| `bash skills/dsc-endpoint-help/tests/run.sh` | green | 4/4 | yes |
| Synthesis-eval 415 fixture, default profile | 3/3 strict, contaminated_runs: 0 | 3/3, 0 contaminated | yes |
| Final answer names `application/json` per spec | required | every run cites spec-required application/json | yes |
| No regression on non-415 fixtures | smoke 1 run each | 4/4 pass, 0 contaminated | yes |
| No `~/.cache/` leak | required | excludes assertion passed every run | yes |
| Structured `wrong-content-type` flows end-to-end | required | confirmed via `tool_result` extraction | yes |

## Next steps

Both deferred follow-ups from `iteration-resolve-slug-fallback-rejected.md` are now landed: this iteration closes `iteration-triage-content-type-extraction`, and `iteration-triage-ocapi-version-tolerance` (eddf626) closed the OCAPI version-drift hot-patch. The audit suggestion ("`_shared/resolve-slug.js` may itself contain eval-injected residue from `iteration-triage-resolve-slug-fix`") is the only remaining followup from that brief; it's not blocked by anything in this iteration.

A residual gap this iteration didn't address: `parse-amf.js` still emits `body.mediaType` (single string) rather than a `contentTypes` array. Real Einstein cache files all declare `application/json` (50/54) or `application/fhir+json` (4/54), so the single-string shape is functionally adequate. If a future Einstein reference declares multiple media types per payload, the AMF parser would need the same multi-value treatment – flag for a follow-up iteration only if that surface materializes.
