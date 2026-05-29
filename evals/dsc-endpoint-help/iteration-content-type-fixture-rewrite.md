# iteration-content-type-fixture-rewrite

Status: DONE. 5/5 strict on the rewritten `synthesis-diff-content-type-415` fixture. Rewrites the fixture to require the model consult the spec rather than parrot the error body. Triggered by README example-curation work that surfaced the fixture as a weak test: the prompt's response body literally contained `"The Content-Type header value 'text/plain' is not supported"` plus title `"Unsupported Media Type"`, so the existing assertions (`(?i)content[- ]type` and `(?i)application/json` were both deducible without ever opening the spec. The 415 fixture passed at 4/5 in `iteration-synthesis-assertion-relaxation`, but that 4/5 wasn't load-bearing on triage correctness – it was load-bearing on the model's ability to read its own input.

## Hypothesis tested

Stripping the `detail` field from the 415 response body forces the model to actually consult `createBasket`'s spec to identify `application/json` as the required content type. The cURL still contains `Content-Type: text/plain` (so the "wrong" half of the diff is observable from the request), but the "right" half (`application/json`) is no longer in the prompt. The same three customer-outcome assertions (`(?i)content[- ]type`, `(?i)application/json`, `developer.salesforce.com/.+shopper-baskets`) now require a real spec read to pass. Pass count should remain ≥4/5 since the underlying triage logic (`triage.js`'s wrong-content-type finding extracted from `body.contentTypes`) is unchanged and the spec is well-formed (`createBasket.body.contentTypes = ["application/json"]`, verified against `~/.cache/dsc-scrape/commerce_commerce-api/shopper-baskets/createBasket.json`).

## What changed

One edit to `evals/dsc-endpoint-help/synthesis-eval.json`. No SKILL.md edits. No script edits.

### `synthesis-diff-content-type-415` query body trimmed

Before:

```
body: {"type":"/error-types/unsupported-media-type","title":"Unsupported Media Type","detail":"The Content-Type header value 'text/plain' is not supported by this resource."}
```

After:

```
body: {"type":"/error-types/unsupported-media-type","title":"Unsupported Media Type"}
```

The `detail` field was the leak. Many real APIs omit `detail` and return only `{type, title}`, so the trimmed shape is realistic.

### Hypothesis text rewritten

The fixture's `hypothesis` field now explicitly notes that `application/json` is deliberately absent from the prompt so the assertion checking for it cannot be passed by parroting the error body – it can only be passed by reading the spec's `requestBody.content` keys (or the `body.contentTypes` field in the scraper's normalized envelope, which is what `triage.js` consumes) for `createBasket`.

The assertion regexes themselves are unchanged. The change in semantic meaning is: the same regex that was previously satisfiable by quoting the prompt now requires a spec read.

## Eval results

`stream-eval synthesis --skill-path skills/dsc-endpoint-help --eval evals/dsc-endpoint-help/synthesis-eval.json --runs 5 --workers 4 --timeout 300 --out evals/dsc-endpoint-help/runs/iteration-content-type-fixture-rewrite/results.json`

Wall-clock 403.8s. No abort, no gateway throttle, exit code 1 (eval failure on unrelated fixtures, not harness abort).

| Fixture | Pass count | Failure mode |
|---|---|---|
| `synthesis-diff-content-type-415` | 5/5 | – (the rewrite – elapsed 21–39s, all three customer-outcome assertions firing on every run, model citing the spec to produce `application/json`) |
| `synthesis-diff-insufficient-scope-shopper-baskets` | 5/5 | – |
| `synthesis-diff-hands-off-404-not-found` | 5/5 | – (regression cleared since `iteration-synthesis-assertion-relaxation` filed the open 0/5; not addressed by this iteration's change but worth noting as resolved) |
| `synthesis-diff-OCAPI-fault-envelope` | 3/5 | runs 1/2/4: `developer\.salesforce\.com/.+ocapi.+customer` URL pattern unmatched – model cited an OCAPI URL with a different path shape. Pre-existing fixture-strictness issue; not introduced by this change |
| `synthesis-diff-jwt-scope-decode` | 1/5 | runs 1/2/3/4: all three customer-outcome assertions passed (`failed_asserts=0`), but `pass_: false` because `expected_skill_pass=false` – Sonnet went `first_tool=Bash` for JWT decode rather than `Skill`. Tool-substitution artifact, not a content failure. The same eval-environment-artifact problem documented in `iteration-synthesis-assertion-relaxation` and `iteration-eval-environment-artifact` |

**Strict pass on the rewritten fixture: 5/5.** The hypothesis is validated: stripping the `detail` field forces the model to consult the spec to identify `application/json`, and the same triage path produces the same answer reliably. Run elapsed times (21–39s) are normal for a spec-read flow against a warm cache.

The two regressed fixtures are both pre-existing artifacts surfaced by harness scoring rules (URL pattern over-strictness on OCAPI; expected_skill_pass tool-routing assertion on JWT). Neither was caused by the content-type fixture rewrite – the change was scoped to one fixture's `query` and `hypothesis` strings, with no impact on the others' query bodies, assertions, or scoring rules.

## Notes

- **No worked-example replacement.** The `docs/examples/diff-content-type-415.md` worked example was deleted from the README catalog as part of the same README curation pass that surfaced the fixture problem. The deletion stands: the fixture is now harder to pass and the inline JWT scope-decode example covers triage-against-the-spec semantics with stronger signal (scope diff requires JWT decode + spec read, plus a second-issue catch on missing `siteId`). If a future content-type worked example is wanted, it should be regenerated from a transcript against the rewritten fixture, not the original.
- **Why not strip `title` too.** The `title` "Unsupported Media Type" is the standard HTTP 415 reason phrase – it's what every HTTP client surfaces by default. Removing it would make the fixture less realistic without making the test harder, since the model can derive the same fact from the status code (`HTTP 415` is in the prompt). The `detail` field was the leak because it named the offending header value (`text/plain`) verbatim.
- **What this doesn't catch.** The fixture still doesn't catch a model that confabulates `application/json` from training-data familiarity with REST APIs (i.e. guesses correctly without reading the spec). That failure mode would be caught by the `developer.salesforce.com/.+shopper-baskets` URL assertion (the model still has to cite the spec it pretends to have read), but a model that confabulates the answer *and* fabricates a URL would slip through. The defense for that is the citation-leak guard plus human review of failure-mode transcripts on regression iterations.
