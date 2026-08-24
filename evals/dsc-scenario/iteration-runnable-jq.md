# iteration-runnable-jq

## Hypothesis

The runnable's **JSON-response-field extraction idiom** is underspecified in SKILL.md. The deterministic renderer (`scripts/curl-block.js:63`) already emits `jq -r .field`, and its test (`test/test-curl-block.js`) asserts that exact form. But when the model *hand-composes* a multi-reference runnable (the cross-reference plans -- auth + baskets + orders -- which the renderer doesn't produce end-to-end), SKILL.md never told it which idiom to use, so it improvised a 200-character `node -e "process.stdin.on('data',...JSON.parse(d).access_token)"` stdin-reader for every field. No support engineer pastes that into a terminal; `jq -r .access_token` is what a person types.

This is the same class of gap as `iteration-auth-code-capture`'s two findings: an underspecified runnable detail the model fills inconsistently. Here it filled it *consistently wrong* -- every baseline run used `node -e`, none used `jq`.

## Baseline (pre-rule, from iteration-auth-code-capture* transcripts, Sonnet 4.6)

Field-extraction idiom in the runnable, across the fixtures whose runnables thread a field:

| Fixture | node -e JSON.parse | jq -r | preflight |
|---|---|---|---|
| createorder-basketid-threading | 5/5 | 0 | 0 |
| add-coupon-checkout | 5/5 | 0 | 0 |
| ocapi-submit-basket | 5/5 | 0 | 0 |

100% `node -e`, 0% `jq`, 0% preflight -- a clean, total drift from the renderer's own idiom. (am-admin-orders extracts no field -- the getOrder flow needs only an AM token -- so it is out of scope for this rule and got no assertion.)

## jq availability finding

The reason to add a preflight rather than assume `jq`: **jq ships with macOS only since Sequoia (15)** (2024; the bundled build identifies as `jq-1.6-159-apple-...`). Verified two ways -- web search, and locally: `/usr/bin/jq` on this Tahoe (macOS 26) box is root:wheel with no `pkgutil` install receipt, i.e. OS-provided, not Homebrew or Xcode CLT. So on macOS 15+ it's present, but Linux users and anyone on macOS 14 or earlier may lack it. A one-line `command -v jq || { echo ...; exit 1; }` preflight makes a missing dependency fail loud at the top instead of mid-script.

**Capture-context vs display-context fallback.** `stepped-demo-script` uses `command -v jq >/dev/null 2>&1 && _jq() { jq ...; } || _jq() { cat; }`. That graceful `|| cat` degrade is correct *there* because that skill pretty-prints JSON for a human to read -- if jq is absent, showing raw JSON is fine. It is WRONG for dsc-scenario, because here the value is **captured into a shell variable** (`ACCESS_TOKEN=$(... | jq -r .access_token)`): falling back to `cat` would assign the entire JSON blob to `ACCESS_TOKEN` / `BASKET_ID` and silently break every downstream call. So the rule mandates a hard-fail preflight, not the passthrough shim.

## What changed

**SKILL.md** -- added "Extracting JSON response fields in the runnable -- use `jq -r`" after the PKCE-in-the-runnable rule: extract response-body fields with `jq -r` (matching the renderer), never hand-rolled `node -e`/`python3`; begin the runnable with a `command -v jq` hard-fail preflight; explicitly contrast with the redirect rule (the auth *code* comes from the 303 Location header and is NOT JSON-parsed) and with stepped-demo-script's display-context `|| cat` fallback (wrong in a capture context).

**synthesis-eval.json** -- two assertions on the 5 field-threading fixtures (createorder, coupon, registered-silent, registered-b2c-primed, ocapi-submit-basket): `final_text_excludes` for the `node -e "...JSON.parse..."` / `python3 -c "...json.load..."` idiom (scoped so the mandated `node <path>/pkce-snippet.js` invocation does not match), and `final_text_matches` requiring `jq -r`.

The renderer and its test already enforce `jq -r`, so neither changed -- the bug was purely the hand-composition path, fixed in SKILL.md prose + guarded in the fixtures.

## Results (post-rule)

**Run 1** (`iteration-runnable-jq`, Sonnet 4.6, 5 fixtures × 5, isolated): **22/25 runs pass; 2/5 fixtures strict.** The jq rule landed cleanly -- **0/25 used `node -e`/`python3` JSON parsing; all 25 used `jq -r`** (a complete flip from the 100%-`node -e` baseline). Every run fired `dsc-scenario`, 0 contaminated.

All 3 failures were on **pre-existing login-contract assertions from `iteration-auth-code-capture`**, none on the new jq assertions -- and on inspection all 3 were **assertion false-positives, not skill regressions**:

