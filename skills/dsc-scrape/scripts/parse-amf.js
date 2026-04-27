'use strict';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const AML_SHAPES = 'http://a.ml/vocabularies/shapes#';

const DATATYPE_TO_FRIENDLY = {
  [XSD + 'string']: 'string',
  [XSD + 'integer']: 'integer',
  [XSD + 'long']: 'long',
  [XSD + 'int']: 'integer',
  [XSD + 'double']: 'double',
  [XSD + 'float']: 'float',
  [XSD + 'boolean']: 'boolean',
  [XSD + 'dateTime']: 'datetime',
  [XSD + 'date']: 'date',
  [XSD + 'time']: 'time',
  [XSD + 'nil']: 'nil',
  [AML_SHAPES + 'number']: 'number',
  [AML_SHAPES + 'dateTimeOnly']: 'datetime-only',
};

function unv(v) {
  if (Array.isArray(v)) return v.length ? unv(v[0]) : undefined;
  if (v && typeof v === 'object') {
    if ('@value' in v) return v['@value'];
    if ('@id' in v && Object.keys(v).length === 1) return { $ref: v['@id'] };
  }
  return v;
}

function unvAll(v) {
  if (!Array.isArray(v)) v = [v];
  return v.map((x) => {
    if (x && typeof x === 'object') {
      if ('@value' in x) return x['@value'];
      if ('@id' in x && Object.keys(x).length === 1) return x['@id'];
    }
    return x;
  });
}

function hasType(node, t) {
  return Array.isArray(node?.['@type']) && node['@type'].includes(t);
}

function buildIndex(root) {
  const index = new Map();
  function walk(x) {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === 'object') {
      if (typeof x['@id'] === 'string') {
        const realKeys = Object.keys(x).filter((k) => k !== '@id');
        if (realKeys.length > 0) {
          if (!index.has(x['@id'])) index.set(x['@id'], x);
        }
      }
      for (const v of Object.values(x)) walk(v);
    }
  }
  walk(root);
  return index;
}

function deref(node, index) {
  if (!node || typeof node !== 'object') return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === '@id' && index.has(node['@id'])) {
    return index.get(node['@id']);
  }
  return node;
}

function friendlyDatatype(iri) {
  return DATATYPE_TO_FRIENDLY[iri] || iri;
}

function extractShape(raw, index, seen = new Set()) {
  if (!raw) return null;
  const node = deref(raw, index);
  const id = node['@id'];
  if (id && seen.has(id)) return { $ref: id, circular: true };
  if (id) seen.add(id);

  const base = {};
  const name = unv(node['shacl:name']);
  if (name) base.name = name;
  const description = unv(node['core:description']);
  if (description) base.description = description;
  const defaultVal = unv(node['shacl:defaultValue']) ?? unv(node['raml-shapes:default']);
  if (defaultVal !== undefined) base.default = defaultVal;
  const examples = node['apiContract:examples'];
  if (Array.isArray(examples) && examples.length) {
    base.examples = examples.map((ex) => extractExample(ex, index));
  }

  if (hasType(node, 'raml-shapes:ScalarShape')) {
    const dt = unv(node['shacl:datatype']);
    const out = { type: friendlyDatatype(dt?.$ref || dt), ...base };
    const enumVals = node['shacl:in'];
    if (enumVals) out.enum = extractEnum(enumVals, index);
    const min = unv(node['shacl:minInclusive']);
    if (min !== undefined) out.minimum = min;
    const max = unv(node['shacl:maxInclusive']);
    if (max !== undefined) out.maximum = max;
    const minLen = unv(node['shacl:minLength']);
    if (minLen !== undefined) out.minLength = minLen;
    const maxLen = unv(node['shacl:maxLength']);
    if (maxLen !== undefined) out.maxLength = maxLen;
    const pattern = unv(node['shacl:pattern']);
    if (pattern !== undefined) out.pattern = pattern;
    const format = unv(node['raml-shapes:format']);
    if (format !== undefined) out.format = format;
    return out;
  }

  if (hasType(node, 'raml-shapes:ArrayShape')) {
    const items = unv(node['raml-shapes:items']);
    return {
      type: 'array',
      ...base,
      items: items ? extractShape(items.$ref ? { '@id': items.$ref } : items, index, seen) : null,
    };
  }

  if (hasType(node, 'raml-shapes:UnionShape')) {
    const anyOf = node['raml-shapes:anyOf'] || [];
    return {
      type: 'union',
      ...base,
      anyOf: anyOf.map((s) => extractShape(s, index, seen)),
    };
  }

  if (hasType(node, 'raml-shapes:FileShape')) {
    return { type: 'file', ...base };
  }

  if (hasType(node, 'shacl:NodeShape')) {
    const propsRaw = node['shacl:property'] || [];
    const properties = propsRaw.map((p) => extractProperty(p, index, seen));
    const out = { type: 'object', ...base, properties };
    if (unv(node['shacl:closed']) === true) out.closed = true;
    return out;
  }

  return { type: 'unknown', ...base, rawTypes: node['@type'] };
}

function extractProperty(raw, index, seen) {
  const p = deref(raw, index);
  const name = unv(p['shacl:name']);
  const range = unv(p['raml-shapes:range']);
  const minCount = unv(p['shacl:minCount']) ?? 0;
  const out = {
    name,
    required: minCount > 0,
  };
  if (range) {
    out.range = extractShape(range.$ref ? { '@id': range.$ref } : range, index, seen);
  }
  return out;
}

