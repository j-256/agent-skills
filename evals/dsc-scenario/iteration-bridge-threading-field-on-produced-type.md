# iteration-bridge-threading-field-on-produced-type

## Hypothesis

The cross-reference type bridge (`iteration-cross-reference-type-bridge`) derives its threading field from `dominantPathId(producerRef)` and threads it into the consumer's body input – and into the runnable as a `jq -r .<field>` extraction – *without verifying the field is a real property on the produced type*. `findProducers`, the walker's in-reference edge-drawer, does verify this: it draws an edge only when `input.name in props` on the produced type's schema (`walk-types.js` Case A). The bridge skipped that check, an asymmetry the whole-branch review of the cross-reference-bridge iteration re-flagged as the sharp, concrete instance of the broader name-only-matching concern (the general form stays filed – it doesn't manifest; see below).

The failure mode if it ever fires: a producer whose dominant path id names something *other* than the produced resource's own id (a status sub-resource's token, a nested collection key) threads a phantom field. The runnable emits `PHANTOM=$(echo "$RESP" | jq -r .phantom)` plus a `-d '{"phantom":"<phantom>"}'` body – both silently yielding `null` on a real paste-and-run. That fabricated-looking artifact is exactly what this skill family exists to prevent.

## The verified problem

A unit-level repro (`test/test-walk-types.js`) and an end-to-end repro (`test/test-scenario-integration.js`) both reproduce it on a new `bridge-area` fixture, `refE`:

- `refE.createGizmo` produces the `Gizmo` body type from nothing (the from-nothing producer the bridge surfaces).
- `refE` *has* a dominant path id – `gizmoToken`, off `getGizmoStatus`'s `/gizmos/{gizmoToken}/status` path – so `dominantPathId('refE')` is non-null. This is the distinction from the existing `refD` degrade case (where `dominantPathId` is null because the family addresses nothing by id).
- But the produced `Gizmo` type carries `{gizmoId, label}` – **no `gizmoToken`**. The dominant path id is a real path param on the *reference*, just not a field on the *produced type*.

Pre-fix, pass 2's runnable contained `GIZMOTOKEN=$(echo "$CREATEGIZMO_RESPONSE" | jq -r .gizmoToken)` and `-d '{"gizmoToken":"<gizmoToken>"}'` – captured verbatim in the RED test output. `createGizmo` returns no `gizmoToken`, so that line extracts `null` on every real run.

## What changed

One logical change, applied at the two bridge sites that derive the threading field, plus a consolidation so the bridge and `findProducers` share one produced-type property check:

- **`typeHasProperty(cacheRoot, reference, typeName, fieldName, area)`** – extracted from `findProducers`' inline Case-A check (load type file, `normalizeSchema`, `fieldName in props`). `findProducers` now calls it; behavior-preserving (a `p.ref` produced entry never carries `inlineProperties`, so the old early-`continue` on a missing type file was unreachable as a Case-B guard). This is the DRY consolidation: the bug *was* an asymmetry between two property checks that should be identical, so the fix makes them literally the same function – they can't drift again.

- **`bridgeThreadingField(cacheRoot, producerRef, producedType, area)`** – `dominantPathId(producerRef)` verified through `typeHasProperty` against the produced type; returns null when the dominant id is absent (or there is none). Both bridge sites call it:
  - `walkTypes` pass-1 labeling (`walk-types.js`) – the target's from-bridge input now carries `needsNaming: true` instead of a phantom field name.
  - `scenario.js` pass-2 edge `viaField` – null when phantom, so the existing null-viaField graceful-degrade path (compose strips it from `idPassing`; curl-block suppresses the `jq` line and emits the "supply its id from the producer response manually" note) handles it.

The phantom case now degrades *identically* to the `refD` null-dominant-id case. No new degrade machinery – the fix routes a second cause (phantom field) into the already-built, already-tested `needsNaming` path.

## Why the general name-only concern stays filed

The originating TODO's headline concern (`findProducers` matches field *name* without *type* compatibility, so a bare `id` on two unrelated types could collide into a false edge) remains unfixed and that is deliberate. A whole-cache probe (779 `schemaRef`-body endpoints, 5+ commerce references) found **4 cross-reference bridge cases and zero phantom-field mismatches**: `createOrder`→`Basket.basketId` and 3× `customers`→`Customer.customerId`, all with the dominant path id present on the produced type. The general collision also has zero manifestation (the prior probe: 0 of 204 in-reference edges key on a bare/generic field). The SCAPI/OCAPI convention of specifically-named ids (`basketId`, `customerId`) is what keeps both latent.

The split: the *general* fix is speculative surface against a non-manifesting problem (and risks the legitimate `basketId` 3-producer fan-in). The *bridge* fix is a parity fix – bring the bridge to the discipline `findProducers` already had – with a sharper blast radius (a phantom field reaches a paste-and-run runnable, not just an internal graph edge) and zero new surface (it reuses `needsNaming`). So this iteration fixes the bridge and leaves the general guard filed until a real collision appears.

## Tests added this iteration

- `test/test-walk-types.js` – pins the pass-1 site: `submitGizmo` with `siblingRefs:['refE']` surfaces `createGizmo` as a candidate but the from-bridge input degrades to `needsNaming:true` / `name:null` (no phantom `gizmoToken`).
- `test/test-scenario-integration.js` – pins the pass-2 site end-to-end: pass 1 surfaces `createGizmo`; pass 2 composes both ops, the runnable contains **no** `jq -r .gizmoToken` and **no** `GIZMOTOKEN=` line, and carries the honest missing-id note. This is the assertion that fails (verified RED) before the fix.
- Fixtures: `bridge-area/refE/` (`createGizmo`, `getGizmoStatus`, `types/Gizmo`, `types/GizmoStatus`, `_index`), `bridge-area/refA/submitGizmo` + `types/{Gizmo,GizmoOrder}`, `refE` added to `_landing/bridge-area.json` and `submitGizmo` to `refA/_index.json`. The fixture-layout-conformance guard validates them.

## Results

Structural change, no synthesis-eval surface of its own (the createOrder fixture from `iteration-cross-reference-type-bridge` already guards the *real* bridge path, which this iteration's probe confirmed is unaffected – `basketId` still threads). Verification is the test suites:

- `dsc-scenario`: 10/10 files pass (`bash test/run.sh`), including the existing bridge cases (refB/refB-v2 multi-version, refC single-version survival, refD null-dominant-id degrade) – none regressed.
- `dsc-endpoint-help`: 4/4 pass (shares the `normalizeSchema` pattern; untouched here, sanity-checked).
- Real-cache probe post-fix: the 3 distinct legitimate bridges (`shopper-baskets`/`shopper-baskets-v2`→`Basket.basketId`, `shopper-customers`→`Customer.customerId`) still resolve their correct threading field through `bridgeThreadingField` – the verification nulls only the phantom case, never a real one.

## Surprises

- **`walk-via-agent.md` needed no update.** The walker's sub-agent contract documents the single-reference `findProducers` match rule (which the refactor preserves verbatim) and the `externalInputs` auth-boundary mechanism – but never the deterministic `dominantPathId` bridge threading field, which lives entirely in `scenario.js`/`walkTypes` orchestration. So the "keep in sync" contract at the top of `walkTypes` stayed satisfied without a doc edit.
- **The fix is almost entirely subtraction of trust, not addition of code.** The phantom field already had a home – `needsNaming` and the null-viaField degrade path were built for the `refD` case in the prior iteration. This iteration just routes a second cause into it. The net new logic is two small functions, one of which is a verbatim extraction of code that already existed.