- `registered-silent` run 3 -- failed `login_id|login_password` exclude, but the matched text was the model's own *warning prose*: "No `grant_type` here (that belongs on the `/token` call); no `login_id`/`login_password` form fields." The skill named the anti-pattern to avoid it; the bare-token exclude flagged it for saying the words.
- `registered-b2c-primed` run 4 and `add-coupon-checkout` run 5 -- failed `oauth2/login[\s\S]{0,400}grant_type`, but in both the login leg was clean and the matched `grant_type` was in the *next step* (getAccessToken) or a "Why" line referencing it. The 400-char window leaked across the step boundary.

Both assertions were retuned (see below); after retuning, all 25 transcripts pass on replay. **Confirmation run** (`iteration-runnable-jq-confirm`, the 3 registered-B2C fixtures, 5 runs, Sonnet 4.6): **15/15 strict, 0 failed asserts, 0 contaminated** -- authoritative under the Python scorer. Scoped to the fixtures carrying the retuned patterns; createorder and ocapi already strict-passed run 1 and have no retuned assertions. Net: all 5 affected fixtures green with the final assertion set (jq idiom + retuned login guards).

**Login-assertion retune.** Two patterns from the prior iteration were latently too loose and this run's more-compact layouts exposed them:

- `login_id|login_password` -> `--data-urlencode ['"]login_id|[?&]login_id=|["']login_id["']\s*:|\blogin_password=` -- matches the fabrication only as an actual form field / query param / JSON key, never the bare noun in prose.
- `oauth2/login[\s\S]{0,400}grant_type` -> `oauth2/login(?:(?!/token|getAccessToken|Step |##|Exchange)[\s\S]){0,200}grant_type` -- 200-char window with a negative lookahead that stops at any step/token boundary, so `grant_type` in the adjacent getAccessToken step no longer false-matches.

Both retunes were validated to still catch genuine fabrications (confirm-coupon-1's real `login_id` form fields; baseline coupon-1's real grant-on-login) while clearing the false positives.

## Surprises

- **The jq rule worked on the first try; the "failures" were the old guardrails.** A run that came back red with 3 failures looked at first like the jq rule was too weak -- but the jq assertions were 25/25, and every red was a previous iteration's login assertion misfiring on *correct* output. Worth the reflex: when a new rule's run goes red, confirm *which* assertion failed before touching the new rule.
- **A 15/15 iteration can still ship loose assertions.** `iteration-auth-code-capture`'s login patterns passed 15/15 there, but only because those runs happened to space `grant_type` far from the login heading and never wrote the "no login_id" warning. Strict-pass on one sample doesn't prove an assertion is tight -- it proves it didn't fire on that sample. The compact layouts here exposed both. Recorded so the prior iteration's "15/15 strict" is read with that caveat.
- **The skill spontaneously documents the anti-patterns now.** Post-`iteration-auth-code-capture`, runs began emitting lines like "the code is in the Location header, not a JSON body" and "no login_id/login_password form fields" -- the SKILL.md rules propagated into the model's *explanatory prose*, not just its bash. Good for users, but it means keyword-based excludes increasingly need the mechanism-vs-mention discipline, because the model now mentions the very patterns the excludes hunt for.
- **The reshoot caught two more spec-fidelity slips the assertions don't guard.** Reshooting the example docs (again the end-to-end human read) surfaced: (1) createorder jq-run 1 drifted to the `shopper-baskets-v2` reference -- valid and cached, but inconsistent with the coupon run and both committed docs, so a plain-`shopper-baskets` run was chosen instead and the version-selection gap filed as its own follow-up; and (2) coupon jq-run 1's payment body used `creditCardNumber`/`securityCode`, which are not fields on the spec's `OrderPaymentCardRequest` (valid: `creditCardToken`, `maskedNumber`, `cardType`, `expirationMonth/Year`, `holder`) -- corrected to the tokenized form. Neither is caught by any current assertion; both were found only by reading the captured doc against the cache. Consistent with the prior iteration's lesson: the worked example is the highest-bandwidth audit surface.

## Follow-up surfaced

The `shopper-baskets` vs `shopper-baskets-v2` drift exposed that the skill has no version-selection logic: both references are cached (v2 is a documented superset -- "all V1 functionality plus temporary baskets"), and which one a run lands on is nondeterministic. The catalog indexes products, not versioned references, so there's no built-in "newest wins" resolution. A `prefer-latest-reference-version` iteration (version-discovery + a SKILL.md rule + a fixture asserting the newest is chosen) is the right home for this; deliberately deferred to keep this iteration scoped to the jq idiom.
