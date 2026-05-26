# iteration-slas-cross-ref-fix

Status: SHIPPED. Resolves `iteration-todo-slas-cross-reference-prose.md`. dsc-scenario synthesis-eval moves from 13/15 → 14/15 strict (only remaining failure is the OCAPI path-prefix regression, which is a separate finding addressed in `iteration-ocapi-path-prefix-fix`). All 10 runs across the two SCAPI fixtures pass the new SLAS-handling assertions; SLAS now appears as the named `shopper-login` reference with `authorizeCustomer` + `getAccessToken` integrated as plan steps, not as "external input – not part of either reference."

## Hypothesis tested

Tightening four locations of cross-reference prose (SKILL.md, walk-via-agent.md, README, docs/dsc-skills.md) so they all consistently frame SLAS as a DSC reference (`shopper-login`) rather than as an "external input" outside the skill's universe will:

1. Move dsc-scenario's bimodal SLAS handling toward consistent expansion.
2. Pass two new synthesis assertions:
   - `final_text_matches: shopper-login|developer\.salesforce\.com/.+auth\?meta=(authorizeCustomer|getAccessToken)` -- positive: must name the SLAS reference or its specific operations.
   - `final_text_excludes: (?i)not part of (either|the|any) reference|external input.{0,40}not.{0,20}part` -- negative: must not use the shrug phrasings.
3. Not regress the existing SCAPI / OCAPI / cascade-order assertions.

The fix is prose-only -- no script edits, no graph-walk algorithm changes. The skill already had `externalInputs[].reference` populated correctly internally; the gap was the composition layer paraphrasing it as "external" in the user-facing answer.

## What changed

Five files edited. Each location was a separate countersignal that, individually, framed the broken behavior as deliberate skill design.

### 1. `skills/dsc-scenario/SKILL.md` "Cross-reference walks" -- rewritten

Old prose: 1 paragraph framing non-expansion as the skill's deliberate boundary. Implied SLAS is "external" and the outer conversation has to handle it.

New prose: Names the `externalInputs[].reference` field as authoritative; describes two legitimate handling modes (expansion / surfacing); explicitly forbids "external input – not part of either reference" / "out of scope" phrasings; calls out SLAS and OCAPI auth as the same class.

### 2. `skills/dsc-scenario/SKILL.md` "What this skill doesn't do" -- one bullet rewritten

Old: "Doesn't auto-scrape cross-reference dependencies. ... it does not transparently expand into a multi-reference plan."

New: "Doesn't auto-scrape cross-reference dependencies on a cold cache. ... The skill *does* expand cross-reference deps into multi-reference plans once the cache is warm." Removes the contradiction with the new "Cross-reference walks" prose; clarifies that the boundary is cold-cache scraping, not multi-reference planning.

### 3. `skills/dsc-scenario/SKILL.md` "Output composition" -- one paragraph added

New paragraph after the structural-evidence guidance: "Cross-reference steps go in the same Plan list, not in a separate section." Plus an explicit example template ("the SLAS step (or steps – usually `authorizeCustomer` + `getAccessToken`)") and an explicit anti-template ("Don't write 'external input – not part of either reference'; that prose is wrong").

### 4. `skills/dsc-scenario/scripts/walk-via-agent.md` "Cross-reference walk" -- one sentence appended

The sub-agent prompt already returns `externalInputs[].reference`. Added one clarifying sentence so the field is cited verbatim by the outer conversation: "Always include the `reference` field naming the source DSC reference (e.g. `\"shopper-login\"` for SLAS); the outer conversation cites that name verbatim in the user-facing answer (never 'external' or 'out of scope' – the input *is* part of a DSC reference)."

### 5. `README.md` line 95, line 142, and the inlined "References involved" line

- Line 95 (inlined worked example step 1): "Obtain a shopper access token (SLAS) – external input, see [shopper-login reference]" → "Obtain a shopper access token from `shopper-login` (SLAS) – `authorizeCustomer` + `getAccessToken`. See [shopper-login reference]."
- Line 142 (narrative explainer below the inlined example): "SLAS auth shows up as an external input, not as a planned step – cross-reference scopes belong to the outer conversation, not the scenario." → "SLAS shows up as one of the references involved (`shopper-login`) – the planner integrates `authorizeCustomer` + `getAccessToken` as the first two steps when the cache is warm, so the access token's origin is visible in the same plan list rather than handed off as a precondition."
- "References involved" line in the inlined example block: added `shopper-login` (SLAS) to the list.

The inlined README example will be re-captured from a post-fix transcript as part of the worked-example backfill task in this branch (the displayed plan still has only steps 1-7 with shopper-baskets / shopper-orders calls; a re-capture from a fresh `createOrder`-prereqs run would have fully integrated SLAS steps).

### 6. `docs/dsc-skills.md` line 218 -- bullet rewritten

Old: "the skill flags it as an `externalInputs` entry and asks the outer conversation to proceed. It doesn't transparently expand into a multi-reference plan."

New: "the skill names that source reference in `externalInputs[].reference` and integrates the dependency's calls as numbered steps in the main plan – warming the cache for the named reference if it's cold. The skill expands into a multi-reference plan; what it doesn't do is silently invent calls that aren't backed by a scraped spec."

