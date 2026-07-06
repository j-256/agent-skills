# iteration-certainty-layer

Self-invalidating spec corrections: curated facts that override what a spec's `security[]`/schema declares, designed so a correction is not catastrophic when the spec later drifts. A correction records a `specAnchor` snapshot of the exact field it overrides; every run re-checks that field against the freshly-scraped spec and, on drift, flags the correction "re-verify" instead of asserting a stale override. The family's decline-rather-than-fabricate thesis applied to the skill's own curated overrides.

## What the diff can't carry

### The hazard the whole iteration designs against

A correction is trusted MORE than the spec, so a stale correction fails confidently -- strictly worse than declining. A curated override authored against one version of a spec keeps asserting itself forever, even after the platform or the spec regenerates out from under it. The defense is that a correction carries the basis of its own expiry: the `specAnchor` records what the overridden field said at authoring time, and drift against that snapshot demotes the correction to a re-verify banner rather than a silent, confident falsehood.

### Volatility is derived from shape, not enumerated

`deriveVolatility(entry)` reads the entry's shape, never a stored class field: `specAnchor` present => spec-divergence (watch the field; the drift-prone class); an explicit `infraInvariant` flag => infra-invariant (no spec field to watch, e.g. an auth host); otherwise => platform-behavior (a dated runtime fact, re-verify on cadence via `verifiedOn`). Fewer knobs, same power -- the taxonomy is a consequence of the data, so an author cannot mis-set it.

### The anchor is field-agnostic (read + holds), proven on two different field kinds

`checkSpecAnchor(anchor, ctx)` hard-codes no notion of security-vs-schema: the anchor supplies its own `read(ctx)` (where the watched field lives) and `holds(value)` (is the premise still true). The two shipping citizens exercise genuinely different divergence shapes, which is the generality proof rather than a promise:

- **auth-admin** watches a WRONG VALUE in an inline `security[]` field: `holds` while a `BearerToken` scheme's scopes are all `^SLAS_.*_ADMIN$`; drifts if the spec names the real gate (`CCDX_SBX_USER`).
- **masked_number** watches a WRONG PROPERTY STILL PRESENT in a `$ref`-resolved schema: `holds` while the create-body card leaf type `order_payment_card_request` still declares raw `number` (which runtime rejects); drifts if the spec converges to `masked_number`.

The schema-field read composes the existing `typeHasProperty`/`loadType`, which is why those helpers moved down to `_shared/spec-traversal.js` -- a `_shared` correction cannot import up into a skill's `scripts/`.

### Fail toward drifted, never toward silent trust

If an anchored field cannot be read -- `read` throws (missing type file, malformed cache) or returns null/undefined -- `checkSpecAnchor` returns `drifted`, not `holds`. The `holds` predicate is also wrapped: a throwing `holds` funds toward drifted too (a malformed value shape must re-verify, not crash or silently trust). Determinism throughout: no clock and no network in any decision or render path; `verifiedOn[].date` is display-only, never compared to now().

### Regression transparency is byte-identical, not merely value-equal

A target with no matching correction yields `correctionNotes: []`, and because `resolveAuthProvider` already normalizes its return so `prerequisites` is present as an array, the fold `{...auth, prerequisites:[...(auth.prerequisites||[]), ...[]]}` adds no key and reorders nothing -- the JSON output is unchanged, so every existing SCAPI/OCAPI plan is untouched. This was the highest-risk property and it held under the whole-branch review.

## Surprises / rejected alternatives

### The first citizen did not fit the naive single-value snapshot

