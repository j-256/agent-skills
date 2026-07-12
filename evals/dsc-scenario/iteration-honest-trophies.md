# iteration-honest-trophies – capstone of the deterministic-runnable arc

Base: `33bea40` (iteration-body-recursion). Landed as one squashed commit on local main. Build on Opus (implementers + reviewers), eval on Sonnet (`global.anthropic.claude-sonnet-4-6`).

## Hypothesis

With auth (sub-project 1) and body (sub-project 2) rendering deterministically, the capstone would be mechanical: re-shoot the worked-example trophies from strict-pass transcripts, add a standing runnable guard, and the trophies would run clean with no silent corrections. That hypothesis was **wrong in an instructive way** – see below.

## The surprise (the knowledge the diff can't carry): executing verbatim exposed THREE more renderer seams

The prior sub-projects live-grounded auth at the token-mint layer and the body at the shape layer, but nobody had ever run the *entire* emitted runnable end-to-end (SLAS-guest live was skipped both times for lack of a redirect URI). Doing so here – the capstone's whole premise – reddened on three seams, each a silent hand-correction baked into the *old* trophies, each independently blocking a verbatim SCAPI order:

- **Fix A – body-threaded id dropped.** `createOrder` captured `BASKET_ID=$(... jq -r .basketId)` and `plan.idPassing` recorded the edge, but the consumer body rendered `-d '{"basketId":"<basketId>"}'` – a dead literal. Path-threaded ids interpolated fine; only *body* refs were stranded. Fix: thread idPassing-known body fields into `${SHELL_VAR}`, emitted expansion-safe (extend the `useHeredoc` trigger to "stub contains a `${...}` ref"). Both families (`basketId` / `basket_id`).
- **Fix B – SLAS token exchange omitted `channel_id`.** The guest `getAccessToken` 400s `"Guest token requires a channel_id parameter"`. This is **spec-documented**, not a fabricated correction: the getAccessToken description states *"As of July 31, 2024, SLAS requires the `channel_id` query parameter in token requests."* The renderer's shared SLAS token leg simply never emitted it. Fix: add `channel_id=${CHANNEL_ID}` to `renderSlas`'s token formFields (guest / registered-b2c / federated; AM untouched).
- **Fix C – required `in:query` params dropped.** `createBasket`/`createOrder` rendered with no `?siteId=` and 400 `"Missing required query parameter(s): 'siteId'"`. The renderer emitted only the OCAPI `client_id` auth-floor query, never the step's own `requiredInputs` where `in==='query'`. Fix: merge the two sources, dedup by name (floor wins). OCAPI stays byte-identical (its siteId is a path segment; `post-baskets`/`post-orders` have empty query-requiredInputs).

The takeaway for future arcs: **"renders deterministically" and "runs verbatim" are different claims.** Unit tests + shape-level live checks proved the former; only end-to-end execution proved the latter, and it found three gaps that had been masked by trophies which silently corrected them. The old `createorder-prereqs` trophy even disclosed its correction ("the captured `paymentInstruments` entry was `{paymentMethodId, amount:0}` ... Corrected here") – that disclosure is exactly the anti-pattern this arc retires.

## Eval measurements (Sonnet, single-fixture strict, iteration-honest-trophies)

Each trophy was captured from its own single-fixture synthesis run (isolated to sidestep the `add-coupon` cache-spelunk timeout that aborts a full-suite run). All strict (`--runs 5`, every run every assertion):

| Fixture | Result | Notes |
|---|---|---|
| `synthesis-scenario-createorder-basketid-threading` | 5/5 strict | fast fixture; clean |
| `synthesis-scenario-ocapi-submit-basket` | 5/5 (after regex fix) | run 4 first FALSE-FIRED the OCAPI migration-advocacy `final_text_excludes` guard on a neutral comparison-table header (`worth knowing:\n\n\| \| OCAPI Shop \| SCAPI`); the verb-gap `[^.]` crossed a newline + table `\|`. Fixed by tightening the gap to `[^.\n\|]` and **re-scoring the 5 saved transcripts** (no re-run: generation is non-deterministic, scoring is deterministic) -- run 4 clears, 1/2/3/5 unchanged; a 7-phrasing advocacy battery still fires. Second re-anchoring of this guard. |
| `synthesis-scenario-add-coupon-checkout` | 5/5 strict | the spelunk-timeout risk did NOT materialize under single-fixture isolation (100-124s/run vs the 300s ceiling) |
| `synthesis-scenario-inreference-producer-pick` | 5/5 strict | clean |

Method note worth keeping: **to validate a scorer/regex change, re-score the saved transcripts, don't re-run the eval.** Re-running re-rolls the (non-deterministic) generation and tests the fix against *different* outputs; re-scoring holds generation fixed and isolates the one variable that changed. A good synthesis eval has deterministic scoring over non-deterministic inputs -- so a saved transcript is the correct unit to re-score.

## Live grounding: orders placed

Every trophy was executed VERBATIM (fill-in vars supplied, only a trailing display line added) against the live sandbox and confirmed to hit its honest signal with zero edits to the emitted structure:

