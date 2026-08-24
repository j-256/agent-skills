'use strict';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function fallbackSlug(method, path) {
  const cleaned = path
    .replace(/[{}]/g, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '-');
  return `${method}-${cleaned}`;
}

function resolveRef(ref, spec) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (const p of parts) {
    if (node == null) return null;
    node = node[p];
  }
  return node ?? null;
}

function inlineParam(param, spec) {
  if (param && param.$ref) {
    const resolved = resolveRef(param.$ref, spec);
    if (resolved) return resolved;
  }
  return param;
}

function inlineExample(example, spec) {
  if (example && example.$ref) {
    const resolved = resolveRef(example.$ref, spec);
    if (resolved && typeof resolved === 'object' && 'value' in resolved) return resolved.value;
    return resolved;
  }
  if (example && typeof example === 'object' && 'value' in example) return example.value;
  return example;
}

function extractParameter(p) {
  const out = {
    name: p.name,
    in: p.in,
    required: p.required === true || p.in === 'path',
    description: (p.description || '').trim(),
  };
  if (p.schema && typeof p.schema === 'object') {
    const s = p.schema;
    out.schema = {
      type: s.type,
      format: s.format,
      default: s.default,
      minimum: s.minimum,
      maximum: s.maximum,
      maxLength: s.maxLength,
      enum: s.enum,
    };
    if (s.$ref) out.schema.$ref = s.$ref;
    for (const k of Object.keys(out.schema)) {
      if (out.schema[k] === undefined) delete out.schema[k];
    }
  }
  return out;
}

// Request bodies are keyed by content type. Prefer application/json (the richest,
// and the only one diff.js JSON-validates), then the form encodings, then any other
// declared type -- so a form-urlencoded token body (e.g. SLAS getAccessToken)
// surfaces its field schema instead of arriving as a bare {contentTypes, required}.
// A media whose schema is present is chosen ahead of an examples-only media so the
// structural schema always wins; declaration order breaks ties among equal priority.
const BODY_MEDIA_PRIORITY = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
];

function pickBodyMedia(content) {
  const rank = (ct) => {
    const i = BODY_MEDIA_PRIORITY.indexOf(ct);
    return i === -1 ? BODY_MEDIA_PRIORITY.length : i;
  };
  const byRank = (a, b) => rank(a) - rank(b);
  const keys = Object.keys(content);
  const withSchema = keys.filter((ct) => content[ct] && content[ct].schema).sort(byRank);
  if (withSchema.length) return content[withSchema[0]];
  const withExamples = keys.filter((ct) => content[ct] && content[ct].examples).sort(byRank);
  if (withExamples.length) return content[withExamples[0]];
  return null;
}

function extractRequestBody(body, spec) {
  if (!body || !body.content) return null;
  const contentTypes = Object.keys(body.content);
  if (contentTypes.length === 0) return null;
  // contentTypes always lists every declared type so diff.js can still flag a
  // wrong-content-type request; the schema comes from the highest-priority media.
  const out = { contentTypes };
  const media = pickBodyMedia(body.content);
  if (media) {
    if (media.schema) {
      if (media.schema.$ref) out.schemaRef = media.schema.$ref;
      else out.schema = media.schema;
    }
    if (media.examples) {
      out.examples = {};
      for (const [name, ex] of Object.entries(media.examples)) {
        out.examples[name] = inlineExample(ex, spec);
      }
    }
  }
  if (body.required) out.required = true;
  return out;
}

function extractResponses(responses, spec) {
  const out = [];
  for (const [code, resp] of Object.entries(responses || {})) {
    const entry = {
      code,
      description: (resp.description || '').trim(),
    };
    const json = resp.content && resp.content['application/json'];
    if (json) {
      if (json.schema) {
        if (json.schema.$ref) entry.schemaRef = json.schema.$ref;
        else entry.schema = json.schema;
      }
      if (json.examples) {
        entry.examples = {};
        for (const [name, ex] of Object.entries(json.examples)) {
          entry.examples[name] = inlineExample(ex, spec);
        }
      }
    }
    out.push(entry);
  }
  return out;
}

function extractEndpoint(method, path, op, pathItem, spec) {
  const baseUrl = (spec.servers && spec.servers[0] && spec.servers[0].url) || '';
  const fullUrl = baseUrl ? baseUrl.replace(/\/$/, '') + path : path;

  const rawParams = [...(pathItem.parameters || []), ...(op.parameters || [])];
  const parameters = rawParams.map((p) => extractParameter(inlineParam(p, spec)));
  const headers = parameters.filter((p) => p.in === 'header');
  const body = extractRequestBody(op.requestBody, spec);
  const responses = extractResponses(op.responses, spec);

  const security = [];
  for (const sec of (op.security || spec.security || [])) {
    if (sec && typeof sec === 'object') {
      for (const [scheme, scopes] of Object.entries(sec)) {
        security.push({ scheme, scopes: Array.isArray(scopes) ? scopes : [] });
      }
    }
  }

  return {
    method: method.toUpperCase(),
    path,
    url: fullUrl,
    operationId: op.operationId || null,
    summary: (op.summary || '').trim() || null,
    description: (op.description || '').trim() || null,
    parameters,
    headers,
    body,
    responses,
    security,
  };
}

function extractType(name, schema) {
  return {
    name,
    schema,
  };
}

function extractSummary(spec) {
  const base = spec.servers && spec.servers[0] && spec.servers[0].url;
  return {
    title: spec.info?.title || null,
    version: spec.info?.version || null,
    description: (spec.info?.description || '').trim() || null,
    baseUrl: base || null,
  };
}

function parseOas(spec) {
  const slugs = [];

  slugs.push({
    kind: 'summary',
    slug: 'Summary',
    summary: extractSummary(spec),
  });

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const slug = op.operationId || fallbackSlug(method, path);
      slugs.push({
        kind: 'endpoint',
        slug,
        endpoint: extractEndpoint(method, path, op, pathItem, spec),
      });
    }
  }

  for (const [name, schema] of Object.entries(spec.components?.schemas || {})) {
    slugs.push({
      kind: 'type',
      slug: `type:${name}`,
      type: extractType(name, schema),
    });
  }

  return slugs;
}

module.exports = { parseOas };
