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
   - Path parameters (all path params are required by convention).
   - Required query parameters.
   - Required body fields (from `endpoint.body.schema.required` paired with `endpoint.body.schema.properties`).
3. For each required input, find producers in the same reference:
   - If the input's schema is a `$ref` to a named type, load that type file and note every property of that type.
   - If the input's name matches a property in another operation's 2xx response schema (either inline or via a `$ref` to a named type), that operation is a producer.
4. Recurse on each producer's required inputs.
5. Stop at primitives (string IDs that have no named-type producer), enums, or inputs that look like auth material (`access_token`, `client_id`, anything obtained from a separate auth flow).
6. If an input has NO producer in the scraped reference(s), include it in `requiredInputs` but emit NO edge for it. **Never invent a producer.**

**Cross-reference walk:** if the reference is clearly dependent on another (e.g. any SCAPI endpoint depends on SLAS for the shopper token), note that in the response under `externalInputs: [...]` – do NOT try to scrape the other reference yourself.

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
    { "name": "access_token", "likelyOrigin": "SLAS", "reference": "shopper-login" }
  ]
}
```

No backticks, no markdown, no explanation – only the JSON object.
