# DSC skills — architecture and design rationale

**Audience:** contributors extending the family. If you're looking for "which skill fires on my ask?" that lives in the [root README](../README.md#the-dsc-skill-family).

This doc explains the layering, why the boundaries are where they are, and what to keep in mind when extending or renaming skills in the family.

## Layers

The four `dsc-*` skills are **peer Skills sharing a scrape library.** All four build on `skills/_shared/scrape/` (URL classifier, format parsers, fetch + cache layer); none of them depends on another `dsc-*` skill at runtime. They share an on-disk cache (`~/.cache/dsc-scrape/`) so warming it from one skill benefits the others.

```
                         ┌───────────────────────────────────────────┐
                         │  skills/_shared/scrape/  (library)        │
                         │  • Fetches DSC spec files                 │
                         │    (OpenAPI 3, RAML/AMF, Swagger 2,       │
                         │     ReDoc)                                │
                         │  • Parses + writes per-slug JSON          │
                         │  • Owns network I/O and 1-hour TTL        │
                         │  • Produces structured JSON, no prose     │
                         │  Reached from each skill via lib/scrape/  │
                         └──────────────────────┬────────────────────┘
                                                │
              ┌──────────────────┬──────────────┴──────┬──────────────────┐
              ▼                  ▼                     ▼                  ▼
       ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
       │  dsc-scrape  │  │ dsc-endpoint-    │  │ dsc-scenario │  │  dsc-triage  │
       │  (raw-dump)  │  │ lookup           │  │ (walk-graph) │  │ (compare-two)│
       │              │  │ (extract-one)    │  │              │  │              │
       │  Thin Skill  │  │                  │  │  Walks the   │  │  Diffs a     │
       │  wrapper:    │  │  Reads ONE JSON, │  │  type graph  │  │  user's      │
       │  user asks   │  │  pulls ONE field,│  │  from a      │  │  failing     │
       │  "scrape X", │  │  formats as      │  │  target op,  │  │  request +   │
       │  scrape and  │  │  prose.          │  │  recursing   │  │  error vs.   │
       │  return JSON │  │                  │  │  through     │  │  the spec.   │
       │  on disk.    │  │  1 endpoint in,  │  │  prereq ops. │  │  Required vs.│
       │              │  │  1 answer out.   │  │  Composes    │  │  provided    │
       │  1 URL in,   │  │                  │  │  plan +      │  │  scopes;     │
       │  N JSON      │  │                  │  │  cURL.       │  │  required vs.│
       │  files out.  │  │                  │  │              │  │  actual      │
       │              │  │                  │  │  N eps in,   │  │  shape.      │
       │              │  │                  │  │  1 plan out. │  │              │
       │              │  │                  │  │              │  │  1 req +     │
       │              │  │                  │  │              │  │  1 err in,   │
       │              │  │                  │  │              │  │  1 diag out. │
       └──────────────┘  └──────────────────┘  └──────────────┘  └──────────────┘
```

## What each skill does

### dsc-scrape — raw-dump for direct user invocation

When the user explicitly asks to scrape, fetch, or mirror a DSC reference, this is the skill that fires. Thin wrapper around the shared scrape library: fetches a Salesforce API reference on developer.salesforce.com (`developer.salesforce.com/docs/.../references/<ref>`), parses it, and writes per-slug JSON under `~/.cache/dsc-scrape/<ref>/`. Returns the file list to the user.

**Produces:** `_index.json` (slug list + title + siblings), `Summary.json` (overview prose), `<operationId>.json` (one per endpoint), `types/<TypeName>.json` (one per named type).

**Used by:** humans who want the raw JSON dump (CI, ad-hoc inspection, populating the cache for later sessions).

The synthesis skills (`dsc-endpoint-lookup`, `dsc-scenario`, `dsc-triage`) **don't invoke `dsc-scrape`** — they call the shared library directly via `lib/scrape-refresh.js`. The on-disk cache layout is shared, so warming the cache from any of the four skills benefits the others, but at the runtime layer they're independent peers, not consumers.

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

Sharing the scrape library (`skills/_shared/scrape/`) **is** the right factoring. Sharing the synthesis layer is not.

## Discovery cascade

Synthesis skills (`dsc-endpoint-lookup`, `dsc-scenario`, `dsc-triage`) resolve a reference name to a concrete URL through a cascade backed by the shared scrape library:

1. `/docs/apis` (top-level catalog) → `_catalog.json` listing every product DSC publishes, with each product's `referenceUrl` and a `referenceShape` tag.
2. **Catalog-missing alias map** (`skills/_shared/scrape/aliases.js`) → for products that publish `/references/` pages but don't appear in `_catalog.json` (today: Marketing Cloud Growth, Agentforce). Lowercase the user's hint and substring-match against keys.
3. `/docs/<product>/<area>/references` (product-area landing) → `_landing/<product>_<area>.json` listing every reference in the area with its `id`, `title`, and `referenceType`.
4. `.../references/<name>` (reference root) → per-slug JSON (`Summary.json`, `<operationId>.json`, `types/<TypeName>.json`, plus `_index.json`).

