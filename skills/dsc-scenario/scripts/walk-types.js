'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../lib/scrape/resolve-cache.js');

class ReferenceNotScrapedError extends Error {
  constructor(reference, cacheRoot) {
    super(`Reference '${reference}' not found in cache at ${cacheRoot}; run dsc-scrape first.`);
    this.name = 'ReferenceNotScrapedError';
    this.reference = reference;
    this.cacheRoot = cacheRoot;
  }
}

function refDirFor(cacheRoot, reference, area) {
  try {
    return resolveReferenceDir(cacheRoot, reference, area ? { area } : {}).dir;
  } catch (e) {
    if (e instanceof ReferenceNotCachedError || e instanceof AmbiguousReferenceError) {
      throw new ReferenceNotScrapedError(reference, cacheRoot);
    }
    throw e;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// AMF/RAML-scraped specs emit object schemas as
// `{ type: 'object', properties: [{name, required, range}, ...] }`,
// whereas OAS uses `{ type: 'object', required: [...], properties: {name: schema} }`.
// Normalize AMF to OAS so the walker handles both. Same helper as
// skills/dsc-endpoint-help/scripts/diff.js:40 – keep in sync until a third
// consumer appears, then hoist to _shared/.
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.type !== 'object' || !Array.isArray(schema.properties)) return schema;
  const required = [];
  const properties = {};
  for (const p of schema.properties) {
    if (!p || typeof p.name !== 'string') continue;
    properties[p.name] = p.range || {};
    if (p.required) required.push(p.name);
  }
  return { ...schema, required, properties };
}

