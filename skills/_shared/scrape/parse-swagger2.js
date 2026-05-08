'use strict';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function fallbackSlug(method, path) {
  const cleaned = path
    .replace(/[{}()]/g, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '-');
  return `${method}-${cleaned}`;
}

function normalizeRef(ref) {
  if (typeof ref !== 'string') return ref;
  if (ref.startsWith('#/definitions/')) {
    return `#/components/schemas/${ref.slice('#/definitions/'.length)}`;
  }
  return ref;
}

function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref') out[k] = normalizeRef(v);
      else out[k] = rewriteRefs(v);
    }
    return out;
  }
  return node;
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

function extractParameter(p) {
  const out = {
    name: p.name,
    in: p.in,
    required: p.required === true || p.in === 'path',
    description: (p.description || '').trim(),
  };
  const schemaFields = ['type', 'format', 'default', 'minimum', 'maximum', 'maxLength', 'enum', 'items', 'pattern'];
  const schema = {};
  for (const f of schemaFields) {
    if (p[f] !== undefined) schema[f] = p[f];
  }
  if (Object.keys(schema).length > 0) out.schema = rewriteRefs(schema);
  return out;
}

function extractRequestBody(bodyParam, spec, consumes) {
  if (!bodyParam) return null;
  const mediaTypes = (Array.isArray(consumes) && consumes.length ? consumes : ['application/json']);
  if (!mediaTypes.includes('application/json')) return null;
  const out = {};
  if (bodyParam.schema) {
    if (bodyParam.schema.$ref) out.schemaRef = normalizeRef(bodyParam.schema.$ref);
    else out.schema = rewriteRefs(bodyParam.schema);
  }
  if (bodyParam.required) out.required = true;
  return out;
}

function extractResponses(responses) {
  const out = [];
  for (const [code, resp] of Object.entries(responses || {})) {
    const entry = {
      code,
      description: (resp.description || '').trim(),
    };
    if (resp.schema) {
      if (resp.schema.$ref) entry.schemaRef = normalizeRef(resp.schema.$ref);
      else entry.schema = rewriteRefs(resp.schema);
    }
    out.push(entry);
  }
  return out;
}

function buildBaseUrl(spec) {
  const scheme = (spec.schemes && spec.schemes[0]) || 'https';
  const host = spec.host || '';
  const basePath = spec.basePath || '';
  if (!host && !basePath) return '';
  return `${scheme}://${host}${basePath}`;
}

function extractEndpoint(method, path, op, pathItem, spec) {
  const baseUrl = buildBaseUrl(spec);
  const fullUrl = baseUrl ? baseUrl.replace(/\/$/, '') + path : path;

  const rawParams = [...(pathItem.parameters || []), ...(op.parameters || [])];
  const inlined = rawParams.map((p) => inlineParam(p, spec));
  const bodyParam = inlined.find((p) => p && p.in === 'body');
  const nonBody = inlined.filter((p) => p && p.in !== 'body');

  const parameters = nonBody.map(extractParameter);
  const headers = parameters.filter((p) => p.in === 'header');
  const consumes = op.consumes || spec.consumes;
  const body = extractRequestBody(bodyParam, spec, consumes);
  const responses = extractResponses(op.responses);

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
    schema: rewriteRefs(schema),
  };
}

function extractSummary(spec) {
  return {
    title: spec.info?.title || null,
    version: spec.info?.version || null,
    description: (spec.info?.description || '').trim() || null,
    baseUrl: buildBaseUrl(spec) || null,
  };
}

function parseSwagger2(spec) {
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
      const slug = fallbackSlug(method, path);
      slugs.push({
        kind: 'endpoint',
        slug,
        endpoint: extractEndpoint(method, path, op, pathItem, spec),
      });
    }
  }

  for (const [name, schema] of Object.entries(spec.definitions || {})) {
    slugs.push({
      kind: 'type',
      slug: `type:${name}`,
      type: extractType(name, schema),
    });
  }

  return slugs;
}

module.exports = { parseSwagger2 };
