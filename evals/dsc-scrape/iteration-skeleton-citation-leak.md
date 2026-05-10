# iteration-skeleton-citation-leak

**Date:** 2026-05-10
**Skill:** dsc-scrape (synthesis-eval, first iteration)
**Tool:** tools/synthesis-eval.py (skeleton landed this session)
**Model:** Sonnet 4.5
**Result:** 4/5 runs passed all 3 assertions; 1/5 failed on the positive
citation assertion. Strict mode reports `0/1 fixtures passed (5 runs each,
strict, 146.8s)`.

## Hypothesis

The MCG cascade – catalog miss → aliases.js read → MCG references area
scrape → 7+ reference scrapes → operation read – must produce a final
answer that cites developer.salesforce.com URLs only and never local
cache paths or skill internals. Long cascades are where the citation-leak
regression (commit a3b461f) historically appeared. A fixture with two
negative assertions (no `~/.cache/`, no `/.claude/skills/`) plus one
positive assertion (must cite a marketing-cloud-growth DSC URL) catches
the recurrence and refuses to pass on a vacuous "I can't find anything"
answer.

## Run-by-run result

| Run | Assertions | first_skill | Notes |
|---|---|---|---|
| 1 | 3/3 PASS | dsc-scrape | clean |
| 2 | 3/3 PASS | dsc-scrape | clean |
| 3 | 2/3 FAIL | dsc-scrape | citation regex did not match – prose-only answer |
| 4 | 3/3 PASS | dsc-scrape | clean |
| 5 | 3/3 PASS | dsc-scrape | clean |

Run 3 failed `final_text_matches developer\.salesforce\.com/.+marketing-cloud-growth`.
The other two assertions on run 3 passed – no `~/.cache/` leak, no
`/.claude/skills/` leak. Cascade routing was correct on every run
(`first_skill: dsc-scrape` 5/5; `triggers: 5/5`).

## What run 3's answer actually said

Sonnet summarized the MCG endpoint families in prose form without
emitting any DSC URL. Quoting the run's `result` event:

> Based on my scrape of all Marketing Cloud Growth API references, **there
> are no dedicated event-sending endpoints** in the published references.
> The available reference families focus on:
>
> - **Briefs** (create/read/update/delete briefs)
> - **Contacts** (REST and Bulk APIs for contact management)
> - **Leads** (REST and Bulk APIs for lead management)
> - **Segments** (REST and Data Cloud Connect APIs for segment management)
> - **Identity Resolution** (Data Cloud Connect API for identity resolution rulesets)
>
> None of these references expose endpoints explicitly for "sending events"
> in the traditional sense (like event ingestion or behavioral tracking).
> [...continues with prose-only related-references list, no URLs...]

The other 4 runs all included real `developer.salesforce.com/docs/marketing/marketing-cloud-growth/references/...`
URLs (linking individual reference families).

## Disposition

**Land as-is and file the prose finding as its own follow-up.** The
assertion is correct: the prose contract that DSC skills cite public
URLs is what the harness exists to defend, and the regex caught a real
prose-rule slip. The skill's behavior held 4/5 times under strict
conditions; 1/5 it dropped citations entirely.

Per the design spec norm (don't tune fixtures to pass): not loosening
the regex, not switching to lenient. The right response is to investigate the underlying prose – filed as a separate iteration (MCG prose-citation strength).

This iteration's pass/fail count (4/5 strict) reflects the truthful
state of the world. The harness landed AND surfaced a real finding on
its first fixture – which is the harness working as designed.

## What this session validates

- The skeleton harness drives Sonnet via `claude -p`, parses the
  stream-json transcript, and evaluates declarative JSON assertions
  against parsed tool_uses + final_text.
- Schema validation rejects malformed fixtures (exit 2). Verified
  during task 8 with a synthetic bad fixture (`bad.json` with missing
  `query` field).
- The fault-injection acceptance step (task 10, separate run with the
  first negative pattern flipped to `.`) confirmed the failure path
  reports the `because` string correctly, returns the failed run in
  the `--out` JSON with `pass: false` and `message: "pattern '.'
  unexpectedly matched"`, and exits 1.
- Cascade routing is consistent (5/5 to dsc-scrape).
- Citation-leak guard holds (5/5 negative assertions pass) – no run
  leaked `~/.cache/` or `/.claude/skills/` paths into the answer.
- Positive citation assertion holds 4/5 – the failure mode the harness
  caught is silence, not a leak.

