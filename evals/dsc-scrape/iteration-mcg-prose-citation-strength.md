# iteration-mcg-prose-citation-strength

**Date:** 2026-05-10
**Skill:** dsc-scrape (synthesis-eval, second iteration)
**Tool:** tools/synthesis-eval.py
**Model:** Sonnet 4.5
**Predecessor:** iteration-skeleton-citation-leak (4/5 strict, surfaced this finding)

## Hypothesis

The 1/5 slip in `iteration-skeleton-citation-leak` was a prose gap, not a
flake. dsc-scrape's SKILL.md contains no "cite the public URL, not the
cache path" rule – that rule lives only in the three synthesis skills
(`dsc-triage`, `dsc-scenario`, `dsc-endpoint-lookup`). When dsc-scrape
fires for a discovery question ("which endpoints does X expose?") and
composes the answer itself rather than handing off, no prose tells the
model that listing reference family names without URLs is not a
citation. Adding an explicit rule – with the discovery-style answer
shape called out by name – should eliminate the slip.

## Diff against predecessor

The 5 transcripts under
`runs/iteration-skeleton-citation-leak/transcripts/` show two real
differences between run 3 (the failure) and the four passing runs:

1. **Run 3 skipped the catalog scrape entirely.** Tool sequence was
   `Skill → Read(aliases.js) → Bash(scrape MCG references) → ...`
   Runs 1, 2, 4 all opened with `Bash(scrape /docs/apis catalog) →
   Read(_catalog.json) → Read(aliases.js)`. Run 5 also did the catalog
   first (against `/tmp/dsc-scrape/`).
2. **At composition time, run 3 listed reference family names in prose
   without URLs.** The factual content was identical to the passing
   runs – same families, same "no event-sending endpoints" conclusion –
   but each item appeared as `**Briefs** (create/read/update/delete
   briefs)` rather than as `Briefs API
   (https://developer.salesforce.com/.../mc-rest-briefs)`.

The cascade-skip likely contributes: when the model walks
catalog → landing → references, public URLs are in hand at every step.
The shortcut path still scraped reference roots (so the URLs *were*
available in the cache), but at composition time prose-listing came
easier than re-fetching them.

The skill prose can't force a particular cascade order, but it can
require that whichever cascade the model takes, the answer it composes
must cite each reference's URL inline. That makes the citation
contract independent of cascade variance.

## Prose change (attempt 1)

Added a new `## Citing in the answer` section to
`skills/dsc-scrape/SKILL.md` between "Reading the output" and "Scope":

> Every customer-facing answer this skill composes from the scraped
> JSON cites public `developer.salesforce.com` URLs. Never cite the
> local cache path (`~/.cache/dsc-scrape/...`) and never cite the
> skill's own files (`~/.claude/skills/...`) – those are skill
> internals; engineers forward these answers to customers. The URLs
> are already in the JSON: `_landing/<product>_<area>.json` carries
> the area `url`, each per-slug file carries a `url` field, and
> `_index.json` per reference carries `source.specUrl`. When the
> answer is a list of references rather than a single endpoint – e.g.
> "which references does Marketing Cloud Growth expose?" – cite each
> reference's URL inline alongside its name. **Listing reference
> names without URLs is not a citation.** A discovery-style summary
> still has to be forwardable.

Three load-bearing pieces:

1. **Naming the negative space.** "Local cache path" and "skill's own
   files" with concrete patterns. Mirrors what the synthesis skills
   say.
2. **Pointing at the JSON fields that carry the URLs.** Removes the
   "I'd have to re-fetch" friction. Each layer of the cascade
   (`_landing`, per-slug, `_index`) has its URL field named.
3. **Calling out the discovery-style answer shape explicitly.** This
   is the slip's exact failure mode. The bolded "Listing reference
   names without URLs is not a citation" rules out the prose-only
   form by name.

## Run-by-run result (--runs 5 strict, attempt 1)

| Run | Assertions | first_skill | Notes |
|---|---|---|---|
| 1 | 3/3 PASS | dsc-scrape | clean |
| 2 | 3/3 PASS | dsc-scrape | clean |
| 3 | 3/3 PASS | dsc-scrape | clean (the predecessor's failing run number) |
| 4 | 3/3 PASS | dsc-scrape | clean |
| 5 | 3/3 PASS | dsc-scrape | clean |

`=== synthesis-eval: 1/1 fixtures passed (5 runs each, strict, 182.0s) ===`

## --runs 10 confirmation

A 5/5 result on a single attempt could be luck. Re-ran at
`--runs 10` strict to confirm the prose change moved the rate.

`=== synthesis-eval: 1/1 fixtures passed (10 runs each, strict, 282.3s) ===`

10/10 runs passed all 3 assertions. The slip in the predecessor
iteration was a real prose gap, not a flake; closing the gap closed
the slip.

## Disposition

**Close the prose-citation finding with the prose change committed.** The 1/5 slip is gone at the rate this iteration required (5/5 strict; confirmed with 10/10). The
prose addition is small and concrete: it cites the JSON fields that
carry URLs, names the discovery-style answer shape that produced the
slip, and uses the same negative-space framing as the synthesis
skills' citation rules. No fixture or assertion change needed; the
harness caught a real prose gap and the prose fix held.

The "don't tune fixtures to pass" norm from the harness design was
respected throughout: the regex stayed exactly as authored in the
skeleton iteration; the only thing that changed was the skill prose.

## Cross-reference

- Predecessor: `evals/dsc-scrape/iteration-skeleton-citation-leak.md`
- Run-3 transcript (gitignored): `runs/iteration-skeleton-citation-leak/transcripts/mcg-alias-citation-leak-3.jsonl`
- Heavy artifacts (gitignored): `runs/iteration-mcg-prose-citation-strength/`
