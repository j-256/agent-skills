# iteration-agentforce-url-trace

**Date:** 2026-05-10
**Skill:** dsc-scrape (synthesis-eval, third iteration)
**Tool:** tools/synthesis-eval.py
**Model:** Sonnet 4.5
**Predecessors:**
- iteration-skeleton-citation-leak (skeleton + first fixture, 4/5 strict)
- iteration-mcg-prose-citation-strength (prose fix, 10/10 strict)

## Hypothesis

The `tool_input_matches` assertion shape – never exercised by the
skeleton or prose-strength iterations – validates *cascade resolution*
rather than answer composition. A new fixture against Agentforce
(the second product the alias map covers, per commit faa2f20) asserts
that:

1. The user's natural-language hint ("Agentforce") triggers the
   catalog-missing alias-map fallback after the catalog scrape misses.
2. The alias map's resolved URL
   (`https://developer.salesforce.com/docs/ai/agentforce/references`)
   actually reaches a `Bash` scrape call – not just gets read off
   `aliases.js` and ignored.
3. The final answer cites a `developer.salesforce.com/docs/ai/agentforce`
   URL, applying the prose rule landed in `iteration-mcg-prose-citation-strength`
   to a second product.

A fixture on the second alias-map product also broadens cascade
coverage without overlapping the first fixture's assertion space – MCG
asserts on `final_text` only; Agentforce adds the `tool_input_matches`
shape on `Bash.command`.

## Fixture shape

Added second entry to `evals/dsc-scrape/synthesis-eval.json`:

```json
{
  "name": "agentforce-alias-url-trace",
  "query": "what API references does Agentforce publish?",
  "expected_skill": "dsc-scrape",
  "assertions": [
    { "kind": "tool_input_matches", "tool": "Bash", "field": "command",
      "pattern": "developer\\.salesforce\\.com/docs/ai/agentforce/references",
      "because": "alias map must resolve 'agentforce' to the canonical references URL and that URL must reach scrape.js – cascade resolution proof, not just file-read" },
    { "kind": "final_text_excludes", "pattern": "~/\\.cache/",
      "because": "citation-leak guard (a3b461f) – local cache paths must never appear in customer-facing answers" },
    { "kind": "final_text_matches", "pattern": "developer\\.salesforce\\.com/docs/ai/agentforce",
      "because": "must cite the public DSC URL the alias map resolved to (closes the iteration-mcg-prose-citation-strength rule on a second product)" }
  ]
}
```

Three assertions split across two layers:

- **One `tool_input_matches`** against `Bash.command` – proves the
  alias-resolved URL was passed to a scrape call. This is the new
  assertion shape this iteration exercises for the first time.
- **One `final_text_excludes`** for `~/.cache/` – baseline citation
  guard, same as the MCG fixture. (Skill-internals guard `/.claude/skills/`
  omitted on the assumption the citation rule from
  `iteration-mcg-prose-citation-strength` covers it; if a future run
  surfaces a leak, add it back.)
- **One `final_text_matches`** for `developer.salesforce.com/docs/ai/agentforce` –
  proves the citation rule landed for MCG also holds for Agentforce.

## Run-by-run result (--runs 5 strict, attempt 1)

`=== synthesis-eval: 0/2 fixtures passed (5 runs each, strict, 166.1s) ===`

| Fixture | Run | Pass | Notes |
|---|---|---|---|
| mcg-alias-citation-leak | 1 | ✅ 3/3 | clean |
| mcg-alias-citation-leak | 2 | ✅ 3/3 | clean |
| mcg-alias-citation-leak | 3 | ✅ 3/3 | clean |
| mcg-alias-citation-leak | 4 | ✅ 3/3 | clean |
| mcg-alias-citation-leak | 5 | ❌ 2/3 | final_text_matches MCG URL did not match – "no MCG events endpoint exists" answer pivoted entirely to citing Data 360 + Pub/Sub URLs without an MCG citation |
| agentforce-alias-url-trace | 1 | ❌ 2/3 | tool_input_matches did not match – cascade scraped `einstein/genai/references` instead of consulting aliases.js |
| agentforce-alias-url-trace | 2 | ✅ 3/3 | clean |
| agentforce-alias-url-trace | 3 | ✅ 3/3 | clean |
| agentforce-alias-url-trace | 4 | ✅ 3/3 | clean |
| agentforce-alias-url-trace | 5 | ✅ 3/3 | clean |

Two distinct slips, both real findings:

