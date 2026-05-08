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

function extractRequestBody(body, spec) {
  if (!body || !body.content) return null;
  const json = body.content['application/json'];
  if (!json) return null;
  const out = {};
  if (json.schema) {
    if (json.schema.$ref) out.schemaRef = json.schema.$ref;
    else out.schema = json.schema;
  }
  if (json.examples) {
    out.examples = {};
    for (const [name, ex] of Object.entries(json.examples)) {
      out.examples[name] = inlineExample(ex, spec);
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