A model's training-data memory of "which endpoint exists in which Salesforce reference" is unreliable, and DSC URL shapes drift (Data Cloud → Data 360 is the canonical example). The cascade is the structured-source-of-truth alternative to guessing. The "All DSC fetches go through the shared scrape library" invariant – repeated in every synthesis SKILL.md – means there's no escape hatch to `curl` or `WebFetch` for a quick verification; if a name doesn't resolve, the cascade is the answer.

All cascade-fetched URL shapes share the 1-hour TTL with reference scrapes, so once the cascade is warmed in a session, follow-on discovery is free. (The alias map is a static data file – no fetch, no TTL.)

For the full surface of URL shapes the scraper accepts, see `skills/dsc-scrape/SKILL.md`'s "URL shapes" table (the same library backs both the dsc-scrape Skill and the synthesis skills). The synthesis-side flow lives in `skills/dsc-endpoint-lookup/SKILL.md` Step 1, which mandates the cascade as the default discovery path; `dsc-scenario` and `dsc-triage` invariants point at the same cascade.

## Scope and coverage

The scraper isn't hard-coded to any one Salesforce product area – it handles any DSC reference that resolves to a supported machine-readable spec file. Today that's:

- **OpenAPI 3 (YAML)** — covers SCAPI and other modern references.
- **RAML via AMF JSON** — covers Einstein Recommendations and other RAML-backed families.
- **Swagger 2 (JSON or YAML)** — covers OCAPI (B2C Commerce legacy) and any other Swagger-2-backed reference.
- **ReDoc** — additional OpenAPI-3 surface.

Nothing in the synthesis layers is product-specific; extending to a new DSC family is primarily a scraper concern (URL shape, catalog mechanism, spec format).

### Coverage matrix

A previous version of this doc split coverage into three tiers (eval-validated / scraper-only / unsupported). Four families moved through the middle tier in 2026-05; each was promoted to eval-validated in the same session it was added, with no skill changes and no eval surprises. The intermediate tier turned out to be a holding pen rather than a meaningful capability state, so this section replaces the tier ladder with a per-skill matrix. The matrix expresses the actual interesting axis: a family can be eval-validated against one synthesis skill but not another.

`dsc-scrape` is the data layer – every family the scraper handles is verified by the scraper's own test suite (`skills/dsc-scrape/tests/`); the `dsc-scrape` column tracks whether the family is exercised through the scraper's *own* trigger-eval. The three synthesis-skill columns track whether each skill's trigger-eval has positive queries naming the family.

| Family | dsc-scrape | dsc-endpoint-lookup | dsc-scenario | dsc-triage |
|---|---|---|---|---|
| SCAPI | ✅ | ✅ | ✅ | ✅ |
| SLAS | ✅ | ✅ | ✅ | ✅ |
| Einstein API (cQuotient) | ✅ | ✅ | N/A (independent calls) | N/A (no spec scopes) |
| OCAPI | ✅ | ✅ | ✅ | ✅ |
| Data 360 Connect REST API | ❌ | ✅ | N/A (thin chains) | N/A (no spec scopes) |
| Marketing Cloud Growth | ❌ | ✅ | N/A (thin chains) | N/A (no spec scopes) |
| Agentforce | ✅ | ❌ | N/A (thin chains) | N/A (no spec scopes) |

Legend: ✅ = trigger-eval has positive queries naming the family and they pass on Sonnet 4.5. ❌ = no positive coverage (untested). N/A = the synthesis skill's shape doesn't apply to this family (e.g. dsc-scenario needs structural prerequisites between calls; dsc-triage needs spec-declared scopes for the diff to be useful) – an honest "skill doesn't apply" rather than a forced positive. "decline-only" appeared in earlier versions of this matrix to mean "covered by a negative-routing query"; OCAPI moved out of that state in the iteration below.

Per-family detail (citations to iteration notes for the curious):

