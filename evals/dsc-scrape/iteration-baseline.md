# iteration-baseline

**Date:** 2026-05-09
**Model:** Sonnet 4.5
**Result:** 20/20 passed, runs=3, ~14.6 min wall clock.

## Hypothesis

`dsc-scrape` was reframed in the 2026-05-08 architecture refactor from "the data layer the synthesis skills depend on" to an honest peer Skill that fires when the user asks to scrape something directly. There was no eval set asserting that, so the trigger surface was unverified.

The hypothesis was that the existing description fires correctly on direct scrape asks (positives) and declines for spec-field lookups, failure diagnoses, and workflow plans (negatives that should route to `dsc-endpoint-lookup`, `dsc-triage`, `dsc-scenario`). The eval was authored as the first baseline.

## Setup

Authored `evals/dsc-scrape/trigger-eval.json` with 20 queries: 10 positives spanning the trigger phrasings the description calls out (scrape/pull/fetch/mirror/capture/discover/get the contents of, plus catalog/area-landing/reference-root URL shapes), and 10 negatives spanning cross-skill routing (lookup, triage, scenario), out-of-scope DSC asks (atlas books, release notes, conceptual questions), and non-DSC asks (local openapi files, GitHub API, conceptual training questions).

## Result

All 10 positives at 3/3, all 10 negatives at 0/3 (i.e. correctly declined).

| Query class | Triggers |
|---|---|
| 10 scrape/fetch/mirror/discover positives | 30/30 |
| dsc-endpoint-lookup negatives (spec-field lookup) | 0/9 |
| dsc-triage negatives (failure diagnosis) | 0/3 |
| dsc-scenario negatives (workflow plan) | 0/3 |
| Out-of-scope DSC negatives (atlas, release notes, concept) | 0/9 |
| Non-DSC negatives (local file, GitHub, concept) | 0/6 |

(Per-class counts overlap; some negatives test multiple decline boundaries.)

## Verdict

Hypothesis confirmed. `dsc-scrape`'s description triggers correctly on direct scrape asks and declines cleanly for cross-skill and out-of-scope queries on Sonnet. No description changes needed.

This is the first trigger eval ever run for `dsc-scrape`; closes a known gap in trigger-accuracy coverage.

## Cross-skill observations (not dsc-scrape concerns, but worth noting)

A couple of negatives surfaced minor cross-skill triggering details. None are dsc-scrape-relevant since they all correctly declined to invoke `dsc-scrape`, but they're worth flagging for follow-on iterations of the dependent skills:

- "what calls do i need to make before createOrder on shopper-orders, in what order, with what scopes" routed to `dsc-endpoint-lookup` once and `dsc-scenario` twice (one of which was a TIMEOUT). That's a `dsc-scenario` trigger weakness, not a `dsc-scrape` one. The phrasing is squarely in `dsc-scenario`'s lane (multi-call workflow plan with scope union). Worth a `dsc-scenario` iteration if it shows up in that skill's eval set.
- The atlas Platform REST guide negative ("scrape the Salesforce Platform REST API guide at developer.salesforce.com/docs/atlas.en-us...") correctly declined to invoke `dsc-scrape` but in one run produced `ToolSearch` and in another produced no tool use (text-only). Acceptable -- the description's "Not for guides, concept pages, atlas-format books" decline language fired correctly.

## Files in this iteration

- `evals/dsc-scrape/trigger-eval.json` – 20-query baseline eval set authored in this iteration.
- `runs/iteration-baseline/results.json` – probe-eval output (gitignored, regenerable).
