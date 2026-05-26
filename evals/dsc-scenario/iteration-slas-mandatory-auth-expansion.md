# iteration-slas-mandatory-auth-expansion

Status: SHIPPED. Sharpens the framing of auth deps in `dsc-scenario` from "one of two cross-reference handling modes" to "always-mandatory expansion" – auth is the universal precondition for every SCAPI / OCAPI call, not a coin-flip between expansion and surfacing. Also corrects the SLAS reference URL slug from `shopper-login` (used by the prior iteration but a 404 on developer.salesforce.com) to `auth` (the actual URL slug; "Shopper Login (SLAS)" is the page title). dsc-scenario synthesis-eval at 15/15 strict (538s) – up from the prior baseline of 14/15 in `iteration-ocapi-path-prefix-fix`.

## Hypothesis tested

The prior iteration (`iteration-slas-cross-ref-fix`) closed the SLAS-shrug regression by introducing a two-mode framing for cross-reference deps: expansion (warm cache + integrate as plan steps) or surfacing ("say the word and I'll re-run with X warmed"). That framing is correct for *non-auth* cross-reference deps – e.g. a Shopper Orders scenario that needs a customer ID producible by Shopper Customers `getCustomer`, where the user might already have one. It's wrong for *auth* deps: the user can't make any subsequent call without the token, so leaving them at "step 1: get a SLAS token" abdicates on the most important step.

The hypothesis: splitting "Cross-reference walks" in SKILL.md into an auth subsection (always expand, no mode choice) and a non-auth subsection (existing mode-choice logic) – plus tightening the synthesis-eval SLAS assertions to require both legs explicitly – will:

