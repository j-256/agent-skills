# iteration-submittability-registry

## Hypothesis

dsc-scenario plans the **structural** minimum (FK-threading only), so for `createOrder` it emits a `createBasket` with an empty `{}` body – which 400s at submit. That violates the skill's "minimum set of calls to accomplish your goal" promise: the engineer pastes the plan, it fails, and they're back to hunting which endpoint populates the basket. The submittable-minimum (which basket fields must be populated for `createOrder` to accept it) is in **neither** the machine-readable spec (`Basket.required` is `null`) **nor** the basket-prep prose (it states no hard required-set), so the type-graph walk structurally cannot see it. The fix is a **curated, cited registry** (`scripts/submittability.json`) consumed deterministically by `scenario.js` – the same category of encoded fact as the SLAS auth-routing table, not model fabrication.

## What changed

- **`scripts/submittability.json`** (new) – registry keyed by produced-resource type. The `Basket` entry holds the empirically-verified submittable-minimum as **body contents** (the producer body shape), `needed: []` (no separate populate steps), with `provenance` + `confidence: "curated"`.
- **`scripts/submittability.js`** (new) – `loadRegistry` / `lookupSubmittability` / `applySubmittability`. Looks up the target's body type, annotates the **producer** step (`createBasket`) with `submittableBody`, returns an advisory.
- **`scripts/scenario.js`** – single `emitPlan()` output path folds the registry in before rendering. Pure no-op when the target's body type has no entry (today's behavior exactly).
- **`scripts/curl-block.js`** – renders the curated body banner (business-rule framing + provenance + per-field failure modes) and layers the flat curated fields into the producer's `-d` body.
- **`SKILL.md`** – new "Submittability registry" section + Flow step 5; tells the model to populate a realistic producer body and frame it as a curated business-rule, never as spec, and NOT to expand prep into separate steps.
- **`evals/dsc-scenario/synthesis-eval.json`** – `synthesis-scenario-createorder-basketid-threading` retuned: kept the over-decomposition step-exclude (still correct – prep lives in the createBasket body), added two positive guards (payment-instrument discriminator + curated-framing guard).

## The Phase-0 evidence trail (why the needed-set is what it is)

The needed-set was **empirically verified on a live B2C Commerce instance** (drop-one testing, shopper-baskets-v2 → shopper-orders), because it is not derivable from DSC. `createBasket` always returns 200 and never enforces submittability; the entire gate is at `createOrder`. Each field is individually required – dropping it yields a distinct 400:

| Dropped field | createOrder result |
|---|---|
| (control, all present) | 200, order created |
| `productItems` | 400 `Product Items Required` |
| `shipments[].shippingMethod` | 400 `Validation` – "Order total missing, calculation failed" |
| `shipments[].shippingAddress` | 400 `Empty Shipping Address` |
| `billingAddress` | 400 `Empty Billing Address` |
| billing **name** | 400 `Invalid Billing Address` |
| `paymentInstruments` | 400 `Missing Payment Method Id` |

**Two divergences from the maintainer's Script-API-derived expectation** (the reason live verification was non-negotiable, not a rubber-stamp):

1. **SCAPI `createOrder` requires a payment instrument.** The `dw.order` Script API authorizes payment as a separate step, so its `createOrder` floor didn't include one; SCAPI rejects at submit without it. This is the registry **discriminator** in the eval: createOrder's only structural input is `basketId`, so a structural-only (pre-registry) plan never surfaces payment – its presence proves the registry fired.
2. **Billing requires BOTH first and last name**, not "first OR last" (the Script API `setFirstName`-only floor). first-only → 400, last-only → 400, both → 200. Encoded as instance-observed (address required-fields are merchant-configurable).

Shape decision: a single rich `createBasket` body carrying all of the above yields a basket `createOrder` accepts (verified end-to-end, HTTP 200). So the registry encodes **body contents**, `needed: []` – no separate populate calls. This is the maintainer's preferred performant single-call shape, and it keeps the over-decomposition guard correct (prep belongs in the body, not as separate steps).

(Live evidence captured to an out-of-tree scratch file during the session; credentials and tokens were kept out of every committed artifact. The in-tree provenance is the empirical drop-one result plus the `createOrder` reference URL for the general "orders are built from prepared baskets" claim.)

## Eval results

Harness: `stream-eval synthesis` (harness_version `7a049a3d`), model Sonnet 4.6 (`STREAM_EVAL_MODEL=sonnet`), `--profile isolated`, fixture `synthesis-scenario-createorder-basketid-threading`, 17 assertions including the two new positive guards.