function listEndpointSlugs(cacheRoot, reference, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  let index;
  try {
    index = readJson(path.join(refDir, '_index.json'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new ReferenceNotScrapedError(reference, cacheRoot);
    }
    throw e;
  }
  return Object.keys(index.endpoints || {});
}

function loadEndpoint(cacheRoot, reference, slug, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  const p = path.join(refDir, `${slug}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

// Extract the required inputs of an endpoint as [{name, in, typeRef, typeName}].
// `in` is 'path' | 'query' | 'body'. typeRef is the $ref string if present,
// typeName is the named type (last segment of $ref) for convenience.
//
// The body schema arrives in one of two real shapes:
//   - `body.schemaRef` ("#/components/schemas/Basket") for a named type
//     (OAS/Swagger2). We resolve it to the type file to read its required
//     fields, so a named-type body still yields body-field edges. Resolving
//     needs cacheRoot/reference/area; when unavailable (or the type file is
//     missing), the body's required fields are simply not enumerated rather
//     than throwing -- the walk degrades, it doesn't crash.
//   - inline `body.schema` (OAS inline object, or AMF's array-properties form,
//     which normalizeSchema folds to OAS shape).
function requiredInputs(endpointDoc, { cacheRoot, reference, area } = {}) {
  const ep = endpointDoc.endpoint || {};
  const out = [];
  for (const p of ep.parameters || []) {
    if (!p.required) continue;
    // Param type lives on p.schema.type in the real cache; p.type is the older
    // shape some fixtures used. typeRef set if the param schema is a $ref.
    const ref = (p.schema && p.schema.$ref) || null;
    const typeName = ref ? ref.split('/').pop() : ((p.schema && p.schema.type) || p.type || null);
    out.push({ name: p.name, in: p.in, typeRef: ref, typeName });
  }

  let bodySchema = ep.body && ep.body.schema;
  if (!bodySchema && ep.body && typeof ep.body.schemaRef === 'string' && reference && cacheRoot) {
    const typeName = ep.body.schemaRef.split('/').pop();
    const typeDoc = loadType(cacheRoot, reference, typeName, area);
    bodySchema = typeDoc && typeDoc.type && typeDoc.type.schema;
  }
  const s = normalizeSchema(bodySchema);
  if (s && s.type === 'object' && Array.isArray(s.required)) {
    const props = s.properties || {};
    for (const req of s.required) {
      const prop = props[req] || {};
      const ref = prop.$ref || null;
      out.push({
        name: req,
        in: 'body',
        typeRef: ref,
        typeName: ref ? ref.split('/').pop() : (prop.type || null),
      });
    }
  }
  return out;
}

// Extract the types produced in any 2xx response schema.
// Returns [{name, ref}] for each top-level response schema ref, or
// {ref:null, name:null, inlineProperties:[...]} for an inline object schema.
//
// `responses` is the array the scrapers emit (parse-oas/parse-swagger2/parse-amf
// all `.push()` entries): each entry is `{code, schemaRef?, schema?, payloads?}`.
// Three response sub-shapes occur across the parser families:
//   - OAS-3 / Swagger-2 named: `{code, schemaRef: "#/components/schemas/Basket"}`
//   - OAS-3 / Swagger-2 inline: `{code, schema: {...}}`
//   - AMF-RAML: `{code, payloads: [{mediaType, schema: {...}}]}` (schema inline,
//     array-properties form; AMF emits no named-type files)
function producedTypes(endpointDoc) {
  const ep = endpointDoc.endpoint || {};
  const out = [];
  for (const resp of ep.responses || []) {
    if (!resp || !/^2\d\d$/.test(String(resp.code))) continue;
    // Named type: a `$ref` string in schemaRef (OAS/Swagger2). The ref's last
    // segment is the type name, which loadType() reads from types/<name>.json.
    if (typeof resp.schemaRef === 'string') {
      out.push({ ref: resp.schemaRef, name: resp.schemaRef.split('/').pop() });
      continue;
    }
    // Inline schema: OAS/Swagger2 carry it on resp.schema; AMF nests it under
    // resp.payloads[].schema. Take the first JSON payload's schema for AMF.
    const inline = resp.schema || (Array.isArray(resp.payloads) && resp.payloads[0] && resp.payloads[0].schema);
    if (!inline) continue;
    const s = normalizeSchema(inline);
    if (s && s.type === 'object' && s.properties) {
      out.push({ ref: null, name: null, inlineProperties: Object.keys(s.properties) });
    }
  }
  return out;
}

// Load a type file and return its {name, schema}, or null if absent.
function loadType(cacheRoot, reference, typeName, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  const p = path.join(refDir, 'types', `${typeName}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

// For a given required-input {name, typeRef, typeName}, find producer operations
// in the reference whose response type, or inline response properties, produce it.
function findProducers(input, allEndpoints, cacheRoot, reference, area) {
  const producers = [];
  for (const ep of allEndpoints) {
    // Skip endpoints that require the same input we're trying to produce --
    // they can't produce what they already depend on (e.g. getItem requires
    // containerId, so its response doesn't count as a producer of containerId).
    const epInputs = requiredInputs(ep, { cacheRoot, reference, area });
    if (epInputs.some((i) => i.name === input.name)) continue;

    const produced = producedTypes(ep);
    for (const p of produced) {
      // Case A: response is a $ref to a named type. Load the type file,
      // check whether its schema has a property matching the input name.
      if (p.ref) {
        const typeDoc = loadType(cacheRoot, reference, p.name, area);
        if (!typeDoc) continue;
        const typeSchema = normalizeSchema(typeDoc.type && typeDoc.type.schema);
        const props = (typeSchema && typeSchema.properties) || {};
        if (input.name in props) {
          producers.push({ slug: ep.slug, viaField: input.name });
        }
      }
      // Case B: response has inline properties. Check directly.
      if (Array.isArray(p.inlineProperties) && p.inlineProperties.includes(input.name)) {
        producers.push({ slug: ep.slug, viaField: input.name });
      }
    }
  }
  return producers;
}

function walkTypes({ targetSlug, reference, cacheRoot, area }) {
  const slugs = listEndpointSlugs(cacheRoot, reference, area);
  const allEndpoints = slugs
    .map((s) => loadEndpoint(cacheRoot, reference, s, area))
    .filter(Boolean);

  const nodes = new Map(); // slug -> node
  const edges = [];

  function visit(slug) {
    if (nodes.has(slug)) return;
    const doc = allEndpoints.find((e) => e.slug === slug);
    if (!doc) return;
    const ep = doc.endpoint || {};
    const inputs = requiredInputs(doc, { cacheRoot, reference, area });
    const produced = producedTypes(doc);
    nodes.set(slug, {
      slug,
      method: ep.method,
      path: ep.path,
      producedTypes: produced.map(({ name, ref }) => ({ name, ref })),
      requiredInputs: inputs,
    });
    for (const inp of inputs) {
      // Match the prompt's "whose type is an ID or a reference to a named type"
      // filter – otherwise a shared named type (e.g. both getItem and addItem return
      // Item) would make every endpoint a "producer" of every property on that type.
      const isId = /Id$/i.test(inp.name);
      const isNamedTypeRef = inp.typeRef !== null;
      if (!isId && !isNamedTypeRef) continue;

      const producers = findProducers(inp, allEndpoints, cacheRoot, reference, area);
      for (const p of producers) {
        if (p.slug === slug) continue; // no self-edges
        edges.push({ from: p.slug, to: slug, viaField: p.viaField });
        visit(p.slug);
      }
    }
  }

  visit(targetSlug);
  return {
    nodes: [...nodes.values()],
    edges,
  };
}

// NOTE: walk-via-agent.md restates the same algorithm as walkTypes() above.
// If you change the walkTypes algorithm here, update walk-via-agent.md to
// match – both are the contract for sub-agent vs. local execution.
function walkViaAgentPrompt({ targetSlug, reference, cacheRoot }) {
  if (typeof targetSlug !== 'string' || !targetSlug) {
    throw new Error('walkViaAgentPrompt: targetSlug is required');
  }
  if (typeof reference !== 'string' || !reference) {
    throw new Error('walkViaAgentPrompt: reference is required');
  }
  if (typeof cacheRoot !== 'string' || !cacheRoot) {
    throw new Error('walkViaAgentPrompt: cacheRoot is required');
  }
  const promptPath = path.join(__dirname, 'walk-via-agent.md');
  const template = fs.readFileSync(promptPath, 'utf8');
  return template
    .replace(/\{\{TARGET_SLUG\}\}/g, targetSlug)
    .replace(/\{\{REFERENCE\}\}/g, reference)
    .replace(/\{\{CACHE_ROOT\}\}/g, cacheRoot);
}

module.exports = { walkTypes, walkViaAgentPrompt, ReferenceNotScrapedError };
