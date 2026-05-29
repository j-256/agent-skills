# iteration-ocapi-alias-coverage

Status: DONE. 5/5 strict (25/25 runs) – every fixture in the synthesis-eval set passes, including the OCAPI fixture that regressed at 3/5 in `iteration-content-type-fixture-rewrite` and the JWT fixture that regressed at 1/5 (the JWT regression cleared without a code change; see "JWT also recovered" below). Adds OCAPI aliases to `skills/_shared/scrape/aliases.js` to cover the catalog gap that left `synthesis-diff-OCAPI-fault-envelope` at 3/5 in `iteration-content-type-fixture-rewrite`, plus a SCAPI entry alongside for symmetry. The deeper issue surfaced by transcript review: OCAPI references on DSC live under `/docs/commerce/b2c-commerce/references`, which doesn't appear in `/docs/apis`'s machine-readable catalog (`_catalog.json`). SCAPI lives at `/docs/commerce/commerce-api/references` and *is* in the catalog. Without an alias entry for OCAPI, the resolution cascade walks catalog → product landing → reference root, finds nothing matching "OCAPI" or "b2c-commerce" or "shop API" anywhere, and the model concludes – correctly given its data – that OCAPI isn't on DSC. This is a genuine catalog gap, the exact failure mode the alias map was built to cover.

## Hypothesis tested

Adding `ocapi`, `open commerce api`, `b2c-commerce`, `b2c commerce ocapi`, `/dw/shop`, `/dw/data`, and `x-dw-client-id` as alias keys (all pointing at `https://developer.salesforce.com/docs/commerce/b2c-commerce/references`, the area-landing that enumerates all 82 OCAPI sub-references with `referenceType: rest-oa2`) lets the resolution cascade find the OCAPI references in three different ways:

1. The user names the API family directly (`OCAPI`, `Open Commerce API`).
2. The user pastes a cURL with an OCAPI URL path (`/dw/shop/v23_2/customers/abc`) – the `/dw/shop` substring matches.
3. The user pastes a cURL with the OCAPI client-id header (`x-dw-client-id: ...`) – the header name matches.

The third surface is the reason `x-dw-client-id` is keyed: a user who pastes a cURL without typing the word "OCAPI" still has the header in the request, and the cascade's substring-match against the alias keys is the discovery hook. Once any of these matches, the cascade scrapes `/docs/commerce/b2c-commerce/references`, which yields a landing JSON with all OCAPI references enumerated; from there the existing query/triage flow resolves `ocapi-shop-customers` → `getCustomer` (or whichever endpoint matches the request path) and runs the same diff machinery as for SCAPI references.

## Why the catalog itself can't fix this

`/docs/apis` (DSC's catalog page) does not link to `/docs/commerce/b2c-commerce/references`. Verified: `curl -s 'https://developer.salesforce.com/docs/apis' | grep -oE 'href="[^"]*commerce[^"]*"' | sort -u` returns only commerce-api, einstein-api, pwa-kit-managed-runtime, and salesforce-commerce – no b2c-commerce. The catalog parser in `parse-api-catalog.js` extracts product entries from embedded JSON inside `/docs/apis`'s HTML; if DSC doesn't put b2c-commerce in that JSON, the parser can't synthesize an entry. The alias map is the documented escape hatch for products that publish a working `/references/` area-landing but don't appear in the catalog – exactly the case here.

## What changed

One edit to `skills/_shared/scrape/aliases.js`. Added 8 keys (7 for OCAPI, 1 for SCAPI symmetry). No SKILL.md edits, no script edits, no test edits.

```js
'scapi': 'https://developer.salesforce.com/docs/commerce/commerce-api/references',
'ocapi': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
'open commerce api': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
'b2c-commerce': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
'b2c commerce ocapi': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
'/dw/shop': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
'/dw/data': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
'x-dw-client-id': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
```

The SCAPI entry is defense-in-depth, not a behavior change: `_catalog.json`'s "B2C Commerce API" product entry already carries `searchKeys: ["OCI", "SLAS", "SCAPI"]`, so the catalog cascade resolves "SCAPI" to commerce-api correctly today. The alias map is a deterministic fallback if those `searchKeys` ever drift (rescrape variations, DSC HTML changes), and the OCAPI/SCAPI symmetry documents the two-areas-on-DSC distinction *in the data* the cascade reads – future contributors looking at the alias map see both halves of the Commerce confusion in one place. Lookup order is catalog-first, alias-map-fallback, so the SCAPI alias only fires if the catalog has gone silently stale.

`test-aliases.js` (offline shape/lowercase invariants) passes. `DSC_LIVE_TESTS=1 test-aliases-live.js` (live URL probe) passes – both `https://developer.salesforce.com/docs/commerce/commerce-api/references` and `https://developer.salesforce.com/docs/commerce/b2c-commerce/references` return 200; live test now probes 4 unique URLs (was 3).

## Eval results

`stream-eval synthesis --skill-path skills/dsc-endpoint-help --eval evals/dsc-endpoint-help/synthesis-eval.json --runs 5 --workers 4 --timeout 300 --out evals/dsc-endpoint-help/runs/iteration-ocapi-alias-coverage/results.json`

Wall-clock 409.3s. No abort, no gateway throttle. Exit code 0.

| Fixture | Pass count | Δ from prior iteration |
|---|---|---|
| `synthesis-diff-content-type-415` | 5/5 | – (held; no change since rewrite) |
| `synthesis-diff-insufficient-scope-shopper-baskets` | 5/5 | – |
| `synthesis-diff-hands-off-404-not-found` | 5/5 | – |
| `synthesis-diff-OCAPI-fault-envelope` | 5/5 | **3/5 → 5/5** (alias coverage validated) |
| `synthesis-diff-jwt-scope-decode` | 5/5 | **1/5 → 5/5** (recovered without a code change; see below) |

**Strict pass: 5/5 fixtures, 25/25 runs.** First clean strict pass on the full synthesis-eval set since the harness was wired up.

OCAPI run elapsed times (113s, 117s, 72s, 109s, 119s) are roughly 2-3× the SCAPI fixture times – the cascade is doing more work to scrape the b2c-commerce area landing on first miss, then querying. Acceptable; the cache warms after run 1 of each spawn but each run starts in a fresh isolated HOME.

Two `WORKTREE CONTAMINATED` warnings (`synthesis-diff-jwt-scope-decode-2`, `synthesis-diff-insufficient-scope-shopper-baskets-4`) – both `.cache/` writes from the spawn's own scrape activity, which is expected (the spawn writes to its temp HOME's `~/.cache/dsc-scrape/` during normal cascade operation). The harness's contamination detector flagged them defensively but neither passed the assertion threshold; both runs scored `pass=True`. Pre-existing harness behavior, not introduced by this change.

