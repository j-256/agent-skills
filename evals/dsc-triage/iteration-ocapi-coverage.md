# iteration-ocapi-coverage

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 23/23 passed, runs=3, ~54 min wall clock (3216s).

## Hypothesis

OCAPI is reachable through dsc-triage today via the shared scrape library, and the dsc-triage description already names OCAPI explicitly ("Diagnose *why* a specific SCAPI / OCAPI request is failing"). What was untested was whether OCAPI-flavored failing requests with OCAPI-shaped error envelopes route correctly to dsc-triage on Sonnet, and whether the runtime classifier handles OCAPI's `{"fault":{...}}` envelope.

A known risk going in: "dsc-triage's error-body parser might not handle OCAPI shape. SCAPI uses RFC-7807; OCAPI uses `{"fault": {"type": ...}}`. If the parser only knows RFC-7807, the triage queries will route correctly but the runtime answer will be 'couldn't parse the error.'"

That risk was confirmed real on inspection: `scripts/classify.js`'s `hasText()` only inspected top-level body keys (`error`, `type`, `title`, `detail`, `message`). OCAPI nests both `type` and `message` under `fault`, so all OCAPI auth/shape errors classified as `UNKNOWN`. Same-commit fix below.

## Setup

### Triage classifier fix

`scripts/classify.js` extended to also inspect `body.fault.{type, message}` after the top-level keys. Three OCAPI fault test cases added to `tests/test-classify.js`:

- `{fault:{type:'InvalidClientIdException',message:'The client id is invalid'}}` at 401 → `AUTH_INVALID_CLIENT`
- `{fault:{type:'AuthenticationFailedException',message:'Authentication failed'}}` at 401 → `AUTH_UNAUTHORIZED` (no specific oauth code, falls through to generic auth)
- `{fault:{type:'MissingRequiredPropertyException',message:'Missing required property: product_id'}}` at 400 → `REQUEST_MISSING_REQUIRED`

All four triage tests still pass.

### Eval queries

Added 3 OCAPI positives to `evals/dsc-triage/trigger-eval.json` (now 13 positives + 10 negatives = 23 entries), all using realistic OCAPI fault envelope shape:

1. OCAPI shop-products `Get multiple products` 401 with `InvalidClientIdException`.
2. OCAPI shop-customers `Get or refresh customer JWT` 401 with `AuthenticationFailedException`.
3. OCAPI shop-baskets POST /baskets/{basket_id}/items 400 with `MissingRequiredPropertyException` (`productId` vs. `product_id` snake_case-vs-camelCase confusion).

## Result

| Query | Triggers |
|---|---|
| OCAPI shop-products InvalidClientIdException 401 | 3/3 |
| OCAPI shop-customers AuthenticationFailedException 401 | 3/3 |
| OCAPI shop-baskets MissingRequiredPropertyException 400 | 2/3 (one run routed to dsc-endpoint-lookup; ≥ pass threshold) |

10 SCAPI/SLAS positives passed (8 at 3/3, 2 at 2/3 with one TIMEOUT each). 10 negatives at 0/3.

## Verdict

Hypothesis confirmed. OCAPI references trigger dsc-triage correctly on Sonnet via the existing description, and the classifier fix means OCAPI fault envelopes now produce real `errorClass` values instead of `UNKNOWN`. Promotes OCAPI on the dsc-triage column from `❌ (decline-only)` to `✅` in `docs/dsc-skills.md`.

The one OCAPI body-shape query that landed at 2/3 had a single run route to `dsc-endpoint-lookup` instead of `dsc-triage`. That's a known disambiguation pattern (a query that names a specific endpoint and asks about body fields can read as either "look up the body schema" or "diff the body against the spec") rather than an OCAPI-specific issue – it would happen on the equivalent SCAPI query too. Still passes the 2/3 threshold.

## Caveats

- **`InvalidPropertyException` (a common OCAPI 400 fault type for unknown body fields) still classifies as `UNKNOWN`.** That's accurate – the existing 400 branch's regex set covers `missing[_\- ]?required|missing[_\- ]?parameter`, `invalid[_\- ]?parameter[_\- ]?type|expected '...' but got|type[_\- ]?mismatch`, and `malformed|unsupported[_\- ]?media|content[_\- ]?type`. None match `InvalidPropertyException`. Adding broader OCAPI exception coverage is a separate iteration; the eval here uses `MissingRequiredPropertyException` which is well-covered.
- **OCAPI's spec-declared `security` is `customers_auth` / `oauth2_application` / `client_id` schemes with empty `scopes` arrays** – the spec doesn't enumerate per-scope requirements (unlike SCAPI's RFC-grade scope listing). dsc-triage's `scopeDiff` will report empty `required` for OCAPI endpoints; that's truthful, not a gap. The triage value for OCAPI is mostly the shape diff (body fields, content-type) plus the `errorClass` classification.
- **First eval run hit a 240s per-run timeout under heavy ambient model load** – all 3 OCAPI positives returned 0/3 purely from TIMEOUT. Re-running at `--timeout 600` resolved every TIMEOUT-driven failure. Future iterations should consider 600s the default given the long-cURL/long-prompt pattern in triage queries.

## Files in this iteration

- `skills/dsc-triage/scripts/classify.js` – extended `hasText` to inspect `body.fault.{type, message}`.
- `skills/dsc-triage/tests/test-classify.js` – 3 OCAPI fault test cases added.
- `evals/dsc-triage/trigger-eval.json` – 3 OCAPI positives added.
- `runs/iteration-ocapi-coverage/results.json` – probe-eval output (gitignored, regenerable).
