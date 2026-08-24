# iteration-eval-environment-artifact

Status: HYPOTHESIS_FALSIFIED. Restricted-profile eval (no MCP, no Agent) was supposed to recover `synthesis-diff-hands-off-404-not-found` to ~5/5 if the regression was environmental – instead the restricted run lands at 0/5 strict (vs. 2/5 strict on the rich-toolbelt baseline), and per-fixture pass rates *regressed* across the board. The deeper diagnosis is a `triage.js` slug-resolution bug that's been silently broken for the whole skill's life and was masked by environment-substituted tooling: `resolveSlug` compares the request's full live path (`/checkout/shopper-orders/v1/organizations/.../orders/{orderNo}`) against `_index.json`'s relative spec path (`/organizations/{organizationId}/orders/{orderNo}`), so the script exits 2 before ever calling `classify` – on every fixture in the synthesis-eval set. The 0/5 hand-off result is real skill-prose drift gated on this bug, not eval-environment artifact. Filed as the iteration's handoff: a third iteration must fix `resolveSlug` (or `parseRequest`'s path normalization) before the hand-off prose can be measured at all, and likely a fourth iteration must tighten `SKILL.md`'s diff-branch hand-off prose since the model freelances confidently when triage.js silently fails.

## Hypothesis tested

The eval-running Sonnet (`claude -p`) has a richer toolbelt than production Sonnet – Agent, MCP search aggregator (`mcp__plugin_search_search`), MCP google docs search, `mcp__mcp-adaptor__web_scrape`, `WebFetch`, generic `Bash`. A production user installing this skill on a vanilla `claude` session typically has none of those alternates, so `triage.js` becomes the only diff-branch path. The merge-baseline iteration documented that the eval Sonnet *substitutes* alternates for the bundled scripts (Agent / MCP search / WebFetch / inline Python), and the synthesis-assertion-relaxation iteration documented that on the hand-off-404 fixture specifically, the model freelances confidently fabricated runtime causes (token mismatch, site mismatch, hostname diff) instead of producing hand-off prose – the prediction was that this freelancing was environmental, because in a no-alternates profile `triage.js`'s `handsOff: true` would be the only signal the model sees, and the SKILL.md's diff-branch flow already says to write hand-off prose in that case.

The prediction: under `--profile restricted`, `synthesis-diff-hands-off-404-not-found` recovers to ~5/5 strict; the other four fixtures hold at or above their rich-toolbelt baseline (5/5 OCAPI, 5/5 JWT, 4/5 insufficient-scope, 4/5 content-type-415).

The hypothesis is wrong. Restricted profile produces *worse* customer-outcome scores on every fixture, and hand-off-404 stays at 0/5. Diagnosis below.

## What changed

