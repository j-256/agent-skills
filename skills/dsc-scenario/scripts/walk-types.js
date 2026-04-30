'use strict';

const fs = require('node:fs');
const path = require('node:path');

class ReferenceNotScrapedError extends Error {
  constructor(reference, cacheRoot) {
    super(`Reference '${reference}' not found in cache at ${cacheRoot}; run dsc-scrape first.`);
    this.name = 'ReferenceNotScrapedError';
    this.reference = reference;
    this.cacheRoot = cacheRoot;
  }
}

// The sub-agent prompt (used by Task 12; kept here as the static string).
const WALK_AGENT_PROMPT = `You are walking the OAS / AMF type graph for a single DSC reference.

Inputs: targetSlug, reference, cacheRoot.

Read <cacheRoot>/<reference>/_index.json to see what slugs exist.
Read <cacheRoot>/<reference>/<targetSlug>.json. Identify every required
input (path params, required query params, required body fields).
For each required input whose type is an ID or a reference to a named
type, search other endpoint files in the same reference for an
operation whose 200/201 response schema produces that type (or a field
of that name). Recurse on each producer's required inputs. Stop at
primitives, enums, or inputs that look like auth material (tokens,
client IDs).

Return JSON: {
  nodes: [{slug, method, path, producedTypes: [{name, ref}], requiredInputs: [{name, in, typeRef, typeName}]}],
  edges: [{from, to, viaField}]
}

Do not invent producers. If an input has no producer in the scraped
reference(s), include it in requiredInputs but emit no edge for it.`;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// AMF/RAML-scraped specs emit object schemas as
// `{ type: 'object', properties: [{name, required, range}, ...] }`,
// whereas OAS uses `{ type: 'object', required: [...], properties: {name: schema} }`.
// Normalize AMF to OAS so the walker handles both. Same helper as
// skills/dsc-triage/scripts/diff.js:40 – keep in sync until a third consumer
// appears, then hoist to _shared/.
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

function listEndpointSlugs(cacheRoot, reference) {
  let index;
  try {
    index = readJson(path.join(cacheRoot, reference, '_index.json'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new ReferenceNotScrapedError(reference, cacheRoot);
    }
    throw e;
  }
  return Object.keys(index.endpoints || {});
}

function loadEndpoint(cacheRoot, reference, slug) {
  const p = path.join(cacheRoot, reference, `${slug}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

// Extract the required inputs of an endpoint as [{name, in, typeRef, typeName}].
// `in` is 'path' | 'query' | 'body'. typeRef is the $ref string if present,
// typeName is the named type (last segment of $ref) for convenience.
function requiredInputs(endpointDoc) {
  const ep = endpointDoc.endpoint || {};
  const out = [];
  for (const p of ep.parameters || []) {
    if (!p.required) continue;
    out.push({ name: p.name, in: p.in, typeRef: null, typeName: p.type || null });
  }
  const schema = ep.body && ep.body.schema;
  const s = normalizeSchema(schema);
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
// Returns [{name, ref}] for each top-level response schema $ref.
function producedTypes(endpointDoc) {
  const ep = endpointDoc.endpoint || {};
  const out = [];
  for (const [code, resp] of Object.entries(ep.responses || {})) {
    if (!/^2\d\d$/.test(code)) continue;
    const schema = resp && resp.schema;
    if (!schema) continue;
    if (schema.$ref) {
      out.push({ ref: schema.$ref, name: schema.$ref.split('/').pop() });
    } else {
      const s = normalizeSchema(schema);
      if (s && s.type === 'object' && s.properties) {
        out.push({ ref: null, name: null, inlineProperties: Object.keys(s.properties) });
      }
    }
  }
  return out;
}

// Load a type file and return its {name, schema}, or null if absent.
function loadType(cacheRoot, reference, typeName) {
  const p = path.join(cacheRoot, reference, 'types', `${typeName}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

// For a given required-input {name, typeRef, typeName}, find producer operations
// in the reference whose response type, or inline response properties, produce it.
function findProducers(input, allEndpoints, cacheRoot, reference) {
  const producers = [];
  for (const ep of allEndpoints) {
    // Skip endpoints that require the same input we're trying to produce –
    // they can't produce what they already depend on (e.g. getItem requires
    // containerId, so its response doesn't count as a producer of containerId).
    const epInputs = requiredInputs(ep);
    if (epInputs.some((i) => i.name === input.name)) continue;

    const produced = producedTypes(ep);
    for (const p of produced) {
      // Case A: response is a $ref to a named type. Load the type file,
      // check whether its schema has a property matching the input name.
      if (p.ref) {
        const typeDoc = loadType(cacheRoot, reference, p.name);
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

function walkTypes({ targetSlug, reference, cacheRoot }) {
  const slugs = listEndpointSlugs(cacheRoot, reference);
  const allEndpoints = slugs
    .map((s) => loadEndpoint(cacheRoot, reference, s))
    .filter(Boolean);

  const nodes = new Map(); // slug -> node
  const edges = [];

  function visit(slug) {
    if (nodes.has(slug)) return;
    const doc = allEndpoints.find((e) => e.slug === slug);
    if (!doc) return;
    const ep = doc.endpoint || {};
    const inputs = requiredInputs(doc);
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

      const producers = findProducers(inp, allEndpoints, cacheRoot, reference);
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

module.exports = { walkTypes, WALK_AGENT_PROMPT, ReferenceNotScrapedError };
