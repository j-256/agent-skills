# dsc-scrape

Claude Code skill that scrapes **developer.salesforce.com** (DSC) API reference docs into structured JSON. Invoked by Claude via the `Skill` tool; the agent-facing entry point is [`SKILL.md`](./SKILL.md).

## What it does

One call in, structured JSON out. `node scripts/scrape.js <url> <out>` takes any DSC reference URL and writes per-slug JSON files under `<out>`. Every slug of every reference DSC publishes -- SCAPI, Einstein, Data 360, Loyalty, etc. -- resolves to a single static spec file (OpenAPI 3 YAML or AMF-flavored JSON), which the script fetches and parses directly.

## What it produces

```
<out>/
├── <reference>/
│   ├── _index.json            reference-wide metadata (title, source, full slug list, siblings)
│   ├── Summary.json           reference overview (title, version, description, baseUrl)
│   ├── <operationId>.json     one per endpoint
│   └── types/
│       └── <TypeName>.json    one per named type
└── _landing/
    └── <path-slug>.json       for catalog / non-slug landing URLs (walks the refList, scrapes everything)
```

Each per-slug file has a unified envelope:

```json
{
  "kind": "endpoint" | "type" | "summary",
  "reference": "orders",
  "slug": "createOrders",
  "url": "https://developer.salesforce.com/...?meta=createOrders",
  "scrapedAt": "2026-04-27T...",
  "source": { "format": "oas-3" | "amf-raml", "specUrl": "https://.../...yaml" },
  "endpoint": { ... }   // or "type" / "summary"
}
```

OAS and AMF parsers produce identical envelope shape, so consumers don't branch on `source.format`.

## URL shapes handled

| URL | Behavior |
|---|---|
| `.../references/<name>?meta=<slug>` | Single slug |
| `.../references/<name>` or `?meta=Summary` | Whole reference (writes every slug) |
| `.../references` | Catalog root. Requires `--all`. Walks the refList, scrapes every reference |
| `.../references/<name>/<landing>.html` (e.g. `scapi-api-doc.html`) | Same as catalog root |

Out of scope: atlas books (`docs/atlas.*.htm`), MuleSoft (`docs.mulesoft.com`), guides, concept pages. The classifier declines these with a message.

## Installation

Prereqs: Node 18+ (for native `fetch`). Node 20+ preferred.

```bash
cd ~/.claude/skills/dsc-scrape
npm install   # installs js-yaml
```

To install the skill itself, drop this directory at `~/.claude/skills/dsc-scrape/`. Claude Code discovers skills by name from that tree.

## How it works

Every DSC `/references/` page carries a JSON `refList` as an HTML attribute: `reference-set-config` on the page root for the RAML/OAS viewer, or `reference-config` on a `<doc-redoc-reference>` element for the ReDoc viewer. Each entry in that list has a `source` field pointing to the static spec file:

- `referenceType: "rest-oa3"` -> `.yaml` OpenAPI 3 spec
- `referenceType: "rest-raml"` -> `.raml` (not fetched) plus a sibling `.raml.amf.json` with the pre-compiled AMF graph

Both static files are publicly fetchable with realistic Chrome-style headers (User-Agent + Sec-Fetch-* + Referer). One HTTP GET for the references-page HTML (to get the refList), one more per reference (for the spec file), and we're done.

### Pipeline

```
URL -> classify -> fetch references page -> parse refList
                                          -> fetch spec (YAML or AMF JSON)
                                          -> parse into [{kind, slug, payload}, ...]
                                          -> write per-slug JSON
```

### Module map

```
dsc-scrape/
├── SKILL.md                — agent-facing flow
├── README.md               — this file
├── package.json            — Node deps (js-yaml only)
│
├── scripts/
│   ├── scrape.js           — entry point; argv parsing, orchestration
│   ├── classify.js         — URL shape detection + decline cases
│   ├── fetch-url.js        — HTTP fetch with DSC-friendly headers
│   ├── parse-catalog.js    — refList extractor (handles both attr forms)
│   ├── parse-oas.js        — OpenAPI 3 spec -> slug list
│   ├── parse-amf.js        — AMF JSON graph -> slug list (same shape as OAS)
│   └── write-slugs.js      — disk layout: <ref>/<slug>.json + types/ subdir
│
├── tests/
│   ├── run.sh              — test runner (npm test)
│   ├── test-*.js           — unit tests (classify/catalog/parse-oas/parse-amf) + golden-diff
│   ├── fixtures/           — saved live DSC data (HTML + YAML + AMF)
│   └── expected/           — golden JSON for 6 slugs (Summary + endpoint + type, both parsers)
│
└── evals/evals.json        — agent-level eval prompts
```

## AMF notes (RAML parsing)

RAML references don't publish friendly YAML. Instead, DSC ships a pre-compiled AMF (API Modeling Framework) JSON-LD graph alongside each `.raml` file. The graph uses six vocabularies (`apiContract`, `raml-shapes`, `shacl`, `core`, `doc`, `data`) and wraps every value in single-element arrays (`[{@value: ...}]`) with `@id` cross-references.

Key architectural facts that made this tractable:

- **Every referenced fragment is bundled.** `doc:references` contains type libraries, traits, and named examples as inline fragments -- no external fetches needed. Only vocabulary IRIs (XSD primitives, AMF data-property names) point outside the file, and those are stable static namespaces, not data sources.
- **`@id` resolution is local.** A one-pass index of every defined node handles the reference graph. No network traversal.
- **Enums are `rdfs:Seq`.** `shacl:in` wraps enumeration values in `rdfs:_1`, `rdfs:_2`, etc. -- needs ordered walking, not array iteration. (Easy to miss on first pass.)

The parser is ~280 lines and produces output in the same shape as `parse-oas.js`, so downstream consumers don't care which parser ran.

## Tests

```bash
npm test
```

Runs 5 suites:

- **classify**: 10 URL classification cases
- **catalog**: 3 fixtures (SCAPI `reference-set-config`, Einstein `reference-set-config`, Data 360 `reference-config` on ReDoc)
- **parse-oas**: structural checks against the SCAPI Orders fixture (13 endpoints, 51 types)
- **parse-amf**: structural checks against the Einstein Recommendations fixture (7 endpoints, 19 types, enum resolution)
- **golden-diff**: 6 per-slug outputs (Summary + one endpoint + one type, for each parser)

Regenerate goldens by running each parser over its fixture and writing the result to `tests/expected/`. Fixtures were captured on 2026-04-27 from the live DSC site; refresh if the schemas change.

## Limitations

- **Catalog stale entries.** DSC's `refList` occasionally lists references whose static files 404 (e.g. `conversation-service-api` as of this writing). In `--all` mode, the loop records these as errors per-reference and continues.
- **RAML types that aren't in `doc:declares`.** If a RAML reference inlines a type rather than declaring it, the parser captures it in the property schema but not as a standalone `type:` slug. Observed in practice to be rare; easy to extend if needed.
- **No schema $ref resolution in OAS output.** Endpoints emit `schemaRef: "#/components/schemas/Order"` rather than inlining the resolved type. Consumers can look up the referenced type in `types/<Name>.json` -- keeping them separate avoids duplicating large schemas across every referring endpoint.