`tools/_eval_runner.py` and the two eval harnesses (`tools/synthesis-eval.py`, `tools/trigger-eval.py`) gained a `--profile` flag with two values: `default` (current behavior – inherits the user's MCP/Agent setup) and `restricted` (mirrors a vanilla install: `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --disallowedTools Agent`). The flag is plumbed through the `DSC_EVAL_PROFILE` env var so `ProcessPoolExecutor` children inherit it; `_spawn_and_bail` reads it and appends the profile-specific flags to every `claude -p` invocation. Default behavior is unchanged when `--profile` is omitted.

No edits to `skills/dsc-endpoint-help/` or to the synthesis fixtures during this iteration. SKILL.md description word count: 275 / 300 (unchanged).

## Eval results

`python3 tools/synthesis-eval.py --eval evals/dsc-endpoint-help/synthesis-eval.json --runs 5 --workers 4 --timeout 600 --profile restricted --out evals/dsc-endpoint-help/runs/iteration-eval-environment-artifact/results.json`

Wall-clock 723.9s. No abort, no gateway throttle, exit code 1 (eval failure, not harness abort). 25/25 runs completed. Routing correctness 100% (`first_skill=dsc-endpoint-help` on every run).

| Fixture | Restricted | Rich (iteration-synthesis-assertion-relaxation) | Failure mode |
|---|---|---|---|
| `synthesis-diff-insufficient-scope-shopper-baskets` | 4/5 | 4/5 | run 5: URL citation missed |
| `synthesis-diff-OCAPI-fault-envelope` | 3/5 | 5/5 | runs 4 & 5: OCAPI URL pattern not matched |
| `synthesis-diff-content-type-415` | 4/5 | 4/5 | run 2: URL citation missed |
| `synthesis-diff-jwt-scope-decode` | 3/5 | 5/5 | runs 1 & 4: scope-name regex missed |
| `synthesis-diff-hands-off-404-not-found` | 0/5 | 0/5 | hand-off regex unmatched on every run; model proposes spec-grounded fixes |

**Strict pass: 0/5 (down from 2/5 strict on the rich-toolbelt baseline).** **Customer-outcome assertion pass rate: 22/25 → also lower than the 22/25 the rich profile had.** Three fixtures regressed (OCAPI -2, JWT -2, hand-off-404 unchanged at 0); two held (insufficient-scope and content-type-415).

The prediction is falsified. Restricted profile is not a 5/5-recovery move on the hand-off fixture, and is a measurable regression on the OCAPI and JWT fixtures.

## Why hand-off-404 didn't recover: a real triage.js bug

I expected that without alternates, the model would invoke `triage.js`, see `handsOff: true`, and produce hand-off prose. Inspecting transcripts and reproducing locally surfaced the actual failure:

`scripts/triage.js` exits 2 before ever calling `classify` on every fixture in the synthesis-eval set. Repro against the hand-off fixture:

```bash
cat <<'EOF' | node skills/dsc-endpoint-help/scripts/triage.js
{
  "request": "curl -X GET 'https://zzrf-001.dx.commercecloud.salesforce.com/checkout/shopper-orders/v1/organizations/f_ecom_zzrf_001/orders/00000101?siteId=RefArch' -H 'Authorization: Bearer eyJ2ZXIi...'",
  "errorResponse": { "status": 404, "body": { "type": "/error-types/order-not-found" } },
  "referenceUrl": "https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders",
  "cacheRoot": "/Users/james.klein/.cache/dsc-scrape"
}
EOF
# exit 2: triage: could not resolve slug – no matching endpoint in _index.json
# for GET /checkout/shopper-orders/v1/organizations/f_ecom_zzrf_001/orders/00000101
```

The same exit-2 happens on the insufficient-scope, OCAPI, content-type-415, and JWT fixtures. `triage.js` cannot classify any failing request the synthesis-eval set throws at it.

### Root cause: live-path vs. spec-path mismatch

`lib/parse-request.js`'s `parseUrlParts` returns `path: u.pathname` – the request's full live path including the SCAPI base prefix (`/checkout/shopper-orders/v1/organizations/.../orders/00000101`). `lib/resolve-slug.js`'s `resolveSlug` then matches that against `_index.json`'s `endpoints[*].path` – which the scraper writes as the *relative* spec path (`/organizations/{organizationId}/orders/{orderNo}`). Live path always carries `/checkout/<reference>/v1/` that the spec strips, so no `regex.exec(path)` ever matches. `triage.js` dies at line 105.

Repro:

```js
node -e "
const idx = require('fs').readFileSync(
  '/Users/<you>/.cache/dsc-scrape/commerce_commerce-api/shopper-orders/_index.json',
  'utf8'
);
console.log(JSON.parse(idx).endpoints.getOrder);
// { method: 'GET', path: '/organizations/{organizationId}/orders/{orderNo}' }
"
```

vs. `parseUrlParts`'s output, which is the request URL's `pathname` verbatim, base-prefix included.

### Why this was masked

Two layers of masking made the bug invisible until this iteration:

1. **The eval harness substitutes alternates.** Per the prior iteration's diagnosis, eval-Sonnet routes around `triage.js` with `Agent`, MCP search, `WebFetch`, and inline-Bash JWT-decoding. Customer-outcome assertions (URL citation, scope name, cache-leak guard) pass on most runs because the alternates surface the right facts from the spec or training data. The skill is shipping correct answers via paths that bypass its own bundled diff classifier.
2. **The unit test for `resolveSlug` uses synthetic data with the wrong shape.** `skills/_shared/test/test-resolve-slug.js` defines a fake `index.endpoints[*].path` with the full live-path prefix (`/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets`) – which is *not* the shape the actual scraper writes. The test passes; the function is broken against real cache data; the unit-test layer is therefore not load-bearing for the live-path-vs-spec-path contract.

The hand-off fixture surfaces the bug because it's the one fixture where the freelance answer is *wrong* (proposes spec-grounded fixes for a 404 the spec can't explain). The other four fixtures' freelance answers happen to be correct (the spec really does require the named scope / Content-Type / etc.), so they pass on outcome despite the script not running.

If `triage.js`'s slug resolution worked, `classify` on `{ status: 404, body: { type: '/error-types/order-not-found' } }` would correctly return `ErrorClass.UNKNOWN` (verified locally – falls through to the default case at `classify.js:79`), `triage.js` would emit `handsOff: true`, and the SKILL.md's diff-branch flow would route to hand-off prose. The hand-off regression is real-skill, but the prose is downstream of a script bug that prevents the signal from ever surfacing.

## Why other fixtures regressed under restricted profile

Less interesting but worth flagging:

- **OCAPI 3/5 vs 5/5.** Without `WebFetch` / MCP search, the model has fewer paths to surface the public OCAPI URL. The cache for `b2c-commerce-ocapi-b2c-api-doc` exists locally but its slug structure (RAML-derived, different layout from OAS-3) makes naïve `Read` less likely to land on the right path. Two runs cited Salesforce help / atlas URLs instead of the `developer.salesforce.com/.+ocapi.+customer` reference URL.
- **JWT 3/5 vs 5/5.** Without inline-Bash + `python3` JWT decoding (which `Agent` and `mcp__mcp-adaptor__*` were facilitating in the rich profile), some runs decoded the JWT with `decode-token.js` correctly but didn't surface the spec's accepted-scope list cleanly enough to name `sfcc.shopper-myaccount` or `sfcc.shopper-standard`. Runs 1 and 4 named the JWT's *current* scopes and asked the user to consult the spec, rather than diffing against the spec's accepted list.

