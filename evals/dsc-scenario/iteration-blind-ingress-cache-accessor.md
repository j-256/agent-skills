# iteration-blind-ingress-cache-accessor

## Hypothesis

First brick of the "scripts traverse, model judges" push: remove the model from cache orchestration. The model was instructed (SKILL.md) to call `scrapeRefresh` and decide when to warm references, and in eval transcripts sometimes `cat`/`Read` cache JSON directly to hand-assemble a plan (the cat-spelunking failure mode, `_TODO-dsc-scenario-cache-bypass-via-cat.md`). Replace that with a blind-ingress accessor that `scenario.js` calls: it refreshes if absent/stale, serves stale-with-a-flag on refresh failure, and reads the cache for the model. The model never scrapes or reads cache files.

Design doc: `docs/superpowers/specs/2026-06-28-blind-ingress-cache-accessor-design.md` (gitignored).

## What changed

- **`_shared/scrape/cache-access.js` (new) – the blind-ingress accessor.** `getReference({referenceUrl, cacheRoot, scrapeScript})` resolves area/ref id (reusing `areaKeyFromReferencesPath` + the last-path-segment id), refreshes via `scrapeRefresh` (which applies the existing TTL), serves stale (`stale:true`) if a refresh fails but a cached dir exists, hard-throws `CacheAccessError` if nothing is cached. Returns `{area, reference, dir, refreshed, stale, scrapedAt, landingFile}`. Plus `siblings(cacheRoot, area)`, a pure read of the landing manifest for the next brick (cross-ref walk). **Lib-only, no CLI** – deliberately: a model-facing CLI on a write-triggering accessor would reintroduce the cache-orchestration-by-model this iteration removes (the read-only `reference-versions.js` may have a CLI; the side-effecting accessor must not).
- **`scenario.js` – routed through the accessor.** Both `scrapeRefresh` call sites (initial + post-version-bump) now go through `getReference`; a `staleness[]` accumulator collects any reference served stale and is emitted as a new `staleness` field on the output JSON. A failed scrape with cached data is now a *stale-serve* (exit 0 + warning), not a hard exit-3 – exit 3 is reserved for failed-scrape-with-nothing-cached.
- **`SKILL.md` – invariant rewritten from model-instruction to mechanism.** "All DSC fetches go through the scrape library (via `scrapeRefresh`)" → "`scenario.js` owns all cache access; you never scrape, `cat`, `Read`, or `grep` the cache – pass the target to `scenario.js`." Added the mandatory staleness-warning output rule (canonical format, absolute `YYYY-MM-DD` date, relative dates forbidden) and an explicit "the two judgments that remain yours" note (NL-goal→operationId, prose ordering) so the script/model boundary is visible. Flow step 2 no longer has the model warm the cache; the sub-agent walk is demoted to the cross-reference exception.
- **`fake-scrape.js` – now writes files on `ok-refreshed`.** The fixture only printed a summary before; it now mirrors the real scraper's side effect (writes the ref dir `_index.json` + area landing), so an accessor whose whole job is filesystem state can be tested offline. Purely additive – existing summary-only consumers (`test-scrape-refresh.js`, integration tests using `ok-fresh`) are unaffected.

## Canonical staleness warning (decided, not deferred)

When `staleness` is non-empty, the answer opens (above `## Scenario:`) with:

> **⚠ Stale spec data.** Could not refresh `<reference>`; this plan was built from cache last scraped `<scrapedAt>`. Verify against the live reference before relying on it.

`<scrapedAt>` is absolute `YYYY-MM-DD`, verbatim from the field. Relative phrasing ("3 days ago") is rejected, not deferred – it forces a nondeterministic today-relative computation, the exact thing this iteration removes.

## Tests

- **`_shared/tests/test-cache-access.js` (new):** cold / warm-fresh / warm-stale / serve-stale-on-fail / hard-fail / landing-eager+siblings / malformed-args. Serve-stale and hard-fail branches mutation-checked (disabling the serve-stale branch flips serve-stale to a throw – confirmed RED).
- **`test-scenario-integration.js`:** the old "scrape failure → exit 3" test split into two – uncached-ref→exit 3 (hard fail) and cached-ref→exit 0 + `staleness` names the reference with its `scrapedAt` (serve-stale, verified RED before routing). The existing local-walk and prefer-latest tests stay green.
- **Cat-spelunking prevention + staleness surfacing are verified at the integration layer, NOT synthesis-eval** – the synthesis harness has no per-fixture env hook to force a refresh failure (a live scrape just succeeds), and forcing it globally would break every other fixture. Same principle as `iteration-synthesis-assertion-relaxation`: don't assert in synthesis-eval what the environment can't faithfully produce.

## Results

Behavior-preservation eval – the two guard fixtures (`synthesis-scenario-createorder-basketid-threading`, `synthesis-scenario-add-coupon-checkout`), Sonnet, `--profile isolated`, live scrape, 3 runs each: **2/2 fixtures strict-pass, 6/6 runs, 0 failed asserts, 0 retries, 0 timeouts, 0 contamination** (346s total; per-run 81–133s, genuine compose time). Every run fired `dsc-scenario` first (`first_skill=dsc-scenario`). Artifacts: `runs/iteration-blind-ingress-cache-accessor/results-guard.json`.

This proves the one thing the synthesis-eval is scoped to here: the ingress change is *output-neutral* – the cache now warms through the accessor instead of model-driven `scrapeRefresh`, and the plans are unchanged (same operations cited, basketId threaded, v2 defaulted). It does NOT prove createOrder's structural plan improved (that's the next brick), and does not directly assert cat-spelunking/staleness (verified at the integration-test layer, per the Tests section).

Unit + integration: `_shared` 14/15 (the one red is the pre-existing, unrelated `test-catalog-keys` scapi collision, filed separately); `dsc-scenario` 10/10.

Reviewed by an independent Opus pass: verdict "sound," no blockers. Applied its should-fix/nit findings – dropped the unused `area`/`reference` override params on `getReference` (the resolve half could disagree with the scrape half), removed a dead `landingUrlFor` helper and an unused import, and added a comment locking in the deliberate stale-over-reporting on the bump path.

## Surprises

- **The accessor's "landing-eager" step was already free.** The spec planned a separate landing fetch; a successful reference scrape *already* writes `_landing/<area>.json` (the prefer-latest foundation fix, `scrape.js:271`). So the accessor relies on that side effect rather than a second call – simpler, and reconciled into the spec during the build.
- **The fake-scrape fixture had the same drift trap as the walk-types fixtures.** It printed a summary but wrote no files, so it couldn't test a filesystem-state accessor. Fixing it to mirror the real scraper's writes is the fake-scrape analogue of the walk-types fixture-conformance lesson: a fixture that doesn't match what the real thing produces makes the test lie.

## Follow-up surfaced

- Cross-reference walk (brick 2) consumes `siblings()`; that's where createOrder's target-only plan gets fixed.
- If a future harness gains a per-fixture env knob, a synthesis fixture asserting the stale warning's invoked form becomes buildable; not today.