- `createorder-prereqs` (SLAS guest PKCE) -> order placed
- `ocapi-submit-basket` (OCAPI-native guest JWT) -> order placed
- `add-coupon-checkout` (SLAS registered + coupon `5ties`) -> order placed, coupon accepted (`valid:true`)
- `inreference-prereq` (SLAS registered) -> payment instrument added (its target is `addPaymentInstrumentToBasket`, NOT order submission)

Plus the A+B+C composition proof (whole-runnable guest createOrder end to end) and the two live-render tests (SCAPI+OCAPI body orders, AM+OCAPI token mints). More than a dozen real orders were placed across the session. Order numbers are intentionally NOT recorded here (they are instance state, and this note ships in a public repo); the durable facts are the pass/fail signals above.

`5ties` nuance: it is SFRA demo data, accepted (`valid:true`) but currently attaching no active promotion (`no_applicable_promotion`), so no discount lands -- the trophy demonstrates the add-coupon -> checkout call *sequence*, not a price change. Disclosed in the trophy provenance.

## The inreference finding: renderer-emitted vs caller-supplied

`inreference-prereq` clarified a boundary the arc's "no silent correction" rule depends on. Its target, `addPaymentInstrumentToBasket`, has NO structural body input (the walk finds none) and NO submittability entry -- so the renderer correctly emits the *call shape* (auth + createBasket + the target call with threaded `${BASKET_ID}` + `?siteId=`) but NOT a payment payload. The verbatim runnable therefore returns an empty `paymentInstruments[]`: the renderer didn't invent the body, which is *correct* scope, not a bug.

The honest resolution: the payment payload is **caller-supplied content**, added to the trophy and disclosed as such (the same category as add-coupon's coupon step -- user/caller content the renderer doesn't own), NOT passed off as renderer output. This is the distinction the arc turns on: editing to make a runnable work is fine; the anti-pattern is *silently* editing renderer output to mask a defect. A telling corroboration: the OLD inreference trophy had hand-added `{amount:0, paymentMethodId:CREDIT_CARD}` -- which live-verification proved adds NOTHING (`instruments=0`; `cardType` is required). So the old silent correction wasn't just undisclosed, it was also wrong. The working body is `{paymentMethodId:CREDIT_CARD, paymentCard:{cardType:Visa}}`.

Rule of thumb this leaves for the family: renderer emits structure the walk + submittability can derive; a target op's own request payload (when it isn't a threaded id and has no submittability rule) is the caller's, supplied + disclosed, never silently baked in as if the skill produced it.

## Idempotency: the live gate now cleans up

The registered trophies (add-coupon, inreference) run as the SAME shared test shopper, whose per-customer basket quota is small -- so running them back-to-back exhausted it and the second failed to create a basket. This was invisible until the full live suite ran in one pass (each trophy passed individually). Fix: `_shared/live-order.js` gained `clearBasketsSnippet` (a create -> quota-fault-parse -> delete loop, because Shopper Baskets has NO list-my-baskets op -- the reliable signal is the basket id the quota fault names in parens), and the runnable test clears the shopper's baskets before each registered trophy. The full live suite is now repeatable. Guest trophies need no cleanup (fresh customer per token). This was the cleanup gap the maintainer flagged; worth carrying forward: **a live gate that mutates instance state must clean up after itself, or it stops being re-runnable.**

## Real-identifier scrub (mid-arc security correction)

The sandbox realm identifier had been committed as a literal across ~19 tracked files (most pre-dating this arc, some added by it). It was scrubbed to a placeholder (format `<letters>_<digits>`); the live tests now read the realm from `DSC_LIVE_REALM` (env, gitignored) and use generic credential var NAMES rather than realm-suffixed ones (the names leaked it too). Provenance prose drops the realm entirely (keeping RefArch + API version as the meaningful coordinates); only illustrative examples use the placeholder. A full identifier sweep (emails, customer ids, order numbers, JWTs, hosts) found nothing else real -- the `zzrf_001` / synthetic-JWT material in the dsc-endpoint-help fixtures is the public RefArch reference realm + hand-crafted fixture tokens (the repo's `example.com` equivalent), deliberately synthetic. Because the realm was in pushed public history, the working-tree scrub is paired with a `git filter-repo` history rewrite (a `--replace-text` rule mapping the real realm + its hyphenated host form to the placeholder, mirror-backed, force-pushed) -- the tree scrub alone doesn't purge already-published commits.

## Method notes worth carrying

- **"renders deterministically" != "runs verbatim".** Only end-to-end execution of the emitted runnable catches auth/threading/query seams that unit + shape-level checks miss. The capstone's live gate is what surfaced A/B/C.
- **Re-score saved transcripts to validate a scorer change; don't re-run the eval.** (See Eval measurements.)
- **A mutating live gate must self-clean** or it isn't repeatable. (See Idempotency.)
- **Never `bash -x` a credential-bearing script** even when debugging -- it echoes secrets to your own context. The masked-signal driver pattern (only `ORDER_OK no=`, `TOKEN_OK len=`, etc. to stdout) is why the shipped tests never leak; a debugging `-x` during this session exposed a JWT to the controller transcript (nothing committed), a reminder the discipline is for debugging too.