**Agentforce run 1 – cascade-discipline gap.** The cascade prose at
line 15 of dsc-scrape SKILL.md said: "After a catalog miss, lowercase
the user's hint and substring-match it against the keys in
`lib/scrape/aliases.js` ... before asking the user for a URL." But the
model didn't substitute *asking the user* with consulting the alias
map – it substituted by **guessing a related-looking product** in the
catalog (Einstein Gen AI). The catalog correctly returned no match for
"Agentforce" (alias-map's whole purpose), but the model bypassed
aliases.js entirely.

**MCG run 5 – negative-pivot citation gap.** The answer concluded
correctly that MCG has no event-sending endpoints, and pivoted to
citing where event-sending *does* exist (Data 360 Connect, Pub/Sub).
Both citation URLs are valid `developer.salesforce.com` URLs – the
two negative assertions both passed and the answer wasn't factually
wrong. But it dropped the MCG citation entirely, on the logic that
"there's nothing to cite from MCG since MCG has nothing." The
citation rule landed in `iteration-mcg-prose-citation-strength`
covers "list of references" but not "negative finding pivoting to
related products."

## Rephrasing applied (attempt 2)

Per stop condition: one prose tightening, then pause if still
failing. Tightened the cascade prose at line 15 to explicitly
prohibit substituting a related-looking product:

> ...After a catalog miss, lowercase the user's hint and
> substring-match it against the keys in `lib/scrape/aliases.js`
> ... before asking the user for a URL. **Don't substitute a
> related-looking product** when the catalog and alias map both
> miss – e.g. for "Agentforce" the catalog returns no match and
> the alias map is the canonical next step, not Einstein Gen AI
> or any other product whose name overlaps semantically. If both
> miss, ask the user for a URL.

Why this lever: the existing prose said "before asking the user"
which implicitly framed the alias map as a *fallback to* asking,
not as a mandatory step. The tightening makes the alias map the
canonical next step and names the failure mode (Agentforce →
Einstein-Gen-AI) inline as an example.

This rephrasing addresses the cascade-discipline slip
(Agentforce). It doesn't directly address the negative-pivot
citation slip (MCG run 5) – that's a separate finding worth its
own follow-up, parallel to how the prose-citation finding surfaced from the skeleton iteration.

## Run-by-run result (--runs 5 strict, attempt 2)

`=== synthesis-eval: 2/2 fixtures passed (5 runs each, strict, 161.4s) ===`

Both fixtures 5/5 across all assertions. The cascade-prose
tightening also closed the MCG run-5 slip incidentally – likely
because the cleaner cascade discipline reduces variance in how
the model composes the answer, but this is unproven on a single
attempt. The `--runs 10` confirmation tests this.

## --runs 10 confirmation

`=== synthesis-eval: 1/2 fixtures passed (10 runs each, strict, 387.4s) ===`

| Fixture | Pass count | Notes |
|---|---|---|
| mcg-alias-citation-leak | 9/10 | run 6 slipped on the positive citation – same negative-pivot pattern as attempt 1 run 5 (cited Data 360 URLs only, dropped MCG) |
| agentforce-alias-url-trace | 10/10 | clean across all assertions |

**Two distinct findings, two distinct dispositions:**

- **URL-trace (the iteration deliverable):** 10/10 strict. The
  cascade-prose tightening closed the discipline gap. Land it.
- **MCG negative-pivot (residual):** 9/10 strict. Same query
  shape, same failure mode. Not a regression of
  iteration-mcg-prose-citation-strength's fix (that fix holds for
  the discovery-style answer shape). This is a different shape
  the citation rule doesn't cover yet. Filed as a follow-up: negative-pivot citation rule.

The attempt-2 `--runs 5` apparent 5/5 on MCG was small-sample luck;
`--runs 10` revealed the ~10% slip rate. Worth noting for future iterations: 5-run confirmation can give a false negative on single-digit slip rates; the 10-run ratchet codified in the prose-citation iteration is the right bar for "is this prose actually working."

## Disposition

**Commit URL-trace + cascade-prose change + file the negative-pivot follow-up.** The new fixture this iteration was supposed to land is solid (10/10). The cascade-discipline finding shipped with this iteration's prose change. The negative-pivot finding becomes a separate follow-up, and synthesis-eval will report `exit=1` on the MCG slip until that follow-up closes – which is the harness working as designed (don't tune fixtures to pass; surface findings as separate iterations).

The "don't tune fixtures to pass" norm held: both assertions stayed
exactly as authored; the only thing that changed was skill prose, and
the second slip surfaced honestly as a separate finding rather than a regex
relaxation.

## Cross-reference

- Heavy artifacts (gitignored): `runs/iteration-agentforce-url-trace/`