function extractEnum(raw, index) {
  const outer = Array.isArray(raw) ? raw[0] : raw;
  const seq = deref(outer, index);
  if (!seq || typeof seq !== 'object') return [];
  const items = [];
  const seqKeys = Object.keys(seq)
    .filter((k) => /^rdfs:_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  for (const k of seqKeys) {
    const node = deref(Array.isArray(seq[k]) ? seq[k][0] : seq[k], index);
    if (node && hasType(node, 'data:Scalar')) items.push(unv(node['data:value']));
    else items.push(unv(node) ?? node);
  }
  return items;
}

function extractExample(raw, index) {
  const ex = deref(raw, index);
  const out = {};
  const name = unv(ex['core:name']);
  if (name) out.name = name;
  const value = unv(ex['apiContract:structuredValue']) ?? unv(ex['doc:raw']);
  if (value !== undefined) out.value = typeof value === 'string' ? tryParseJson(value) : value;
  const mediaType = unv(ex['core:mediaType']);
  if (mediaType) out.mediaType = mediaType;
  return out;
}

function tryParseJson(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try { return JSON.parse(t); } catch { return s; }
}

function extractParameter(raw, index) {
  const p = deref(raw, index);
  const schema = unv(p['raml-shapes:schema']);
  const out = {
    name: unv(p['apiContract:paramName']) || unv(p['core:name']),
    in: unv(p['apiContract:binding']) || 'query',
    required: unv(p['apiContract:required']) === true,
  };
  const description = unv(p['core:description']);
  if (description) out.description = description;
  out.schema = schema ? extractShape(schema.$ref ? { '@id': schema.$ref } : schema, index) : null;
  return out;
}

function extractRequest(raw, index) {
  const req = deref(raw, index);
  const headers = (req['apiContract:header'] || []).map((h) => extractParameter(h, index));
  const payloads = (req['apiContract:payload'] || []).map((p) => extractPayload(p, index));
  const params = (req['apiContract:parameter'] || []).map((p) => extractParameter(p, index));
  return { headers, queryParameters: params, payloads };
}

function extractPayload(raw, index) {
  const p = deref(raw, index);
  const mediaType = unv(p['core:mediaType']);
  const schema = unv(p['raml-shapes:schema']);
  return {
    mediaType: mediaType || 'application/json',
    schema: schema ? extractShape(schema.$ref ? { '@id': schema.$ref } : schema, index) : null,
  };
}

function extractResponse(raw, index) {
  const r = deref(raw, index);
  const statusCode = unv(r['apiContract:statusCode']);
  const headers = (r['apiContract:header'] || []).map((h) => extractParameter(h, index));
  const payloads = (r['apiContract:payload'] || []).map((p) => extractPayload(p, index));
  const out = { code: statusCode };
  const description = unv(r['core:description']);
  if (description) out.description = description;
  out.headers = headers;
  out.payloads = payloads;
  return out;
}

function extractOperation(raw, endpointPath, endpointParams, index, baseUrl) {
  const op = deref(raw, index);
  const method = unv(op['apiContract:method']);
  const requests = (op['apiContract:expects'] || []).map((r) => extractRequest(r, index));
  const responses = (op['apiContract:returns'] || []).map((r) => extractResponse(r, index));
  const request = requests[0] || { headers: [], queryParameters: [], payloads: [] };
  const url = baseUrl ? baseUrl.replace(/\/$/, '') + endpointPath : endpointPath;
  const out = {
    method: (method || '').toUpperCase(),
    path: endpointPath,
    url,
    operationId: unv(op['core:name']),
    summary: unv(op['core:name']),
  };
  const description = unv(op['core:description']);
  if (description) out.description = description;
  out.parameters = [...endpointParams, ...request.queryParameters];
  out.headers = request.headers;
  out.body = request.payloads[0] || null;
  out.responses = responses;
  return out;
}

function parseAmf(amfRoot) {
  const unit = Array.isArray(amfRoot) ? amfRoot[0] : amfRoot;
  const index = buildIndex(unit);
  const api = unit['doc:encodes'] && unit['doc:encodes'][0];
  if (!api) throw new Error('AMF: no doc:encodes root');

  const name = unv(api['core:name']);
  const version = unv(api['core:version']);
  const description = unv(api['core:description']);
  const server = unv(api['apiContract:server']);
  const serverObj = server && server.$ref ? index.get(server.$ref) : server;
  const baseUrl = serverObj ? unv(serverObj['core:urlTemplate']) : null;

  const slugs = [];
  slugs.push({
    kind: 'summary',
    slug: 'Summary',
    summary: {
      title: name || null,
      version: version || null,
      description: description || null,
      baseUrl: baseUrl || null,
    },
  });

  for (const epRaw of api['apiContract:endpoint'] || []) {
    const ep = deref(epRaw, index);
    const path = unv(ep['apiContract:path']);
    const epParams = (ep['apiContract:parameter'] || []).map((p) => extractParameter(p, index));
    const ops = ep['apiContract:supportedOperation'] || [];
    for (const opRaw of ops) {
      const endpoint = extractOperation(opRaw, path, epParams, index, baseUrl);
      const slug = endpoint.operationId || `${endpoint.method.toLowerCase()}_${path}`;
      slugs.push({ kind: 'endpoint', slug, endpoint });
    }
  }

  for (const declRaw of unit['doc:declares'] || []) {
    const decl = deref(declRaw, index);
    if (hasType(decl, 'shacl:NodeShape') || hasType(decl, 'raml-shapes:ScalarShape') || hasType(decl, 'raml-shapes:ArrayShape') || hasType(decl, 'raml-shapes:UnionShape')) {
      const typeName = unv(decl['shacl:name']);
      if (!typeName) continue;
      slugs.push({
        kind: 'type',
        slug: `type:${typeName}`,
        type: { name: typeName, schema: extractShape(decl, index) },
      });
    }
  }

  return slugs;
}

module.exports = { parseAmf };
