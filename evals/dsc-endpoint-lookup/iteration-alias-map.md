# iteration-alias-map

**Date:** 2026-05-09
**Model:** Sonnet 4.5 – not re-run, see "What this iteration validates" below.
**Result:** No probe-eval re-run. Triggering for MCG was already proven 3/3 in `iteration-data360-mcg-coverage.md` (29/29). Triggering for Agentforce is proven 3/3 through dsc-scrape's `iteration-baseline.md` (20/20) – Agentforce surfaces through dsc-scrape's "discover what's under X" positive, not through dsc-endpoint-lookup directly.

## Hypothesis

The discovery cascade described in `dsc-endpoint-lookup`, `dsc-scrape`, `dsc-scenario`, and `dsc-triage` SKILL.md prose dead-ends at "ask the user for a URL" when the user names a product that exists on developer.salesforce.com but isn't in the `/docs/apis` machine-readable catalog (`_catalog.json`). Marketing Cloud Growth and Agentforce are the two known cases. A small static alias map (lowercase user-hint substring → canonical reference URL) gives the cascade a structured fallback before asking the user.

An earlier proposal to add 1-2 alias-driven trigger-eval positives per family turned out to misframe what trigger-eval can validate – see "What this iteration validates."

## Live walks (2026-05-09)

Both products walked cleanly through the existing scraper, no code changes needed:

| Product | URL | Shape | Sample reference (slugs written) |
|---|---|---|---|
| Marketing Cloud Growth | `/docs/marketing/marketing-cloud-growth/references` | `area-landing`, 10 refs (8 `rest-oa3` + 2 `markdown`) | `mc-rest-contacts` (12 slugs) |
| Agentforce | `/docs/ai/agentforce/references` | `area-landing`, 10 refs (3 `rest-oa3` + 7 `markdown`) | `agent-api` (83 slugs) |

Confirmed neither product appears in `_catalog.json` (all 20 catalog products listed; none match by title or body). The earlier URL guess for MCG was correct; Agentforce had no canonical URL captured anywhere and was found via DuckDuckGo site-search.

## Setup

The alias map landed at `skills/_shared/scrape/aliases.js`:

```js
const CATALOG_MISSING_ALIASES = {
  'marketing cloud growth': 'https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/references',
  'mcg': 'https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/references',
  'marketing cloud next': 'https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/references',
  'agentforce': 'https://developer.salesforce.com/docs/ai/agentforce/references',
};
```

Cascade prose updated in all four SKILL.md files (`dsc-endpoint-lookup` Step 2, `dsc-scrape` "Catalog product names drift...", `dsc-scenario` and `dsc-triage` "Key invariants"). The contract is: lowercase the user's hint, substring-match against keys, use the URL.

Two tests landed:

- `skills/_shared/tests/test-aliases.js` (offline, always-on) – shape lint: object, non-empty, keys lowercase, values match `^https://developer\.salesforce\.com/docs/.+/references$`.
- `skills/_shared/tests/test-aliases-live.js` (opt-in, gated on `DSC_LIVE_TESTS=1`) – GET each unique URL, expect 2xx/3xx. Uses GET not HEAD because DSC's CDN returns 404 on HEAD for `/docs/ai/agentforce/references` despite GET 200.

Both tests pass; full `_shared` suite is 6/6 offline.

## What this iteration validates

The probe-eval harness scores *triggering* (the first `tool_use` event in the stream-json). It doesn't see what happens inside the skill: which URLs the cascade resolves, which citations the answer carries, whether the alias map fired or the cascade fell through to "ask the user." Adding more MCG / Agentforce triggers to `trigger-eval.json` would re-prove triggering (already 3/3 for both) without proving the alias path is wired.

What this iteration *does* validate:

| Behavior | Validation |
|---|---|
| Triggering on MCG hint phrases | `iteration-data360-mcg-coverage.md` (3/3 on dsc-endpoint-lookup) |
| Triggering on Agentforce hint phrases | dsc-scrape `iteration-baseline.md` (3/3) |
| Alias map shape (typo regressions) | `test-aliases.js` (offline) |
| Alias map URL drift on Salesforce rebrands | `test-aliases-live.js` (opt-in, manually run) |
| End-to-end: hint → cascade → correct URL → correct citation | **NOT VALIDATED** – no harness for this, see below |

## Gap: end-to-end synthesis validation

The "alias path resolves correctly" assertion would require a harness that drives `claude -p` and inspects the full transcript (URLs scraped, final citations) – not just the first tool call. That harness doesn't exist for this family. Building it bundled with this PR would couple two unrelated decisions ("does this feature work" and "how do we test that any feature works"), so it's deferred to a future session.

The worst case of "alias map silently broken" is "cascade falls through to 'ask the user for a URL'" – the same fallback we had before this PR. So shipping without end-to-end validation is no worse than the prior state, and the offline + live tests catch the failure modes specific to the alias map (typos and URL drift).

## Coverage matrix changes

`docs/dsc-skills.md` matrix gains an Agentforce row. MCG already had ✅ for dsc-endpoint-lookup; the alias map doesn't change that.

| Family | dsc-scrape | dsc-endpoint-lookup | dsc-scenario | dsc-triage |
|---|---|---|---|---|
| Marketing Cloud Growth | ❌ | ✅ | N/A | N/A |
| **Agentforce** (new) | ✅ | ❌ | N/A | N/A |

Agentforce gets ✅ for dsc-scrape (proven through `iteration-baseline.md`'s "discover what's under Agentforce" positive). dsc-endpoint-lookup is ❌ – the trigger-eval has no Agentforce positive yet. dsc-scenario / dsc-triage are N/A on the same grounds as MCG (no thick prerequisite chains; no spec-declared scopes for triage to diff).

Adding an Agentforce dsc-endpoint-lookup positive is a follow-up – the alias path is wired regardless, and a positive query would only validate triggering, which the synthesis-harness work is the right place to actually validate.

