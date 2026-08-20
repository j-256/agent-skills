You are walking the OAS / AMF type graph for a single DSC reference to find producer → consumer relationships between API operations.

**Inputs for this call:**
- targetSlug: {{TARGET_SLUG}}
- reference:  {{REFERENCE}}
- cacheRoot:  {{CACHE_ROOT}}

**Files you may read, all under `{{CACHE_ROOT}}/{{REFERENCE}}/`:**
- `_index.json` – lists every slug in the reference, plus the `endpoints` map (`{slug: {method, path}}`).
- `<slug>.json` – one file per endpoint slug.
- `types/<TypeName>.json` – one file per named type.

**What to do:**
1. Read `_index.json` to see the universe of slugs.
2. Read `<targetSlug>.json`. Identify every required input:
   - Path parameters (all path params are required by convention). A parameter's type is under `parameter.schema` (e.g. `parameter.schema.type`, or `parameter.schema.$ref` for a named type).
   - Required query parameters.
   - Required body fields. The body schema arrives in one of two shapes:
     - **Named-type body:** `endpoint.body.schemaRef` is a `$ref` string (e.g. `"#/components/schemas/Basket"`). Load `types/<TypeName>.json` (the last `/`-segment of the ref) and read its `type.schema.required` + `type.schema.properties`.
     - **Inline body:** `endpoint.body.schema` is an inline object – read its `required` + `properties` directly. (AMF bodies are inline with `properties` as an array of `{name, required, range}`; treat a property as required when `required` is true.)
3. For each required input, find producers in the same reference:
   - If the input's schema is a `$ref` to a named type, load that type file and note every property of that type.
   - Read each operation's `responses` (an **array** of `{code, ...}` entries – not an object keyed by status code). For every entry whose `code` is a 2xx, the produced type is:
     - `entry.schemaRef` – a `$ref` to a named type (OAS / Swagger 2). Load the type file for its properties.
     - `entry.schema` – an inline object schema (OAS / Swagger 2 inline).
     - `entry.payloads[].schema` – an inline object schema (AMF / RAML; AMF emits no named-type files, so its response types are always inline here).
   - If the input's name matches a property of any operation's 2xx produced type (named or inline), that operation is a producer.
4. Recurse on each producer's required inputs.
5. Stop at primitives (string IDs that have no named-type producer), enums, or inputs that look like auth material (`access_token`, `client_id`, anything obtained from a separate auth flow).
6. If an input has NO producer in the scraped reference(s), include it in `requiredInputs` but emit NO edge for it. **Never invent a producer.**
7. If a single input has MORE THAN ONE producer in the same reference, those producers are *alternatives*, not an AND-chain (e.g. `basketId` is produced from nothing by `createBasket`, `transferBasket`, and `mergeBasket`). Do not emit an edge from each. List them in `bridgeCandidates: [{slug, reference, viaField}, ...]` and emit no producer edge for that input; the outer layer has the model pick the canonical create and re-invoke. Emit a normal single edge only when exactly one producer exists.

**Cross-reference inputs:** if a required input isn't produced by any operation in *this reference's type graph* (e.g. any SCAPI endpoint requires `access_token`, which is produced by the SLAS reference `auth`, not by `shopper-baskets` itself), note it under `externalInputs: [...]` so the outer composition layer can integrate the source reference's calls. Do NOT try to scrape the other reference yourself; that's the outer layer's job. Always include the `reference` field naming the source DSC reference's URL slug (e.g. `"auth"` for SLAS – on DSC the SLAS reference is published at `/docs/commerce/commerce-api/references/auth`; "Shopper Login (SLAS)" is the page title, `auth` is the URL slug). The boundary here is between the per-reference walker and the multi-reference composition layer, not between the skill and the user – the user-facing answer integrates these as numbered plan steps. For auth tokens specifically (`access_token`, shopper / customer JWT), include `"auth": true` so the composition layer always expands the auth steps inline rather than surfacing them as an optional "say the word" affordance – auth is mandatory for every SCAPI / OCAPI call.

**Output:** return JSON only, no prose. Shape:
```
{
  "nodes": [
    {
      "slug": "...",
      "method": "GET|POST|...",
      "path": "/templated/{param}/path",
      "producedTypes": [{ "name": "Container", "ref": "#/types/Container" }],
      "requiredInputs": [
        { "name": "containerId", "in": "path|query|body", "typeRef": "#/types/X or null", "typeName": "X or primitive type" }
      ]
    }
  ],
  "edges": [
    { "from": "createContainer", "to": "addItem", "viaField": "containerId" }
  ],
  "externalInputs": [
    { "name": "access_token", "likelyOrigin": "SLAS", "reference": "auth", "auth": true }
  ]
}
```

No backticks, no markdown, no explanation – only the JSON object.
