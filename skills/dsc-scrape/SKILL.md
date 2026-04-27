---
name: dsc-scrape
description: Scrape developer.salesforce.com (DSC) API reference pages and write structured JSON. Invoke whenever the user asks to scrape, extract, fetch, mirror, capture, or get the contents of any DSC reference URL (anything under `/docs/.../references/`) -- including "get me the Shopper Products endpoints", "pull the SCAPI reference", "what APIs are on this DSC page", or "scrape this whole API family." Handles OAS 3 (YAML), RAML (AMF JSON), and ReDoc references in one fetch-based architecture. Not for guides, concept pages, or release notes -- decline.
---

# DSC Doc Scraping

## Inputs

- `url` (required) -- a full DSC URL under `/docs/.../references/`.
- `out` (required) -- an absolute path to the output root directory.

If the user's request is vague about the URL ("pick one from Commerce Cloud", "scrape any endpoint from Data Cloud"), navigate to **`https://developer.salesforce.com/docs/apis#browse`** -- DSC's canonical API catalog. Each listed API has overview / guide / references links; follow the `/references/` link to land on a valid reference page.

Catalog product names drift from what a user might say. Salesforce has rebranded "Data Cloud" to **Data 360** in the catalog, for example, so searching for the exact string "Data Cloud" finds nothing; match on topic keywords rather than the literal name. A handful of products (notably Marketing Cloud Growth / Marketing Cloud Next) genuinely aren't in the catalog but do have `/references/` pages -- use the docs-site search or ask the user for a URL rather than guessing by pattern.

**Watch out for Summary-page redirects.** On reference roots, DSC auto-redirects bare `/references/<name>` URLs to `?meta=Summary` -- a valid slug, but it's the reference's *overview prose*, not an operation. If the user asked for "an endpoint" (or said something that implies one, like "a POST call" or "a specific operation"), scrape the reference root first; the output includes a per-reference `_index.json` with the full slug list, and you can pick a verb-shaped slug (names starting with `get`, `create`, `update`, `delete`, `search`, `list`, etc.) for the user's follow-on question.

## URL shapes

| URL shape | Behavior |
|---|---|
| `.../references/<name>?meta=<slug>` | Write 1 file for the requested slug |
| `.../references/<name>` or `?meta=Summary` | Write every slug in the reference (Summary + endpoints + types) |
| `.../references` (catalog root) | Requires `--all`. Walks the refList, scrapes every reference |
| `.../references/.../something.html` (non-slug landing) | Same as catalog root: walks the refList, scrapes everything |

## Flow

Single call:

```bash
node ~/.claude/skills/dsc-scrape/scripts/scrape.js "<url>" "<out>" [--all]
```

The script classifies the URL, fetches the reference page HTML to extract the `refList` (from `reference-set-config` or ReDoc's `reference-config`), fetches the static spec file (OAS 3 YAML for `rest-oa3`, AMF JSON sidecar for `rest-raml`), parses it, and writes one JSON file per slug. No browser, no external dependencies beyond `js-yaml` (already installed).

For successful runs, the script prints a JSON summary to stdout listing `count`, `format`, `specUrl`, and `files[]`. Relay the file count and (for reference-root scrapes) the path to `_index.json` back to the user.

## Output layout

```
<out>/
├── <reference>/
│   ├── _index.json              reference-wide metadata: title, source, full slug list, siblings
│   ├── Summary.json             reference overview
│   ├── <operationId>.json       one file per endpoint
│   └── types/
│       └── <TypeName>.json      one file per named type
└── _landing/
    └── <slug-of-html-path>.json only for catalog / non-slug landing URLs
```

Each per-slug JSON has a unified envelope -- `kind` (`endpoint`/`type`/`summary`), `reference`, `slug`, `url`, `scrapedAt`, `source.{format, specUrl}` -- followed by an `endpoint` / `type` / `summary` payload. OAS and AMF sources produce identical envelope shape; consumers don't branch on format.

## Scope

- **In scope**: DSC `/references/` pages that expose either `reference-set-config` (OAS 3 YAML or RAML) or a `<doc-redoc-reference>` element (ReDoc-rendered OAS 3). All three render via static specs the skill fetches directly.
- **Atlas books** (URLs contain `atlas.` and end in `.htm`, with no `/references/` segment). Decline -- different viewer. Example: the core Platform REST API guide is an atlas book.
- **MuleSoft docs** at `docs.mulesoft.com` are a separate platform. Decline.
- **Guides, concept pages, release notes**: Decline. This skill is for reference pages.

The script's classifier catches these and exits with a decline message. If the user hands you a clearly-out-of-scope URL, call the script anyway and relay its decline -- don't second-guess the classifier.

## Error handling

- Decline (classifier) -> exit 3 with a message. No file written. Relay the reason.
- Unreachable spec (catalog lists a reference but the static file is 404 -- e.g. `conversation-service-api` is a known stale catalog entry) -> exit 1 with the URL and status. In `--all` mode, the error is recorded per-reference and the loop continues.
- Malformed spec -> exit 1 with the parse error.

Never retry. Surface the error to the user.

## Key invariants

- One slug -> one file. The per-reference `_index.json` is the only file that carries the full slug list and sibling list. Don't duplicate that data into individual slug files.
- Type slugs (`type:<Name>`) write to `<reference>/types/<Name>.json`. Other slugs write to `<reference>/<slug>.json`. The `slug` field in the JSON keeps the `type:` prefix; the filesystem layout is purely a disk concern.
- `rest-oa3` and `rest-raml` dispatch to different parsers but produce identical-shape output. Consumers don't need to branch on `source.format`.

## See also

- `README.md` (in this skill dir) -- design, internals, test instructions.