### JWT also recovered

`synthesis-diff-jwt-scope-decode` jumped from 1/5 to 5/5 with no code change to the JWT path. The 1/5 in the prior iteration was on `expected_skill_pass=false` because Sonnet was using `first_tool=Bash` directly (eval-environment-artifact tool substitution). In this run, every JWT run had `first_tool=Skill first_skill=dsc-endpoint-help`. Possible explanations: (a) Sonnet's tool-selection variance across runs – the prior 1/5 may have been a bad sampling slice; (b) the alias-map edit changed the SKILL.md preamble's effective entropy enough to nudge tool selection (unlikely – `aliases.js` is loaded post-Skill-invocation); (c) caching/warm-up effects. Worth noting but not actionable here. The JWT content was correct in every prior run; the regression was scoring-rule, not content. Recording the recovery doesn't validate a fix because there was no fix.

If the JWT fixture regresses again on a future iteration, the suspicion order is (a) > (c) > (b).

## Notes

- **Why not also add an OCAPI cascade nudge to SKILL.md.** Considered and rejected. The alias map already documents itself in SKILL.md ("A few products have `/references/` pages but don't appear in the `/docs/apis` catalog – if the catalog has no match... substring-match it against the keys in `lib/scrape/aliases.js`"). Adding OCAPI-specific prose duplicates that, biases the cascade toward OCAPI even when the user's question is unrelated, and rots if/when DSC fixes its catalog. The keys themselves are the documentation here.
- **Path-substring keys are unusual.** Most alias keys are natural-language product names (`marketing cloud growth`, `agentforce`). `x-dw-client-id` and `/dw/shop` are intentional: a cURL paste is the canonical way OCAPI shows up in this skill's diff branch, and the user often won't type the word "OCAPI" themselves. Substring-matching against the request body catches that. The alias map's contract is "lowercase the user hint, then substring-match against keys" – the keys can be any substring distinctive enough to identify the product family. Worth revisiting if a non-OCAPI prompt ever happens to contain one of these literal substrings (unlikely for `x-dw-client-id`; `/dw/shop` is more generic but still very Demandware-shaped).
- **What this doesn't fix.** A user asking about an OCAPI endpoint by SCAPI naming (e.g. "the shopper customers OCAPI getCustomer call") may still resolve to the SCAPI `shopper-customers` reference, since `shopper-customers` matches the SCAPI catalog entry. The diff-branch path inspector catches this – the URL path `/dw/` doesn't match SCAPI's `/checkout/` or `/customer/` prefix, so the cascade should re-resolve via the alias keys. If the model picks SCAPI first and doesn't catch the URL-shape mismatch, that's a separate cascade-correctness issue not addressed here.