- **Strict pass rate: 3/3** (all runs pass every assertion, 0 failed asserts, 0 contaminated). `first_tool=Skill`, `first_skill=dsc-scenario` on every run. ~60–66s per run.
- Notable per-run behavior: every run produced the corrected 4-step plan (SLAS leg 1, SLAS leg 2, **populated** `createBasket`, `createOrder`) – not the pre-registry empty-`{}` chain and not an over-decomposed separate-populate-steps chain. The curated framing held on Sonnet: runs explicitly stated the basket fields are required by `createOrder`, not `createBasket`, and attributed the minimum to a "checkout business-rule (curated, not stated in the spec)" with the empirical provenance, never to the `createBasket` spec page. The payment-instrument discriminator assertion passed on all runs (proves the registry fired – payment is not a structural input of `createOrder`). The model independently surfaced the sharpest version of the insight: "createBasket never rejects an empty body (always 200), but createOrder will 400 on an unpopulated basket."
- Full 8-fixture suite re-run after the assertion retune (3 runs each, Sonnet, isolated): **7/8 fixtures strict-pass.** All seven SCAPI fixtures (createorder, inreference-producer-pick, add-coupon-checkout, registered-silent/-b2c-primed/-federated, am-admin-orders) pass 3/3. The new createorder assertions did NOT false-fail (the finding-2 risk below did not materialize).
- **The lone failure – `synthesis-scenario-ocapi-submit-basket` (2/3) – is pre-existing and orthogonal to this change** (root-caused below). It touches no registry code path (`post-orders`' body type is not `Basket`), and `scenario.js` composes it correctly against the right slug. Not introduced by the registry; see the OCAPI finding.

## OCAPI fixture finding (out of scope for this iteration – flagged, not fixed here)

`synthesis-scenario-ocapi-submit-basket` regressed from a prior 5/5 (iteration-ocapi-path-prefix-fix) to 2/3 in this run. Root-caused via systematic-debugging:

- **Root cause: OCAPI Shop reference slug discovery.** The model cannot guess the reference slug. The real slug is `ocapi-shop-orders` (target `post-orders`), under area `commerce_b2c-commerce`. The model tried `b2c-commerce-ocapi-shop-api`, `ocapi-shop-api`, `b2c-commerce-ocapi-shop` – all 404 – then either eventually navigated to the right page via WebFetch (runs 2/3, ~300–310s, near the 360s timeout → PASS) or gave up and **hand-wrote an answer from training data citing a non-DSC legacy URL** (run 1, 145s → FAIL, and an integrity violation: a fabricated, non-`developer.salesforce.com` answer).
- **`scenario.js` itself is fine**: given the correct URL (`.../references/ocapi-shop-orders`, target `post-orders`) it composes cleanly (SLAS branch, no bridge). Verified deterministically against the warm cache.
- **`aliases.js` resolves OCAPI to the area-landing (`/references`) but not to a specific shop reference slug.** There is no `ocapi-shop-orders` / "submit basket" → slug bridge, and SKILL.md gives no OCAPI slug-discovery procedure.
- **Two distinct issues**: (1) slug discoverability (fixable via an alias/landing-scan + SKILL.md guidance); (2) fabricate-when-stuck instead of declining (deeper; the family's no-fabrication contract should make the model decline + ask for the URL, not invent one). Both predate this iteration. Recommend a dedicated `iteration-ocapi-slug-discovery` rather than bundling into the registry commit. This directly gates demo prompt 4 (OCAPI submit basket) – Phase 2 must pre-warm the OCAPI refs and/or this must be fixed first.

## Surprises / rejected alternatives

- **Rejected: graft separate populate steps** (`addItemToBasket`, etc.) as the registry's `needed[]`. Phase-0 showed the submittable state fits in one `createBasket` body, which is also the maintainer's preferred shape; separate steps would be the over-decomposition the existing guard already forbids. So the registry's `Basket.needed` is `[]` and the minimum is carried as `bodyContents`.
- **Rejected: relax the over-decomposition exclude** (the design anticipated this). Under the body-content shape there are no registry-justified *separate* steps to allow, so the exclude stays verbatim; instead a positive populated-body guard was added so a regression to the empty-`{}` plan fails red.
- **The maintainer's stated minimum was incomplete for SCAPI** (payment + both-names), which is the whole reason the design mandated empirical verification rather than encoding the Script-API floor directly.