- **SCAPI** – dsc-endpoint-lookup has 10 SCAPI positives; dsc-scenario and dsc-triage trigger-evals are SCAPI-heavy and pass under Sonnet 4.5 (10 positives + supporting negatives each, see the OCAPI iteration notes for the post-OCAPI totals). dsc-scrape's `iteration-baseline.md` has 2 SCAPI positives.
- **SLAS** – appears as positives across all four skills' trigger-evals; invoked correctly.
- **Einstein API (cQuotient)** – dsc-endpoint-lookup `iteration-einstein-coverage.md`, 23/23 under Sonnet 4.5; coverage spans all 4 references in the `einstein-api` product area (`einstein-activities`, `einstein-profile-connector`, `einstein-recommendations`, `einstein-gdpr`).
- **OCAPI** (Swagger 2 via `rest-oa2`, exposed under `b2c-commerce/references/b2c-commerce-ocapi`) – dsc-endpoint-lookup `iteration-ocapi-coverage.md`, 26/26 under Sonnet 4.5. 82 of 84 refList entries scrape; the 2 `markdown` wrapper entries skip cleanly. Parser tests + golden-output tests cover `ocapi-shop-products` and `ocapi-shop-baskets`. dsc-scenario `iteration-ocapi-coverage.md`, 23/23 under Sonnet 4.5 – 3 OCAPI positives covering `Submit basket` prereqs, a coupons-cURL scenario, and a registered-shopper customer flow. dsc-triage `iteration-ocapi-coverage.md`, 23/23 under Sonnet 4.5 – 3 OCAPI positives covering `InvalidClientIdException`, `AuthenticationFailedException`, and `MissingRequiredPropertyException`. dsc-triage's classifier was extended in the same iteration to inspect `body.fault.{type, message}`; OCAPI's `{"fault":{...}}` envelope previously fell through to `UNKNOWN`.
- **Data 360 Connect REST API** (OAS 3 via `rest-oa3` at `/docs/data/connectapi/references/spec`, listed in `/docs/apis` as area-landing) – dsc-endpoint-lookup `iteration-data360-mcg-coverage.md`, 29/29 under Sonnet 4.5. Single-reference family with 1008 slugs; uses singular `reference-config` (ReDoc-style) attribute. Spec-declared scopes are absent; auth is OAuth + Connect REST per the Summary prose.
- **Marketing Cloud Growth** (OAS 3 via `rest-oa3` at `/docs/marketing/marketing-cloud-growth/references`) – dsc-endpoint-lookup `iteration-data360-mcg-coverage.md`. Catalog-missing (not in `/docs/apis`) but reachable by direct URL through the catalog-missing alias map (`skills/_shared/scrape/aliases.js`). 8 `rest-oa3` + 2 `markdown` skipped; parser tests cover the landing fixture. Endpoint operationIds carry spaces.
- **Agentforce** (mixed `rest-oa3` + `markdown` at `/docs/ai/agentforce/references`) – dsc-scrape `iteration-baseline.md` covers the trigger ("discover what's under Agentforce on developer.salesforce.com – list the references"). Like MCG, catalog-missing but reachable through the alias map. Live-walked 2026-05-09 in `dsc-endpoint-lookup/iteration-alias-map.md`; 3 `rest-oa3` (notably `agent-api`, 83 slugs) + 7 `markdown` skipped. No dsc-endpoint-lookup positive yet – adding one is a follow-up; the alias path is wired regardless.

### Known gaps

- **Einstein Bot API / Marketing Cloud Einstein Content Selection** and other adjacent Einstein-branded products that aren't part of the `einstein-api` product area. Different reference surfaces; not addressed by the einstein-api coverage above. No live walk attempted yet.
- **Most of the catalog products beyond what's listed above.** `/docs/apis` lists 20 products; this matrix covers 6 of them end-to-end. The other 14 are reachable in principle (`referenceShape: area-landing`), but none have fixtures or trigger evals. They're not "unsupported" – they're "untested." If a user query surfaces one, walk it live first; the OCAPI / Data 360 lessons apply.

## Extending the family

### Adding support for a new DSC reference family

Most of the work is in the shared scrape library, not the synthesis skills. In rough order:

1. Find a representative reference URL and check what the page hands out – spec file format, catalog mechanism (`reference-set-config` attribute, refList location).
2. Add URL-shape detection in `skills/_shared/scrape/classify.js` if the URL doesn't match an existing shape.
3. If the format is unsupported, add a parser under `skills/_shared/scrape/parse-*.js`.
4. Wire it into `handleReference` in `skills/_shared/scrape/scrape.js`.
5. Add fixtures + tests under `skills/dsc-scrape/tests/` (that's where the library's tests live – dsc-scrape is the test-owning peer).
6. Add positive trigger-eval queries for the new family to *at least one* synthesis skill's `evals/<skill>/trigger-eval.json`, run `tools/probe-eval.py`, and write an `iteration-<name>.md` notes file with the result. Same commit as the scraper change.

**Policy: scraper changes and synthesis trigger-evals land together.** Never ship a scraper-only PR that leaves a family in "scraper works but no eval validates the synthesis path." Prior versions of this doc carried a "tier 2" state for that, but every family that landed in it was promoted to full eval coverage same-session anyway, so the intermediate state was holding-pen, not capability gradient. The eval is cheap (~15 min Sonnet probe) and catches synthesis-layer issues the scraper tests can't see (e.g. an OCAPI operationId with spaces routing differently than a SCAPI camelCase operationId). Don't skip it.

If extending a synthesis skill's coverage past one representative family is out of scope, document which skills haven't been eval'd against the family in the matrix above (with `❌`), so the gap is visible rather than implicit.

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
- **Non-DSC asks.** If the user's ask isn't about a DSC reference (GitHub API scopes, a local OpenAPI file, atlas / Experience Cloud guides), all four `dsc-*` skills should decline. Other skills in the repo address their own domains and aren't a fallback for non-DSC API asks.

## Changelog pointer

See commit messages tagged `feat(dsc-*)`, `refactor(dsc-*)`, and `eval(dsc-*)` for how boundaries have shifted. The most recent rename (`dsc-query` → `dsc-endpoint-lookup`) is a clear example of how a skill's *name* primes trigger accuracy as much as its description does.