The architectural framing now describes the *real* boundary: the skill won't fabricate calls that aren't in a scraped spec. Cross-reference expansion is in scope.

## Synthesis-eval fixture additions

Two new assertions on `synthesis-scenario-add-coupon-checkout` and `synthesis-scenario-createorder-basketid-threading`:

```
{
  "kind": "final_text_matches",
  "pattern": "shopper-login|developer\\.salesforce\\.com/.+auth\\?meta=(authorizeCustomer|getAccessToken)",
  "because": "SLAS dependency must be named as the shopper-login reference (or its specific operations) -- not as 'external input' or 'out of scope'."
},
{
  "kind": "final_text_excludes",
  "pattern": "(?i)not part of (either|the|any) reference|external input.{0,40}not.{0,20}part",
  "because": "must NOT use the shrug phrasings flagged in iteration-todo-slas-cross-reference-prose.md"
}
```

The negative assertion's regex was constructed to catch the specific phrasings that surfaced in the worked example and any close paraphrases ("not part of either reference", "external input – not part of"). It does not block the legitimate "external input" usage in the `walk-via-agent.md` schema (the schema text isn't part of the user-facing chat answer).

The OCAPI fixture (`synthesis-scenario-ocapi-submit-basket`) doesn't get the SLAS assertions because OCAPI's auth analogue (`customers_auth` / `oauth2_application`) isn't currently on a separate DSC reference -- it's covered in the OCAPI shop reference itself. Adding cross-reference assertions there would be authoring against unverified ground truth.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/dsc-scenario/synthesis-eval.json --runs 5 --workers 4 --timeout 360 --out evals/dsc-scenario/runs/iteration-slas-cross-ref-fix/results.json`

Wall-clock 709.5s. Exit code 1 (one fixture under-passes; same OCAPI path-prefix regression as the baseline iteration). 0 retries, 0 aborts.

| Fixture | Pre-fix | Post-fix | Delta |
|---|---|---|---|
| `synthesis-scenario-add-coupon-checkout` | 5/5 (with 5 assertions) | 5/5 (with 7 assertions, including 2 new SLAS assertions) | unchanged pass count, 10 new SLAS assertions all passed |
| `synthesis-scenario-createorder-basketid-threading` | 5/5 (with 4 assertions) | 5/5 (with 6 assertions, including 2 new SLAS assertions) | unchanged pass count, 10 new SLAS assertions all passed |
| `synthesis-scenario-ocapi-submit-basket` | 3/5 | 4/5 | +1 run; remaining failure is the OCAPI path-prefix regression (separate finding, addressed in iteration-ocapi-path-prefix-fix) |

Total: 14/15 strict (up from 13/15). Routing correctness: 15/15. Citation-leak guard: 0 leaks. **20 of 20 new SLAS-handling assertion firings passed** (10 per fixture × 2 fixtures); the SLAS shrug regression is closed.

## Worked example re-capture

`docs/examples/scenario-createorder-prereqs/final-answer.md` should be re-captured from one of the 5 passing `synthesis-scenario-createorder-basketid-threading` runs in this iteration's transcripts (any of runs 1-5 has the corrected SLAS handling). That re-capture happens in the worked-example backfill task scheduled later in this branch -- not in this iteration's commit, to keep the diff focused on the prose fix.

## Surprises

- **Pre-fix the bimodal SLAS handling was already passing 5/5 on add-coupon-checkout.** That fixture's baseline run picked the expansion mode in all 5 runs (steps 1-2 = SLAS authorize + token), so the new positive SLAS assertion firing 5/5 doesn't *prove* the fix worked there -- it would have passed pre-fix too. The fix's value on add-coupon is regression prevention going forward.
- **createorder-basketid-threading is where the prose fix shows clearest signal.** That fixture's baseline used to produce the "external input" shrug; this iteration's runs all integrate SLAS as numbered steps. The negative `final_text_excludes` assertion firing 5/5 (rather than catching shrugs) is the proof that the prose tightening landed.
- **OCAPI fixture moved from 3/5 to 4/5 even though no OCAPI prose changed.** Likely model-variance noise rather than the SLAS prose helping the OCAPI plan; still need the dedicated OCAPI fix in `iteration-ocapi-path-prefix-fix` to lock OCAPI at 5/5.

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| dsc-scenario synthesis-eval (overall) | 15/15 strict | 14/15 strict | partial -- only OCAPI fixture under-passes; tracked separately |
| New SLAS-handling assertions | 5/5 strict on each fixture | 5/5 on add-coupon, 5/5 on createorder | yes |
| No regression on baseline assertions | unchanged pass count | 5/5 on both SCAPI fixtures | yes |
| Repo-doc countersignals updated | 4 locations | 4 locations (SKILL.md ×3 sections, walk-via-agent.md, README ×3 lines, docs/dsc-skills.md) | yes |
| Worked example re-captured | yes | deferred to backfill task | partial (scheduled in same branch) |

## Next steps

1. `iteration-ocapi-path-prefix-fix` -- the remaining 1/5 OCAPI failure is the path-prefix regression. Independent fix, narrower scope.
2. Re-capture `docs/examples/scenario-createorder-prereqs/final-answer.md` from a post-fix transcript in the worked-example backfill task.
