# iteration-curated-body-assertions

## Finding

The worked examples headline the curated runtime body (the op-body / producer-body curated facts: `addPaymentInstrumentToBasket`'s runtime-required `paymentMethodId` + `paymentCard.cardType`; the `createOrder` submittable-minimum), but the fixtures backing them asserted none of it. Audited all four example-backed scenarios: **3 of 4 had the gap** (example ⊃ fixture on the curated body); only `synthesis-scenario-createorder-basketid-threading` already guarded it. So the skill's headline curated-runtime-fact capability was emitted and demonstrated but **unguarded** on three of four scenarios – a regression that dropped the curated body (reverting to a bodyless call that 400s at runtime) or presented it as spec-derived (losing the trust-layer honesty) would have passed the eval green.

## What changed

Two assertions each added to the three gapped fixtures (`inreference-producer-pick`, `add-coupon-checkout`, `ocapi-submit-basket`), modeled on the already-covered `createorder-basketid-threading`:

- **payment leaf present** – `paymentMethodId` / `CREDIT_CARD` (OCAPI snake_case `payment_method_id` for the OCAPI fixture).
- **curated / not-stated-in-spec / runtime-verified framing present** – the trust-layer honesty invariant (a runtime override is surfaced as curated, per `docs/commerce-auth-matrix.md` "Spec corrections and their self-invalidation").

All customer-facing `final_text_matches` (no tool-path assertions). The assertions pin content the skill already emits – they guard, they do not tune-to-green.

## Eval result

`stream-eval synthesis`, Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6`), `--runs 5` strict:

- `inreference-producer-pick`: 5/5.
- `ocapi-submit-basket`: 5/5 (one run carried a worktree-contamination flag – eval-Sonnet wrote under `$HOME` mid-run; harness-isolated, operator repo untouched, assertions passed).
- `add-coupon-checkout`: 5/5 at `--timeout 600`. It is the heaviest fixture (11-step checkout) and crosses the 300s default under API latency – 2 runs timed out at 300s in the combined run, all 5 clean with headroom. A timeout-headroom issue, not an assertion issue.

## Precedent surfaced

Deleting a content-redundant iteration note is not safe on content-recoverability alone: several `todo-*`/superseded notes are **citation-load-bearing** – cited by name in a live `synthesis-eval.json` assertion `because` (rule provenance) or as a named measurement baseline in other notes. The note-value test is "is the content recoverable?" AND "does any tracked artifact cite it by name?".
