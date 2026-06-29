# iteration-diff-schemaref-body-validation

## Hypothesis

`diff.js` validated a request body only when the spec carried an **inline**
`endpoint.body.schema`. On the real scrape cache most SCAPI POST/PUT bodies are
emitted as a **named-type reference** – `endpoint.body.schemaRef` (a `$ref` like
`#/components/schemas/CouponItem`), with no inline `body.schema`. So for every
named-type body the body-validation gate (`if (ep.body && ep.body.required &&
ep.body.schema)`) was false and `shapeDiff` skipped body validation entirely – no
`body-missing-required`, no `body-wrong-type`, silently. This is the same
root-cause class as the dsc-scenario walk-types responses-layout drift
(`iteration-walk-types-responses-layout`): a reader assuming inline schemas when
the cache stores named-type refs.

The fix resolves a `body.schemaRef` to its type file and validates against the
resolved schema. The differ stays a pure function: `triage.js` (which already has
the `refDir`) does the resolution and passes the schema in.

## The verified problem

Probed against the real cache before fixing: across `commerce_commerce-api`, **125
schemaRef-body endpoints have a body type with required fields** (e.g.
`auth/finishWebauthnUserRegistration` requires `client_id`, `channel_id`,
`username`, …; `catalogs/assignProductToCategory` requires `catalogId`,
`categoryId`, `productId`). For all of them, an empty `{}` body produced **zero**
findings – the differ couldn't name the missing field even though the spec
declared it required.

The TODO's literal repro (`createBasket` + empty body) is real but lands on a
permissive type: the real `Basket` schema declares **no** required fields, so even
after the fix an empty createBasket body correctly flags nothing. That is the
right behavior, and it exposed a second defect – the fake-cache `createBasket`
fixture **fabricated** `customerInfo` as a required field, a shape the real
`Basket` never had. A green test over that drifted fixture is exactly the failure
the walk-types iteration warned about.

This is the spec-syntactic / business-semantic boundary, made concrete:
"syntactically valid basket-creation call" (the real `Basket` permits an empty
body – a shopper may create an empty basket and build it piecemeal) is distinct
from "basket applicable for placing into an order" (needs items/shipping/payment).
The latter is real but **not encoded as `required` on the schema**, the spec
doesn't capture it, and `diff.js` neither can nor should infer it. `diff.js`
answers only the syntactic question. (It's the same boundary dsc-scenario's
createOrder bridge respects: it surfaces `createBasket` as a step but leaves what
to put in the basket to the model.)

## What changed

- **`diff.js` validates against the resolved schema.** `shapeDiff` and
  `diffRequestAgainstSpec` take an optional `bodySchema`; the body gate uses
  `ep.body.schema || bodySchema`. Inline schema still wins (back-compat); a
  named-type body validates against the resolved schema; an *unresolvable*
  schemaRef (`bodySchema` undefined) skips body validation gracefully – the same
  degrade as a spec with no body schema, never a crash. `diff.js` stays a pure
  function with no fs/cache coupling.

- **`triage.js` resolves the ref.** It reuses `query.js`'s `resolveSchemaRef`
  (rather than duplicate a cache-path-coupled resolver – that duplication is the
  drift class this family keeps fixing) and passes the resolved `.schema` to the
  differ. Resolution failure leaves `bodySchema` undefined → graceful skip.

- **`query.js` is now importable.** Guarded its CLI `main()` with
  `if (require.main === module)` and added `module.exports = { resolveSchemaRef }`.
  Verified it still runs as a CLI unchanged.

- **Corrected the fabricated fixture.** The fake-cache `createBasket` body became
  the real `schemaRef: "#/components/schemas/Basket"` + a faithful
  `types/Basket.json` with **no** required fields. Added a real required-field
  schemaRef endpoint, `addCouponToBasket` (body → `CouponItem`, which genuinely
  requires `code`), with its type file. Both mirror the real cache shapes exactly.

## Tests

Strict TDD, RED verified before GREEN on both layers:

- **`test-diff.js` (pure unit).** schemaRef body + resolved `bodySchema` → flags
  missing/wrong-typed `code`; schemaRef body + no `bodySchema` → graceful skip, no
  findings, no crash; permissive (no-required) schemaRef body → empty body flags
  nothing (the syntactic-vs-semantic guard, encoding the createBasket distinction).

