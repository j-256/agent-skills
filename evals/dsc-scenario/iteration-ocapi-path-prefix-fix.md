# iteration-ocapi-path-prefix-fix

Status: SHIPPED. Resolves the OCAPI path-prefix regression filed in `iteration-synthesis-baseline`. dsc-scenario synthesis-eval moves from 14/15 → 15/15 strict; OCAPI fixture moves from 4/5 (after iteration-slas-cross-ref-fix) → 5/5. All three dsc-scenario fixtures now pass strict at the new 6-7 assertion levels added across the two SKILL.md tightenings in this branch.

## Hypothesis tested

The OCAPI path-prefix regression observed in `iteration-synthesis-baseline` (2/5 OCAPI runs, then 1/5 after the SLAS fix lifted some shared variance) was caused by SKILL.md's "Output composition" section being silent on URL-prefix completeness in the runnable bash block. The skill's prose said `## Run it` should contain `plan.runnable` verbatim but didn't anchor on what canonical URL prefixes look like for SCAPI vs OCAPI -- so on a subset of runs the model emitted a bash block using bare spec-relative paths (`/baskets`, `/orders`) instead of the full prefix (`/s/{siteId}/dw/shop/v25_6/baskets`).

Fix: tighten the "Output composition" section with explicit prefix templates per reference family (SCAPI / OCAPI / SLAS) and a negative example calling out the regression directly.

The fix is prose-only -- no script edits, no `scenario.js` algorithm changes. The runnable composition step in `scenario.js` already had access to the path data; the gap was the user-facing template not telling the model what the canonical prefix looks like.

## What changed

One file, one section.

### `skills/dsc-scenario/SKILL.md` "Output composition" -- expanded after the `## Run it` template line

Inserted a 6-line block after `## Sources` template and before the structural-evidence guidance:

```
The `## Run it` block is mandatory. The runnable bash must use canonical full URL paths -- not the spec's relative paths -- so a teammate can paste-and-run without reconstructing the URL prefix. The prefix differs by reference family:

- **SCAPI:** `${BASE_URL}/checkout/<reference>/v1/organizations/${ORG_ID}/...?siteId=${SITE_ID}` (e.g. `/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets`).
- **OCAPI:** `${BASE_URL}/s/${SITE_ID}/dw/shop/v<version>/...` for shop API, `/s/-/dw/data/v<version>/...` for data API. Don't abbreviate to `/baskets` or `/orders` -- those work only inside the spec doc, not against a sandbox.
- **SLAS / `shopper-login`:** `${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/...`.

If the bash block uses bare paths from the spec (e.g. just `/baskets` or `/orders` without the `/checkout/...` or `/s/<siteId>/dw/shop/v<version>/...` prefix), the answer fails the paste-and-run criterion -- a teammate has to reconstruct each URL. That's a regression on the skill's main deliverable; the runnable should be runnable as-is.
```

The negative example (`Don't abbreviate to /baskets or /orders`) anchors directly on the failure shape from the failing OCAPI runs in the baseline iteration. The SCAPI prefix template wasn't strictly needed (no SCAPI runs failed on this) but is included for symmetry: if a future run regresses on SCAPI prefix discipline, the same prose covers it without a follow-up tightening.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/dsc-scenario/synthesis-eval.json --runs 5 --workers 4 --timeout 360 --out evals/dsc-scenario/runs/iteration-ocapi-path-prefix-fix/results.json`

Wall-clock 569.1s (down from 709.5s on the SLAS-fix iteration -- model produces tighter answers on the first pass when the prefix template removes a class of revision). Exit code 0. 0 retries, 0 aborts.

| Fixture | Pre-baseline | After SLAS fix | After OCAPI fix | Total improvement |
|---|---|---|---|---|
| `synthesis-scenario-add-coupon-checkout` | 5/5 | 5/5 | 5/5 | unchanged |
| `synthesis-scenario-createorder-basketid-threading` | 5/5 | 5/5 | 5/5 | unchanged |
| `synthesis-scenario-ocapi-submit-basket` | 3/5 | 4/5 | 5/5 | +2 runs |

Total: 15/15 strict (up from 13/15 baseline → 14/15 after SLAS → 15/15 after OCAPI). All 17 assertions firing across all 5 runs of all 3 fixtures = 85 of 85 individual assertion firings passed.

The `final_text_matches: /dw/shop/v\d+` assertion that was failing 2/5 in baseline now passes 5/5. Manual transcript-spot-check on each post-fix OCAPI run confirms the runnable bash uses full paths like `/s/${SITE_ID}/dw/shop/v25_6/baskets` consistently across the runnable block, not just the target operation.

## Surprises

- **The fix lifted OCAPI from 3/5 → 5/5 in one tightening.** I'd budgeted for the possibility that the negative-example anchor wasn't strong enough and that the model would still occasionally regress on subtle abbreviation. It didn't -- the explicit "Don't abbreviate to /baskets or /orders" caught the regression cleanly.
- **Mean elapsed dropped from 709.5s to 569.1s after the OCAPI fix.** Likely because the model spends fewer turns iterating between `Method/path: POST /orders` (spec-relative) and `${BASE_URL}/s/${SITE_ID}/dw/shop/v25_6/orders` (canonical) -- the prefix template gives it a target on the first try. Speed wasn't a stated goal but it's a useful side effect.
- **No regression on the SLAS-handling assertions added in iteration-slas-cross-ref-fix.** Stacking two SKILL.md tightenings in one branch could have introduced contention (the new OCAPI prose touches the same "Output composition" section as the SLAS prose); they didn't conflict. Both prose additions cover orthogonal concerns (cross-reference structuring vs runnable URL completeness).

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| dsc-scenario synthesis-eval (overall) | 15/15 strict | 15/15 strict | yes |
| OCAPI fixture | 5/5 strict (up from 4/5) | 5/5 strict | yes |
| No regression on SCAPI fixtures | 5/5 strict each | 5/5 strict on both | yes |
| No regression on SLAS-handling assertions | 5/5 firings each | 5/5 each | yes |
| SKILL.md word count | ≤ +20 lines | +13 lines | yes |

## Next steps

dsc-scenario is fully green at 15/15 strict on the post-fix fixture set. Ready for the worked-example backfill task to re-capture `docs/examples/scenario-createorder-prereqs/final-answer.md` from one of the post-fix transcripts (the SLAS-shrug + OCAPI-prefix issues are both resolved in those transcripts).

The remaining `iteration-fix` work in this branch is `iteration-output-mode-anchor` for stepped-demo-script (bimodal output mode + worktree contamination, both addressed by a single `/tmp/<scenario-slug>.sh` anchor in SKILL.md).