1. Push the model toward consistently expanding both SLAS legs (`authorizeCustomer` + `getAccessToken`) into the main plan as numbered steps, without weakening the non-auth surfacing affordance.
2. Pass the new strict assertions: `final_text_matches: authorizeCustomer`, `final_text_matches: getAccessToken`, `final_text_matches: developer\.salesforce\.com/docs/commerce/commerce-api/references/auth(?:\?|\b)` on both SCAPI fixtures (URL anchored on the `auth` slug since that's the actual DSC URL).
3. Not regress the OCAPI fixture (no OCAPI prose changed; OCAPI's `customers_auth` is mentioned only as a parallel example in the SKILL.md auth subsection).

The fix is prose + assertion-only – no script edits, no graph-walk algorithm changes. The skill's `externalInputs[]` schema gains an optional `auth: true` flag so the composition layer can route auth deps through the mandatory-expansion branch unconditionally.

## What changed

Four files edited.

### 1. `skills/dsc-scenario/SKILL.md` "Cross-reference walks" – split

Old prose: a single section describing "two ways to handle a cross-reference dep, both legitimate; pick based on what the user asked for" (expansion vs. surfacing). SLAS was lumped into that two-mode framing, which let the model legitimately choose surfacing ("say the word") for an auth dep – the wrong call, since auth is mandatory.

New prose: split into two subsections.

- **Auth deps – always expand, no mode choice.** Names SLAS (`authorizeCustomer` + `getAccessToken` on the `auth` reference, page title "Shopper Login (SLAS)") for SCAPI, `customers_auth` (`POST /customers/auth` on `ocapi-shop-customers`) for OCAPI Shop, and the Account-Manager-backed `oauth2_application` security scheme for OCAPI Data API endpoints (with an explicit note that the latter isn't a separately-scrapeable DSC reference – don't fabricate a URL for it).
- **Non-auth cross-reference deps – mode choice still applies.** Existing expansion / surfacing logic preserved verbatim.

The "What never to write" anti-template ("external input – not part of either reference") moved out of the (now non-auth) subsection into the section's tail so it applies to both categories.

### 2. `skills/dsc-scenario/SKILL.md` "Output composition" cross-reference paragraph – tightened

Old: ended with "See 'Cross-reference walks' below for when to expand vs. surface." Implied auth was one of the choosable cases.

New: "Auth steps in particular are mandatory expansions – see 'Cross-reference walks' below. The 'References involved' line and the Plan must include the auth steps even when the rest of the scenario is scoped to one reference." Removes the implication of choosability for auth.

### 3. `skills/dsc-scenario/scripts/walk-via-agent.md` – `auth: true` flag added

The sub-agent prompt's `externalInputs[]` schema example payload gains the new flag:

```
{ "name": "access_token", "likelyOrigin": "SLAS", "reference": "auth", "auth": true }
```

Plus a one-line note in the cross-reference walk paragraph that auth tokens are flagged so the composition layer always expands them inline, never surfaces them as a "say the word" affordance.

### 4. `docs/dsc-skills.md` – Edges and caveats bullet rewritten

Old: "the skill names that source reference in `externalInputs[].reference` and integrates the dependency's calls as numbered steps in the main plan – warming the cache for the named reference if it's cold. The skill expands into a multi-reference plan…"

New: explicit auth-vs-non-auth split. "**Auth deps are always expanded; non-auth deps support a mode choice.** SLAS … is mandatory for every SCAPI scenario; `customers_auth` … is the analogue for OCAPI Shop scenarios. Both are real DSC references and get integrated as numbered steps in the plan – the user can't make any subsequent call without the token, so leaving them at 'step 1: get a token' abdicates on the most important step. Non-auth deps … keep the expansion-vs-surfacing mode choice."

### 5. `evals/dsc-scenario/synthesis-eval.json` – SLAS assertions tightened

Both `synthesis-scenario-add-coupon-checkout` and `synthesis-scenario-createorder-basketid-threading` had a single positive SLAS assertion of shape `shopper-login OR auth\\?meta=(authorizeCustomer|getAccessToken)`. That regex passed if the answer mentioned `shopper-login` alone, *or* one of the two legs. Under the new framing both legs are required, so the assertion split into three:

- `final_text_matches: authorizeCustomer` – leg 1.
- `final_text_matches: getAccessToken` – leg 2.
- `final_text_matches: developer\\.salesforce\\.com/docs/commerce/commerce-api/references/auth(?:\\?|\\b)` – the public reference URL, anchored on the `auth` slug (the trailing `(?:\\?|\\b)` boundary lets `?meta=...` and bare `/references/auth` both pass while excluding `/guide/authorization-...`).

The negative assertion (`final_text_excludes` for "external input – not part of either reference") and the citation-leak guard are unchanged.

This is intent-sharpening, not loosening: the new framing requires both SLAS legs, and the assertion now reflects that. Partial expansion (mentioning the reference without naming the operations) is no longer a pass.

## OCAPI verification

Before claiming `customers_auth` is a real OCAPI DSC reference, verified live via the shared scrape library (`node skills/dsc-scrape/scripts/scrape.js https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers ~/.cache/dsc-scrape`):

- `customers_auth` is real: `POST /customers/auth` on `ocapi-shop-customers`, operationId "Get or refresh customer JWT (JSON Web Token)", security scheme `client_id`. Public URL: `https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers?meta=post-customers-auth`.
- `oauth2_application` is a *security scheme name* used by OCAPI Data API endpoints, NOT a DSC reference. It refers to Account Manager-issued tokens (no scrapeable spec at `developer.salesforce.com`). The SKILL.md auth subsection notes this explicitly so the model doesn't fabricate a DSC URL for it.

Per operator preference (no fabricated Salesforce-specific details), this verification was done before authoring assertion regexes that depend on the OCAPI auth claim.

## SLAS reference URL slug discovery (mid-iteration)

The first eval pass landed at 11/15 strict – below the 15/15 target. Inspecting the four failing runs showed the model was citing `developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer/getAccessToken` consistently (full SLAS expansion, both legs named), but the new positive assertion was hardcoded to `developer\.salesforce\.com/.+shopper-login` – the slug used by the prior iteration's prose and worked example.

Verifying via the shared scrape library:

```
$ node skills/dsc-scrape/scripts/scrape.js https://developer.salesforce.com/docs/commerce/commerce-api/references/auth ~/.cache/dsc-scrape
… refreshed: true
$ node skills/dsc-scrape/scripts/scrape.js https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login ~/.cache/dsc-scrape
ERROR: Reference "shopper-login" not found in catalog at https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login?meta=Summary.
```

The cached `_index.json` for the working URL has `reference: "auth"`, `title: "Shopper Login (SLAS)"`. The prior iteration's introduction of `shopper-login` as the reference identifier was a paraphrase of the page title, not the actual URL slug. The 4 worked-example URLs in `docs/examples/scenario-createorder-prereqs.md` (lines 33, 38, 208, 209) cited `…/references/shopper-login?meta=...` – those are 404s.

The slug fix swept five more locations beyond the original four:

- `skills/dsc-scenario/SKILL.md` – four mentions: the runnable-paths section, the cross-reference example payload, the section opener, and the SCAPI auth bullet.
- `skills/dsc-scenario/scripts/walk-via-agent.md` – two mentions: the cross-reference walk paragraph and the example payload.
- `docs/dsc-skills.md` – one mention: the Edges and caveats bullet.
- `README.md` – three mentions: the inlined worked-example block (References involved + step 1 + the explainer below).
- `docs/examples/scenario-createorder-prereqs.md` – four mentions (the URLs that were actually broken).
- `evals/dsc-scenario/synthesis-eval.json` – two assertion patterns + three `because` strings.

In all cases the prose change preserves "Shopper Login (SLAS)" as the human-facing title where it appears as a label or page name, and changes only the URL slug / `externalInputs[].reference` identifier from `shopper-login` to `auth`.

## Eval results

`python3 tools/synthesis-eval.py --eval evals/dsc-scenario/synthesis-eval.json --runs 5 --workers 4 --timeout 1800 --out evals/dsc-scenario/runs/iteration-slas-mandatory-auth-expansion/results.json`

First pass (with the broken `shopper-login` assertion): 11/15 strict in 574s. The OCAPI fixture passed 5/5; both SCAPI fixtures under-passed because the URL assertion targeted a slug DSC doesn't publish.

Second pass (after slug fix): see "Eval results (post-slug-fix)" below.

## Eval results (post-slug-fix)

`python3 tools/synthesis-eval.py --eval evals/dsc-scenario/synthesis-eval.json --runs 5 --workers 4 --timeout 1800 --out evals/dsc-scenario/runs/iteration-slas-mandatory-auth-expansion/results.json`

Wall-clock 538.2s. Exit code 0. 0 retries, 0 aborts.

| Fixture | Pre-iteration baseline (iteration-ocapi-path-prefix-fix) | This iteration | Delta |
|---|---|---|---|
| `synthesis-scenario-add-coupon-checkout` | 5/5 (with 5 assertions) | 5/5 (with 9 assertions, including 3 new strict SLAS assertions on the `auth` slug) | unchanged pass count, 4 new assertion firings × 5 runs = 20 new firings, all green |
| `synthesis-scenario-createorder-basketid-threading` | 5/5 (with 6 assertions) | 5/5 (with 8 assertions, including 3 new strict SLAS assertions) | unchanged pass count, 2 new assertion firings × 5 runs = 10 new firings, all green |
| `synthesis-scenario-ocapi-submit-basket` | 5/5 | 5/5 | unchanged (no OCAPI prose changed) |

Total: **15/15 strict.** Routing correctness 15/15. Citation-leak guard 0 leaks. The strict both-legs SLAS expansion holds across 10 SCAPI runs without any regressions on existing assertions.

(The intermediate 11/15 strict result from the first eval pass – before the slug fix – is documented in the "SLAS reference URL slug discovery" section above. That pass surfaced the slug bug; this one validates the fix.)

## Pass criteria status

| Criterion | Target | Observed | Met |
|---|---|---|---|
| dsc-scenario synthesis-eval (overall) | 15/15 strict | 15/15 strict | yes |
| New strict SLAS assertions on each SCAPI fixture | 5/5 each | 5/5 on add-coupon, 5/5 on createorder | yes |
| OCAPI fixture | 5/5 (no regression) | 5/5 | yes |
| Routing correctness | 15/15 | 15/15 | yes |
| Citation-leak guard | 0 leaks | 0 | yes |

## Pass criteria

| Criterion | Target |
|---|---|
| dsc-scenario synthesis-eval (overall) | 15/15 strict |
| New strict SLAS assertions on each SCAPI fixture | 5/5 each (2 fixtures × 3 new assertions = 30 assertion firings) |
| OCAPI fixture | 5/5 (no regression from current 5/5 in iteration-ocapi-path-prefix-fix) |
| Routing correctness | 15/15 |
| Citation-leak guard | 0 leaks |

## Worked example coupling

`docs/examples/scenario-createorder-prereqs.md` is the post-fix worked example for the createorder-prereqs fixture. It already has 1a + 1b for the SLAS legs (`authorizeCustomer` + `getAccessToken`) – captured from run 4 of `iteration-ocapi-path-prefix-fix`. If the eval passes 5/5 with the tightened assertions, that worked example should hold; if any run produces a sharper transcript (e.g. names `customers_auth` for the OCAPI fixture), consider re-capture in a follow-up.

## Why fold into one iteration rather than two

The TODO note (`iteration-todo-slas-cross-reference-prose.md`) flagged the SLAS-shrug regression and was marked RESOLVED by `iteration-slas-cross-ref-fix`. The framing-of-SLAS-as-cross-reference-dep miss surfaced after that resolution, when the new "Cross-reference walks" section's two-mode framing was applied to auth deps. Filing this as a separate `iteration-todo-slas-auth-layer-mandatory.md` and then resolving it would mirror the prior pattern – but the work is small and cleanly scoped (prose + assertions, no algorithm changes), so folding into one iteration here keeps the diff focused. The TODO file gets updated to reflect the additional fix.
