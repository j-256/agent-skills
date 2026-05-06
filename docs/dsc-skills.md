# DSC skills — architecture and design rationale

**Audience:** contributors extending the family. If you're looking for "which skill fires on my ask?" that lives in the [root README](../README.md#the-dsc-skill-family).

This doc explains the layering, why the boundaries are where they are, and what to keep in mind when extending or renaming skills in the family.

## Layers

The four `dsc-*` skills form **one data layer plus three synthesis layers on top.** They share a cache (`~/.cache/dsc-scrape/`) and compose, not duplicate.

```
                         ┌───────────────────────────────────────────┐
                         │  dsc-scrape  (data layer)                 │
                         │  • Fetches DSC spec files                 │
                         │    (OpenAPI 3, RAML/AMF, ReDoc)           │
                         │  • Parses + writes per-slug JSON          │
                         │  • Owns network I/O and 1-hour TTL        │
                         │  • Produces structured JSON, no prose     │
                         └──────────────────────┬────────────────────┘
                                                │
                      ┌─────────────────────────┼─────────────────────────┐
                      ▼                         ▼                         ▼
       ┌──────────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
       │  dsc-endpoint-lookup     │  │  dsc-scenario        │  │  dsc-triage          │
       │  (extract-one)           │  │  (walk-graph)        │  │  (compare-two)       │
       │                          │  │                      │  │                      │
       │  Reads ONE JSON, pulls   │  │  Walks the type      │  │  Diffs a user's      │
       │  ONE field, formats as   │  │  graph from a target │  │  failing request +   │
       │  prose.                  │  │  op, recursing       │  │  error against the   │
       │                          │  │  through prerequisite│  │  spec. Required vs.  │
       │  1 endpoint in,          │  │  ops. Composes plan  │  │  provided scopes;    │
       │  1 answer out.           │  │  + runnable cURL.    │  │  required vs. actual │
       │                          │  │                      │  │  request shape.      │
       │                          │  │  N endpoints in,     │  │                      │
       │                          │  │  1 plan out.         │  │  1 failing request + │
       │                          │  │                      │  │  1 error in,         │
       │                          │  │                      │  │  1 diagnosis out.    │
       └──────────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

## What each skill does

### dsc-scrape — the data layer

Fetches a Salesforce API reference on developer.salesforce.com (`developer.salesforce.com/docs/.../references/<ref>`), parses it, and writes per-slug JSON under `~/.cache/dsc-scrape/<ref>/`. Owns a 1-hour TTL matching DSC's upstream `cache-control: max-age=3600`, so repeat invocations are effectively free.

**Produces:** `_index.json` (slug list + title + siblings), `Summary.json` (overview prose), `<operationId>.json` (one per endpoint), `types/<TypeName>.json` (one per named type).

**Consumed by:** the other three DSC skills, plus any human who wants the raw JSON.

**Owns:** all network I/O in the family. The synthesis skills never call `fetch`; they either find data in the cache or ask `dsc-scrape` to populate it.

### dsc-endpoint-lookup — extract-one

Reads one endpoint JSON, pulls one specific field (scopes, params, body, response schema, auth scheme, method/path), and formats it as prose with the public DSC URL as the citation. Declines when the ask isn't a spec-field question (code generation, how-to, concept comparison).

**Shape:** 1 endpoint in → 1 answer out. Bounded work; fits in one short response.

**Example ask:** "what scopes does shopper-products getProducts need?"

### dsc-scenario — walk-graph

Given a target operation (or a natural-language goal that resolves to one), walks the type graph to find prerequisite operations – ops whose responses produce fields the target needs as inputs. Recurses until it hits primitives or auth material. Composes a linear plan with scope union across all steps, ID threading (e.g. basket IDs flow into line-item paths), and emits a runnable cURL block with per-step placeholders.

**Shape:** N endpoints in → 1 plan out. Graph traversal, not field extraction.

**Example ask:** "what do I need to call before createOrder so it'll succeed?"

### dsc-triage — compare-two

Takes a failing Salesforce API request (cURL, raw HTTP, or `{method, url}`) plus the error response and diffs:
- Required scopes (from the spec) vs. provided scopes (decoded from the JWT, or from a registered client list the user supplies).
- Required request shape (from the spec) vs. actual request shape.

Returns a structured diagnosis: one of a small set of error classes (missing scope, invalid client, malformed body, …) or `UNKNOWN` if the spec can't explain the failure. Hands off honestly for 5xx, 404 resource-missing, 409 conflicts – those aren't spec-explainable.

**Shape:** 1 failing request + 1 error in → 1 diagnosis out. A diff, not a lookup.

**Example ask:** "why is this request failing – `insufficient_scope`, but I thought my client had everything?"

## Why this split and not one big skill?

The synthesis work in the three layers is categorically different:

| Dimension | endpoint-lookup | scenario | triage |
|---|---|---|---|
| **Inputs** | 1 endpoint name | 1 target + N prerequisites | 1 request + 1 error |
| **Cache reads** | 1 file | tens of files (graph walk) | 1-3 files |
| **Synthesis** | none — quote the spec field | scope union, ID threading, business-logic ordering | diff observed vs. expected |
| **Output shape** | prose + `Source:` URL | templated plan + bash block + sources | templated diagnosis with error class, diff blocks, sources |
| **User intent** | "what does X require" | "how do I reach X" | "why is X failing" |

Collapsing them into one skill would mean one `SKILL.md` trying to describe three unrelated jobs, three distinct output templates, and the decline boundaries *between* them — replacing cross-skill decline rules with intra-skill conditional logic. That trades external factoring for internal complexity and doesn't simplify anything.

Sharing the data layer (`dsc-scrape`) **is** the right factoring. Sharing the synthesis layer is not.

## Discovery cascade

Consumer skills (`dsc-endpoint-lookup`, `dsc-scenario`, `dsc-triage`) resolve a reference name to a concrete URL through a three-step cascade, all rooted in `dsc-scrape`:

1. `/docs/apis` (top-level catalog) → `_catalog.json` listing every product DSC publishes, with each product's `referenceUrl` and a `referenceShape` tag.
2. `/docs/<product>/<area>/references` (product-area landing) → `_landing/<product>_<area>.json` listing every reference in the area with its `id`, `title`, and `referenceType`.
3. `.../references/<name>` (reference root) → per-slug JSON (`Summary.json`, `<operationId>.json`, `types/<TypeName>.json`, plus `_index.json`).

A model's training-data memory of "which endpoint exists in which Salesforce reference" is unreliable, and DSC URL shapes drift (Data Cloud → Data 360 is the canonical example). The cascade is the structured-source-of-truth alternative to guessing. The "All DSC fetches go through `dsc-scrape`" invariant – repeated in every consumer SKILL.md – means there's no escape hatch to `curl` or `WebFetch` for a quick verification; if a name doesn't resolve, the cascade is the answer.

All three URL shapes share the 1-hour TTL with reference scrapes, so once the cascade is warmed in a session, follow-on discovery is free.

For the full surface of URL shapes the scraper accepts, see `skills/dsc-scrape/SKILL.md`'s "URL shapes" table. The consumer-side flow lives in `skills/dsc-endpoint-lookup/SKILL.md` Step 1, which mandates the cascade as the default discovery path; `dsc-scenario` and `dsc-triage` invariants point at the same cascade.

## Scope and coverage

The scraper isn't hard-coded to any one Salesforce product area – it handles any DSC reference that resolves to a supported machine-readable spec file. Today that's:

- **OpenAPI 3 (YAML)** — covers SCAPI and other modern references.
- **RAML via AMF JSON** — covers Einstein Recommendations and other RAML-backed families.
- **ReDoc** — additional OpenAPI-3 surface.

Nothing in the synthesis layers is product-specific; extending to a new DSC family is primarily a scraper concern (URL shape, catalog mechanism, spec format).

### Verification tiers

Coverage claims here are split by how strongly they're verified, not by product area. Be precise about which tier a given reference sits in before relying on it.

**Tier 1 – eval-harness validated.** Trigger-accuracy runs this session actually invoke the synthesis skills against queries naming the family, the skill triggers, and it produces a usable answer.
- SCAPI – dsc-endpoint-lookup's `trigger-eval.json` has 10 SCAPI positives at 5/5; dsc-scenario and dsc-triage evals are SCAPI-heavy and at 20/20 under Sonnet 4.5.
- SLAS – appears in a handful of positive queries across all three skills' trigger-evals; invoked correctly.

**Tier 2 – scraper-level tested but synthesis not exercised in this project's eval harness.** `dsc-scrape`'s own test suite asserts the parser + catalog logic handle the family, but there's no trigger-eval or output-shape run under the current eval methodology that validates the synthesis skills against these references.
- Einstein Recommendations (RAML/AMF) – fixtures and tests at `skills/dsc-scrape/tests/fixtures/einstein-recommendations.amf.json` + `einstein-landing.html`, verified by `test-parse-amf.js`, `test-catalog.js`, and `test-golden.js`. `dsc-endpoint-lookup/evals/evals.json` has an aspirational `amf-reference` case against it, but that's a grading rubric, not a validated run.

**Tier 3 – known gaps (unsupported today).** Tracked as TODOs; scraper has no path.
- OCAPI (Swagger 2 / `b2c-api-doc.html` catalog)
- Data Cloud / Data 360 / Marketing Cloud Growth (atlas-style paths)
- Broader Einstein / cQuotient (anything beyond `einstein-recommendations`)

The tiers matter for honest description writing: if a new family moves from tier 3 to tier 1, it can go in a skill's description as a claimed coverage area. Tier 2 is scraper-verified but not enough to advertise family-wide support in trigger-sensitive description fields.

## Extending the family

### Adding support for a new DSC reference family

Most of the work is in `dsc-scrape`, not the synthesis skills. In rough order:

1. Find a representative reference URL and check what the page hands out – spec file format, catalog mechanism (`reference-set-config` attribute, refList location).
2. Add URL-shape detection in `skills/dsc-scrape/scripts/classify.js`.
3. If the format is unsupported, add a parser under `skills/dsc-scrape/scripts/parse-*.js`.
4. Wire it into `handleReference` in `skills/dsc-scrape/scripts/scrape.js`.
5. Add fixtures + tests under `skills/dsc-scrape/tests/`.
6. Once the scraper lands real JSON in the cache, the three synthesis skills should work against the new family without code changes. Validate with `tools/probe-eval.py` using a representative query.

### Adding a new skill to the family

A new synthesis skill should:

- Consume the shared cache, not talk to the network directly.
- Have an input/output shape that's categorically different from the existing three (extract-one, walk-graph, compare-two). If the shape is just a variant of one of these, extend that skill instead.
- Cite `developer.salesforce.com` URLs in its output, not local cache paths. This is a family-wide invariant (see `CLAUDE.md`).
- Decline when the user's ask is outside the family's domain (non-DSC APIs, user-supplied local specs, etc.) – these decline rules keep the whole family's trigger accuracy honest.

### Renaming or removing a skill

Update the root `README.md` in the same commit – skills table, install block, and any mentions in the DSC-family section. `CLAUDE.md` has a drift-prevention rule about this for a reason.

Sibling skills' SKILL.md `description` fields cross-reference each other ("that's `dsc-X`"). Grep the worktree for the old name before committing.

## Edges and caveats

- **Cross-reference scenarios.** If `dsc-scenario`'s graph walk surfaces an input that originates in another reference (most commonly SLAS `access_token` from `shopper-login`), the skill flags it as an `externalInputs` entry and asks the outer conversation to proceed. It doesn't transparently expand into a multi-reference plan.
- **Unknown errors in triage.** `dsc-triage` refuses to fabricate diagnoses for 5xx, 404 path-or-resource-missing, and 409 conflicts – those require runtime state the spec doesn't carry. It says so explicitly and hands off.
- **Non-DSC asks.** If the user's ask isn't about a DSC reference (GitHub API scopes, a local OpenAPI file, atlas / Experience Cloud guides), all four skills should decline. `stepped-demo-script` is the only skill in this repo that's intentionally domain-agnostic.

## Changelog pointer

See commit messages tagged `feat(dsc-*)`, `refactor(dsc-*)`, and `eval(dsc-*)` for how boundaries have shifted. The most recent rename (`dsc-query` → `dsc-endpoint-lookup`) is a clear example of how a skill's *name* primes trigger accuracy as much as its description does.
