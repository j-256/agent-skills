# iteration-todo-slas-cross-reference-prose

Status: RESOLVED by `iteration-slas-cross-ref-fix` (the SLAS-shrug regression itself) plus `iteration-slas-mandatory-auth-expansion` (the framing-of-SLAS-as-one-of-two-modes follow-up; auth is universally mandatory, not coin-flip-expandable). The first iteration closed 20/20 new SLAS-handling assertion firings; the second sharpened the framing so auth deps are always-expand by design and tightened the assertions to require both SLAS legs (`authorizeCustomer` AND `getAccessToken`) explicitly rather than a shopper-login-OR-one-leg regex. All four repo-doc countersignals fixed in iteration 1; the SKILL.md "Cross-reference walks" section was further split into auth (mandatory expansion) and non-auth (mode choice) subsections in iteration 2. See those iteration notes for the diffs and eval numbers; this TODO is preserved for historical context.

Original status: TODO (high priority, not yet executed). Filed during the dsc-scenario synthesis-baseline iteration as a real skill regression worth a dedicated iteration once in-flight synthesis-eval work lands.

## The miss

`docs/examples/scenario-createorder-prereqs.md` step 1 reads:

> **1. Obtain a shopper access token (SLAS)**
> This is an external input – not part of either reference. You need a shopper JWT from SLAS before any basket call.

"Not part of either reference" is wrong. SLAS *is* a DSC reference – `shopper-login`, published at https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login. The skill already knows this internally:

- `scripts/walk-via-agent.md` line 26: "if the reference is clearly dependent on another (e.g. any SCAPI endpoint depends on SLAS for the shopper token), note that in the response under `externalInputs: [...]`" with the example payload `{name: "access_token", likelyOrigin: "SLAS", reference: "shopper-login"}`.
- `SKILL.md` "Cross-reference walks": "If the sub-agent returns `externalInputs: [...]` (e.g. `access_token` originating from `shopper-login` / SLAS), the outer conversation should warm the cache for that reference (via `scrapeRefresh`) and re-run the scenario."

The skill internally classifies SLAS as a known DSC reference. The prose in the worked example contradicts that classification – calling it "not part of either reference" frames SLAS as something *outside the skill's universe* rather than as a reference the skill *chose not to expand on this run*.

## Why this matters

This skill exists to be the authoritative answer for "what calls do I need against a Salesforce API to reproduce this flow." Saying "not part of either reference" reads to a customer-support engineer like the skill is admitting it can't help – when the truth is the skill *can* help, it just declined to chain in the SLAS calls automatically (per the deliberate "doesn't auto-scrape cross-reference dependencies" boundary).

The right answer is something closer to:

> **1. Obtain a shopper access token (SLAS)**
> This step belongs to the `shopper-login` reference (https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login), not `shopper-orders` or `shopper-baskets`. By default this skill flags cross-reference deps and lets you decide whether to expand them – say the word and I'll re-run with `shopper-login` warmed and chain in the guest or registered login flow. For now, treat the token as a precondition; produce one via the SLAS guest-login (`POST /shopper/auth/v1/organizations/{orgId}/oauth2/login?client_id=...`) or registered-login flow and use it as the bearer for steps 2–7.

That answer (a) acknowledges SLAS as a DSC reference, (b) makes the skill's deliberate non-expansion legible, (c) offers an actionable next step, and (d) gives a concrete cURL hint so a teammate isn't stranded.

## What needs to change

Two layers, both small:

1. **Composition layer (`SKILL.md` "Output composition" + "Cross-reference walks").** Tighten the prose template so the model writes "this step belongs to the `<reference>` reference (URL)" instead of "external input – not part of either reference." Add an example sentence in the SKILL.md so the model has a template to imitate.

2. **Sub-agent prompt (`scripts/walk-via-agent.md`).** Already names `reference: "shopper-login"` in the externalInputs schema. The current eval shows the outer conversation isn't always reading that field through to its prose layer. Add a one-line note in `walk-via-agent.md` clarifying that `externalInputs[].reference` should be cited verbatim in the user-facing answer, not paraphrased as "external."

Optional third layer:

3. **Synthesis-eval fixture.** Add a fixture that asserts `final_text_matches: developer\.salesforce\.com/.+shopper-login` on a createOrder-prereqs query, so the regression is guarded once fixed. This fixture should NOT be authored before the prose fix lands – it would just produce a 0/5 baseline.