The design brief prescribed `specAnchor.saw: ["SLAS_SERVICE_ADMIN","SLAS_ORGANIZATION_ADMIN"]` as a literal. A pre-implementation freshness check (re-scrape `--force`, then confirm against the raw upstream OAS fetched through the library's own `fetch-url.js` so the hotlink-guard `Referer` matched) found auth-admin has NO document-level `security` and per-op arrays that are non-uniform: three read ops (`retrieveClients`, `retrieveClient`, `retrieveIdentityProviders`) declare only `[SLAS_SERVICE_ADMIN]`; the rest declare both roles. A single literal was therefore impossible. Resolved with a PREDICATE snapshot (`scheme:BearerToken, every scope ~ /^SLAS_.*_ADMIN$/`) that both observed forms satisfy and the real gate fails. The committed `docs/commerce-auth-matrix.md` had over-generalized the same line from one op; corrected here.

### The inversion-exclude regex false-tripped on CORRECT phrasings, twice

The synthesis fixture's hardest assertion excludes an answer that wrongly presents the SLAS_*_ADMIN roles as the operative gate -- but the CORRECT answer names those exact roles to say they are NOT the gate. The first pass scored 3/5: the exclude matched two correct model phrasings (`does _not_ need SLAS_SERVICE_ADMIN`, and a role mention across a markdown-emphasized negation). Fix was to redesign the pattern (not relax it) into a per-line tempered run that survives emphasized negation, verified against a 24/12 phrasing battery -> 5/5. A later review pass then found the redesigned verb group `must be (?:configured|granted|assigned) with` had made ` with` mandatory, so natural role-assignment inversions (`must be granted SLAS_SERVICE_ADMIN`) slipped the gate; tightened to `(?: with)?` and re-verified both properties under the harness's real Python `re` engine. The recurring lesson: an exclude that must fire on a wrong claim while a correct answer legitimately names the same nouns is anchor-on-the-claim-of-requirement, not anchor-on-the-noun -- and every change to it must be checked against BOTH a wrong-form battery and a correct-form battery, or a "fix" silently masks or over-fires.

### A plan-brief error, not implementer drift

The Task 7 integration test's skip guard caught `ReferenceNotScrapedError`, but an uncached `composePlan` throws `ReferenceNotCachedError` (from `resolve-cache.js`, via `resolveReferenceDir`) -- a different class. The suite was green only because the authoring machine had auth-admin cached; on a fresh clone it would redden. The wrong class originated in the plan brief's verbatim code and was copied faithfully; caught in review, reproduced empirically, fixed to catch both classes. Worth recording because the defect looked like implementer output but was authored upstream in the plan.

## Eval

Synthesis, Sonnet, `--runs 5` strict (`runs/iteration-certainty-layer/`):

- `synthesis-scenario-am-admin-corrected-gate` (new) -- **5/5**. Fires `dsc-scenario`, routes auth-admin to the AM `client_credentials` branch, and renders the correction: the enforced gate (Sandbox API User / `CCDX_SBX_USER`), the `authorization-for-admin-apis` guide cite, no cache-path leak, no fabricated AM DSC URL, and -- the crux -- does NOT present the spec-declared SLAS_*_ADMIN roles as the operative gate while still being free to name them as the declared-but-not-enforced ones.

Deterministic suites at HEAD: dsc-scenario 17/17, `_shared` 16/16, dsc-endpoint-help 4/4. RED-first throughout (each new function/citizen had a failing test before implementation; the drifted-through-compose integration test drives the real auth-admin correction to drifted via a synthetic op doc whose `security[]` names `CCDX_SBX_USER`).

Live premise probe (`test-corrections-live.js`, opt-in `DSC_LIVE_TESTS=1`): both anchors HOLD against the live spec -- the author-time verification that neither citizen ships born-drifted. This test is designed to redden when upstream drifts; that red is the maintainer re-verify alarm, not a flaky failure.

A full-suite synthesis run over all ten fixtures did NOT come back clean, and the causes split three ways -- worth stating precisely, because the first reading ("all throttle") was wrong. Four unrelated long-flow fixtures (the multi-leg SLAS PKCE plans) timed out on wall-clock -- environmental, the API was throttling. The four fixtures touching this iteration's code (`am-admin-corrected-gate`, `am-admin-orders`, `ocapi-submit-basket`, `ocapi-data-code-versions`) passed clean -- so the iteration did not regress the suite. But the tenth, `synthesis-scenario-inreference-producer-pick` (unrelated to corrections), was a REAL strict failure, not throttle: across 5 runs one was flagged `worktree_contaminated` and one had a genuine content miss -- the model, composing a terser answer, dropped the runnable's deterministic `# Combined scopes required:` line (and any prose scope mention), so the scopes assertion correctly failed. `--runs 5` strict means one bad run sinks the fixture. This is a relay-fidelity gap, not model entropy: the scope line is emitted deterministically by `curl-block.js`; the failure is the model not relaying it -- a leak of the "model relays, scripts compose" thesis, which the strict gate exists to catch. Fixed by hardening the SKILL.md output template to mark the `Combined scopes required:` line mandatory and "verbatim" to mean every line of the runnable including that header; re-verified 10/10 strict on Sonnet (0 failed asserts, 0 contaminated) where the pre-fix rate was ~1/5. The lesson for the family: a fixture that is "green" only because its flaky run happened not to fire is not green -- root-cause the intermittent miss, do not bank on it re-greening.

## Out of scope / carried forward

- **A `now()`-based staleness automation** is deliberately excluded: the clock-free invariant is load-bearing (a time-branched decision or asserted fixture would be flaky). `verifiedOn[].date` informs the human, never a code path.
- **Schema-field anchors beyond masked_number** are supported by the field-agnostic `read` but only one ships; a scope-rename or body-field-change correction would reuse the same triple.
- **Correction notes carry no `reference`/`area`**, so the staleness caveat's "target's reference in `staleness`" cross-check is robust only because both citizens anchor on the target's own reference; a future cross-reference anchor would want the anchored reference stamped onto the note.
- **The `masked_number` read cannot distinguish "property removed" from "type file absent"** (both yield `holds:false` -> drifted); fail-toward-drifted still holds, only the drift wording could mislead on a cache miss.
- **Minor polish** left for a follow-up: the live-test temp cache dir is not cleaned after a run; the drifted-note render guidance does not surface `cite`/`scope` alongside the re-verify banner; a pre-existing en-dash in `dsc-endpoint-help/scripts/diff.js` comments (not introduced here).