- **`test-triage-integration.js` (end-to-end).** `addCouponToBasket` empty body →
  resolves `CouponItem`, flags missing `code` (the gap closed); `createBasket`
  empty body → resolves `Basket`, flags nothing (the corrected, faithful
  behavior – replaces the old assertion that depended on the fabricated
  `customerInfo`-required shape).

All deterministic suites green: dsc-endpoint-help 4/4, dsc-scenario 10/10,
dsc-scrape 11/11, _shared 15/15. Real-cache spot check: `addCouponToBasket` empty
body flags `code`; `createBasket` empty body flags nothing.

## Behavior change + eval

This makes `diff.js` start producing `body-missing-required` / `body-wrong-type`
findings on schemaRef bodies it previously suppressed – a real user-facing change
with synthesis-eval surface. Added one synthesis fixture
(`synthesis-diff-schemaref-body-missing-required`): a 400 on `addCouponToBasket`
with a bare error body (no `detail` naming the field), so the answer can name the
required `code` field *only* by resolving the schemaRef and reading
`CouponItem.required`. Assertions are customer-outcome only (names `code`, cites
the public shopper-baskets URL, no cache-path leak) – no tool-path assertions, per
the repo's synthesis-eval discipline. The existing createBasket-bearing fixtures
(`insufficient-scope`, `content-type-415`) send `{"currency":"USD"}` and assert on
scope/content-type, not body-missing-required, so the fixture correction doesn't
perturb them.

## Results

Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`), `--profile isolated`,
`--runs 5`, `--timeout 600`, live scrape.

**6/7 fixtures pass, 5 runs each (463s total).** The new
`synthesis-diff-schemaref-body-missing-required` fixture: **5/5** – every run
fired `dsc-endpoint-help` first, resolved the `CouponItem` schemaRef, and named
the required `code` field (which the bare error body never gave away), citing the
public shopper-baskets URL with no cache-path leak. This is the gap closed
end-to-end on Sonnet, not just in unit tests.

The two createBasket-bearing fixtures whose fake-cache fixture I corrected
(`synthesis-diff-insufficient-scope-shopper-baskets`, `synthesis-diff-content-type-415`)
stayed **5/5** – the fixture correction didn't perturb the scope / content-type
paths (those send `{"currency":"USD"}` and assert on scope/content-type, not body
fields). All other pre-existing fixtures also 5/5.

The one failure, `synthesis-diff-jwt-scope-decode` (0/5), is **pre-existing and
orthogonal**: every run shows `first_tool=Bash` / `first_skill=-` – the model
decoded the JWT with a shell one-liner instead of firing the skill, a *triggering*
miss with `failed_asserts=0` (the skill never ran, so body validation – the only
thing this iteration changed – was never reached). It was already 0/5 in the two
most recent prior iterations (`iteration-content-type-fixture-rewrite`,
`iteration-eval-environment-artifact`) and is the JWT-decode routing regression
tracked separately in the dsc-endpoint-help follow-ups. Not introduced here.

The `WORKTREE CONTAMINATED ... .cache/` notices on some runs are the known
live-scrape harness artifact (the scrape cache writes during the run; "operator
repo untouched") – the eval-skill-isolation item, not a regression from this
change, and the affected runs still passed.

## Surprises

- **The TODO's own repro under-stated the bug AND over-stated it.** Under-stated:
  framed as "createBasket skips validation," when in fact 125 commerce-api
  endpoints hit the gap. Over-stated: the chosen example (`createBasket`) flags
  nothing even after the fix, because the real `Basket` has no required fields –
  so the literal repro's "should flag missing required fields" is wrong. Probing
  the real cache before writing the fixture is what caught both, and turned the
  example into the *permissive-body* guard instead of a broken assertion.
- **The bug had a fixture co-conspirator.** The reason `test-diff.js` and
  `test-triage-integration.js` were green over this gap is that the fake-cache
  `createBasket` carried an inline `body.schema` with a fabricated required field –
  a shape the scraper never emits for that endpoint. The skip was invisible
  because the only body-validation test ran against the one fixture shaped to make
  it pass. Same lesson as the walk-types responses-layout drift: a fixture that
  doesn't model the real layout makes the test lie.