These are real artifacts of the restricted toolbelt, not measurement noise – and they argue that the restricted profile is *also* not a representative production environment. A production user has Bash and `WebFetch` and a working `triage.js` in their toolbelt; they'd see different (probably better) outcomes than either eval profile produces.

## What this iteration teaches

The eval-environment investigation was structured around the wrong axis. The right axis turns out to be:

- **`triage.js` is broken.** Until `resolveSlug` matches against the real cache shape, the diff branch is functionally script-less in production *and* in eval. The "diff branch" exists as SKILL.md prose only; the bundled classifier never runs.
- **Customer outcomes are surviving via freelancing.** Four of five fixtures still produce customer-correct answers because the spec really does declare the field the assertions check for. The fifth (hand-off-404) surfaces the freelance failure mode because spec-derivable answers exist *and are wrong* for that error class.
- **Eval-environment artifact is real but secondary.** Restricted profile *does* change tool-selection behavior (3/5 vs 5/5 on OCAPI and JWT) and *does not* recover the hand-off regression. The root cause is upstream of the eval harness.

The synthesis-assertion-relaxation iteration was right that `tool_sequence_includes` assertions weren't the right layer – but the deeper signal is that the bundled scripts they were asserting on don't actually run regardless. The customer-outcome assertions are now the only signal we have, and the hand-off fixture is the only one with regression-detection sensitivity, so it's the canary for the next iteration.

## Surprises

The unit-test fixture for `resolveSlug` is the type of bug that's hard to catch by reading: the test data looks reasonable in isolation, the function passes its tests, real cache files exist locally, the integration test (`test-triage-integration.js`) presumably uses similarly-shaped synthetic data. The contract that real `_index.json` files have *relative* spec paths (no SCAPI prefix) is implicit in the scraper's behavior and not enforced anywhere outside the cache files themselves. Future test authoring on `lib/_shared/` should probably parameterize against a real cache fixture (frozen copy of `commerce_commerce-api/shopper-baskets/_index.json` checked into `test/fixtures/`), not synthetic objects whose shape is asserted in the test file.

The restricted-profile run also exposed that one mode of "alternate substitution" is *not* covered by either profile: the prod user. A vanilla `claude` install has built-in tools (`Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, `Skill`, `Task*`) that the restricted profile preserves, and a production user editing a script will hit the same `triage.js` exit-2 and react by reading the cache files directly with `Read` (which the restricted-profile model is doing on every run). That's not "freelancing" – that's the model recovering from a broken bundled script the way a human would. Customer-outcome correctness in restricted mode is therefore probably a closer match to production than the rich-toolbelt mode, even though the absolute pass rate is lower.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| Synthesis-eval | 5/5 strict | 0/5 strict | no |
| Hand-off-404 recovery | 5/5 (predicted) | 0/5 | no – hypothesis falsified |
| Per-fixture restricted ≥ rich baseline | 5/5 | 2/5 (insufficient-scope, content-type-415 held; OCAPI, JWT regressed; hand-off-404 unchanged at 0) | no |
| Routing correctness | 25/25 | 25/25 | yes |
| SKILL.md word count | ≤ 300 | 275 (unchanged) | yes |

## Next steps

This iteration unblocks the deeper investigation by establishing that the hand-off regression is real-skill (downstream of a script bug), not eval-environment artifact. The natural next iterations are:

1. **`iteration-triage-resolve-slug-fix`** – Fix `lib/resolve-slug.js` to either (a) strip the SCAPI base prefix from `livePath` before matching, or (b) match against `endpoint.url`'s path component (the absolute URL with `{shortCode}` server template) instead of `endpoint.path`. Update `test/fixtures` to use a real `_index.json` snapshot rather than synthetic data with the wrong shape. Re-run synthesis-eval (both profiles) to measure the recovery on hand-off-404 and re-establish a clean rich-profile baseline.
2. **`iteration-skill-handoff-prose-tightening`** – After the script fix, if hand-off-404 still wobbles below 5/5 because the model fabricates runtime causes even when `triage.js` says `handsOff: true`, tighten SKILL.md's diff-branch hand-off section. Candidate prose changes: explicit list of forbidden phrasings ("token mismatch", "site mismatch", "wrong hostname"), explicit instruction to refuse to enumerate runtime causes when `handsOff: true`, etc. This is gated on (1) – there's no point tightening prose if the script that triggers the prose isn't running.
3. **`iteration-test-coverage-real-cache-fixtures`** – Replace synthetic test fixtures in `skills/_shared/test/` with frozen real cache snapshots. Specifically `test-resolve-slug.js`, `test-triage-integration.js` if it has the same issue. Goal: the unit-test layer should catch the live-path-vs-spec-path contract failure on every commit.

The `--profile` knob added in this iteration is worth keeping. It doesn't measure what was hypothesized – but it does give a knob to A/B environment effects when designing future iterations, and the restricted-profile customer outcomes are probably a closer match to production than rich. Documenting that in `CLAUDE.md`'s "running and evaluating skills" section is a candidate post-fix follow-up.