## Repo-doc countersignals (the bigger problem)

The same prose-level miss as the worked example also lives in two places that *frame the broken behavior as deliberate skill design* – so a future maintainer fixing the skill could leave the docs cheerleading the old behavior, undoing the fix from the reader's perspective. All three locations need to update together:

1. **`README.md` line 95** (inlined worked example): "1. Obtain a shopper access token (SLAS) – external input, see [shopper-login reference](https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login)." This is a condensed restatement of the worked example's miss; should be updated when the worked example is re-captured.

2. **`README.md` line 142** (narrative explainer below the example): "SLAS auth shows up as an external input, not as a planned step – cross-reference scopes belong to the outer conversation, not the scenario." This is the load-bearing countersignal. It actively frames the SLAS-shrug as deliberate skill design, telling the reader the skill's behavior is correct *as it stands*. Anyone reading this won't notice the regression. Must be rewritten to say something closer to: "SLAS auth shows up as one of the references involved (`shopper-login`), and the plan can either expand it into integrated SLAS steps or flag it as a cross-reference dep for the outer conversation to expand. The skill makes that choice visible to the user."

3. **`docs/dsc-skills.md` line 218** (architecture doc edge): "If `dsc-scenario`'s graph walk surfaces an input that originates in another reference (most commonly SLAS `access_token` from `shopper-login`), the skill flags it as an `externalInputs` entry and asks the outer conversation to proceed. It doesn't transparently expand into a multi-reference plan." Frames the non-expansion as the skill's *boundary*, when the new add-coupon worked example demonstrates the skill *can* and sometimes *does* expand SLAS into a multi-reference plan (steps 1-2 are full SLAS authorize+token operations). Should describe the actual behavior: the skill is currently bimodal (sometimes expands, sometimes shrugs), and after the prose fix it should default to expansion with an explicit "I'm going to leave this as an external dep, say so if you want me to chain SLAS too" affordance for the user.

Counter-evidence already in-tree: `docs/examples/scenario-add-coupon-checkout.md` (committed in `iteration-synthesis-baseline`) names `auth` (SLAS) as a reference involved and includes `authorizeCustomer` + `getAccessToken` as plan steps 1 + 2. That worked example contradicts the docs framing – so the docs are already out of sync with at least one observable skill output, even before the prose fix lands. The two worked examples (`scenario-createorder-prereqs` shrugging on SLAS, `scenario-add-coupon-checkout` expanding SLAS as a planned step) bracket the bimodal behavior visibly in-tree.

The dsc-scenario synthesis fixture doesn't currently assert anything about SLAS treatment. The follow-up iteration that lands the prose fix should add a SLAS-handling assertion to the existing `synthesis-scenario-add-coupon-checkout` fixture (e.g. `final_text_matches: shopper-login|developer\.salesforce\.com/.+auth\?meta=(authorizeCustomer|getAccessToken)`) so the bimodal behavior is forced into the expansion mode by the test.

## Coupling with the worked example

If the prose fix lands cleanly, the worked example at `docs/examples/scenario-createorder-prereqs.md` should be re-captured from the new transcript. Until then, the worked example reflects pre-fix behavior – that's actually fine as historical record (it's the answer the skill produced on commit a53b46f). The post-fix iteration note should commit the new worked example as well.

## Pass criteria for the eventual iteration

| Criterion | Target |
|---|---|
| Synthesis-eval fixture (new) | 5/5 strict on `final_text_matches: developer\.salesforce\.com/.+shopper-login` for any createOrder-class query |
| Existing synthesis fixtures | unchanged pass count |
| Worked example re-captured | yes (new `final-answer.md` with the corrected prose) |
| SKILL.md word count | ≤ +30 lines from current (concise template, not a rewrite) |

## Why this is filed but not executed now

The branch this lands on is the synthesis-eval-readiness branch – three new synthesis iterations across dsc-scenario, stepped-demo-script, fork-and-pr, plus dsc-scrape worked-example backfill, plus README cleanup. Adding a SKILL.md prose iteration on top mid-stream would mix concerns: the synthesis baseline measures *current* skill behavior, and tightening that behavior in the same branch as authoring its measurement would make the baseline non-reproducible for anyone reading the iteration history.

The right sequence is: land the synthesis-eval baselines (this branch) → next iteration tightens the cross-reference prose → re-run the dsc-scenario synthesis-eval to confirm the baseline holds + add the new SLAS regression fixture → re-capture the worked example.
