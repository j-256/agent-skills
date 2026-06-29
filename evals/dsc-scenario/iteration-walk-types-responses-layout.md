# iteration-walk-types-responses-layout

## Hypothesis

The local type-graph walker (`scripts/walk-types.js`) is silently broken on the
current scrape cache: `producedTypes()` and the `requiredInputs()` body reader
expect an OAS-keyed `responses` object (`{"200": {schema:{$ref}}}`), but every
parser emits an index-keyed array (`[{code, schemaRef}]`). On the live cache the
walker finds zero producer->consumer edges, so `scenario.js`'s local fallback
(`scenario.js:110`, used whenever the model doesn't pass a pre-walked `graph`)
degrades to a target-only plan. The test passed only because its fixtures had
drifted to a layout the scraper never wrote -- a green test over a broken
function. Filed during `iteration-prefer-latest-reference-version` (an eval spawn
hit the mismatch and edited the tracked file; reverted, filed, fixed here).

## Root cause -- the readers assumed one layout; the cache has three

Ground-truthed every parser family against the real cache before touching code
(248 cached references: 164 swagger-2, 76 oas-3, 8 amf-raml). The scrapers all
`.push()` response entries, so `responses` is always an **array**; the produced
type and body schema arrive in one of three real shapes:

| Family | refs | responses entry | body |
|---|---|---|---|
| OAS-3 / Swagger-2, named type | most | `{code:"200", schemaRef:"#/components/schemas/Basket"}` | `body.schemaRef` (a `$ref`) |
| OAS-3 / Swagger-2, inline | some | `{code:"200", schema:{...}}` | inline `body.schema` |
| AMF-RAML | 8 | `{code:"201", payloads:[{mediaType, schema:{...}}]}` | inline `body.schema` (array-properties); **no `types/` dir** |

The old `producedTypes()` did `Object.entries(ep.responses)` and read
`resp.schema.$ref`; on the array layout the keys are `"0"/"1"/...` (never match
`/^2\d\d$/`) and the ref is in `resp.schemaRef`, so it returned `[]`. The body
reader only handled inline `body.schema`; on a `body.schemaRef` (the common SCAPI
case) it read nothing. Params also moved: type is under `p.schema.type` now, not
a bare `p.type`.

No back-compat branch for the OAS-keyed shape: `git log -S` confirms
`parse-oas.js extractResponses` has only ever `.push()`ed an array. The
object-keyed layout was never emitted by any parser -- the fixtures were *born*
mismatched, not drifted over time -- so a fallback would be dead speculative code.

The reference implementation already existed in-repo: `dsc-endpoint-help`'s
`query.js` reads the real layout correctly (`ep.responses` as array, `r.code`,
`r.schemaRef`, `resolveSchemaRef`). The fix mirrors its idioms.

## What changed

- **`scripts/walk-types.js` `producedTypes()`** -- iterate `responses` as an
  array; status from `resp.code`; named type from `resp.schemaRef`; inline schema
  from `resp.schema` or AMF's `resp.payloads[0].schema`.
- **`scripts/walk-types.js` `requiredInputs()`** -- now takes
  `{cacheRoot, reference, area}`; resolves a `body.schemaRef` to its
  `types/<Name>.json` to read required body fields (degrades silently if the type
  file is absent), keeps the inline `body.schema` path, and reads param types
  from `p.schema` (tolerating legacy `p.type`). Both call sites updated.
- **`scripts/walk-via-agent.md`** -- the sub-agent walker prose restates the
  algorithm and is the contract for the *preferred* path (see the NOTE at
  `walk-types.js`). Synced steps 2-3 to the real three-shape layout so the
  hand-walk and the local walk agree.
- **Fixtures (`tiny-area`, `amf-area`, `ver-area`)** -- converted to the real
  layout. tiny-ref keeps identical graph semantics (so compose/curl-block stay
  valid) but now mixes a `schemaRef` body (`createContainer`) and an inline body
  (`addItem`). amf-ref converted to real AMF shape (array responses with inline
  `payloads[].schema`); its `types/` dir deleted (AMF emits none). Added a
  `linkItems` op + `ItemLink` type so the `body.schemaRef`->type-file resolution
  path is actually exercised by an edge.

## Tests

- **`test-walk-types.js`** -- added a `schemaRef`-body assertion (the
  `addItem -> linkItems via itemId` edge only forms if the named-type body is
  resolved). Verified RED without the fix, GREEN with it.
- **`test-scenario-integration.js`** -- the first block (local walk, no provided
  `graph`) now asserts the full `createContainer -> addItem -> getItem` chain and
  its ordering. Verified RED against the reintroduced bug (`got getItem` only).
  This is the end-to-end guard the bug slipped past before: every prior
  integration assertion used either a provided graph or a single-step target, so
  the local fallback producing real edges was never asserted.
- **`test-fixture-layout-conformance.js` (new)** -- anti-drift guard. Half 1 runs
  `parseOas` on a minimal spec and pins the emitted shape (array responses with
  `code`+`schemaRef`, `body.schemaRef`, params under `p.schema`). Half 2 walks
  every committed endpoint fixture and rejects an object-keyed `responses`, a
  missing `code`, or a nested `schema.$ref`/`body.schema.$ref`. Verified it
  rejects a fixture drifted back to the old layout. This closes the
  green-test-broken-function class: a fixture can no longer disagree with the
  scraper without a test failing.

## Verification (clean-room, real cache)

The money shot the fixtures can't fake: `walkTypes('addItemToBasket',
'shopper-baskets-v2')` against the real `~/.cache/dsc-scrape` went from
**1 node / 0 edges** (pre-fix) to **4 nodes / 3 edges**, correctly finding
`createBasket -> addItemToBasket via basketId` (plus `transferBasket`,
`mergeBasket`, which also produce a `Basket` carrying `basketId` -- structurally
correct). `createBasket` now reports `producedTypes: [{name:"Basket",
ref:"#/components/schemas/Basket"}]`. AMF verified independently against `tmf620`
(inline `payloads[].schema` produces a type) and the amf-ref fixture
(`createWidget -> useWidget via widgetId` edge forms). All 10 dsc-scenario tests
green; dsc-endpoint-help (shares `_shared`) still 4/4.

## Surprises

- **The bug was wider than filed.** The TODO flagged `producedTypes()`; the body
  reader was broken the same way (most SCAPI bodies are `body.schemaRef`), and
  param type had moved to `p.schema`. Ground-truthing all three parser families
  first -- rather than fixing only the reported symptom -- caught both.
- **The fixtures were never right.** This wasn't drift from a layout that once
  matched; `parse-oas.js` has emitted arrays since it was written. The fixtures
  were authored to a shape the scraper never produced, which is why the
  conformance guard (pin the parser output, enforce it on fixtures) is the
  durable fix, not just re-authoring the JSON.

## Follow-up surfaced

- **`dsc-endpoint-help/scripts/diff.js` shares the root cause** (filed separately,
  not fixed here): it only validates a request body when `ep.body.schema` is
  present, so any named-type (`body.schemaRef`) body -- most SCAPI POST/PUT --
  skips body validation entirely. Repro: `createBasket` + `{}` body -> 0
  findings. Its own eval surface; deserves its own iteration.
- **`_shared` `test-catalog-keys` is red on `main`** (pre-existing, unrelated):
  `'scapi'` is registered in both `catalog-keys.js` and `aliases.js`, which the
  test forbids. Introduced by `e9af74b` (the OCAPI/SCAPI alias iteration) on top
  of `77ffd79`. Filed for the TODO sweep.
