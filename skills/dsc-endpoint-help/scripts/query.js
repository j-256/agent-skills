#!/usr/bin/env node
// Query a dsc-scrape cache: resolve a slug (exact or fuzzy), extract the
// fields relevant to the question, and print a compact JSON digest.
//
// Usage:
//   node query.js <cache> <reference> <slug> [--field <name>] [--include-examples] [--resolve-refs]
//
// Fields: security | parameters | body | responses | summary | all | raw
//   - "all" (default): endpoint digest (method/path/operationId/summary + all sections, examples stripped).
//   - "raw": the full endpoint JSON unchanged.
//   - Named fields return only that section (plus method/path/operationId so the answer is self-locating).
//
// Exit codes:
//   0 = found, digest on stdout
//   2 = reference not cached (need to scrape)
//   3 = slug unresolvable (no exact match, no single fuzzy match, or missing)
//   4 = type slug requested but type file missing
//   1 = unexpected error

const fs = require('fs');
const path = require('path');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../lib/scrape/resolve-cache.js');

function die(code, obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { field: 'all', includeExamples: false, resolveRefs: false, area: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--field') opts.field = argv[++i];
    else if (a === '--area') opts.area = argv[++i];
    else if (a === '--include-examples') opts.includeExamples = true;
    else if (a === '--resolve-refs') opts.resolveRefs = true;
    else if (a.startsWith('--')) die(1, { error: `unknown flag: ${a}` });
    else positional.push(a);
  }
  if (positional.length < 3) {
    die(1, { error: 'usage: query.js <cache> <reference> <slug> [--area AREA] [--field NAME] [--include-examples] [--resolve-refs]' });
  }
  return { cache: positional[0], reference: positional[1], slug: positional[2], ...opts };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(1, { error: `failed to read ${p}`, detail: e.message }); }
}

function slugToFile(refDir, slug) {
  if (slug.startsWith('type:')) {
    const name = slug.slice('type:'.length);
    return path.join(refDir, 'types', `${name}.json`);
  }
  return path.join(refDir, `${slug}.json`);
}

function resolveSlug(refDir, reference, query) {
  if (!fs.existsSync(refDir)) {
    return { ok: false, reason: 'reference-not-cached', reference };
  }
  // Exact match first.
  const exactFile = slugToFile(refDir, query);
  if (fs.existsSync(exactFile)) {
    return { ok: true, slug: query, file: exactFile, matchedFrom: 'exact' };
  }
  // Fuzzy against _index.json.
  const indexPath = path.join(refDir, '_index.json');
  if (!fs.existsSync(indexPath)) {
    return { ok: false, reason: 'slug-not-found-no-index', reference, query };
  }
  const index = readJson(indexPath);
  const all = Array.isArray(index.slugs) ? index.slugs : [];
  const q = query.toLowerCase();
  const contains = all.filter(s => s.toLowerCase().includes(q));
  // Prefer candidates that START with the query (e.g. "get" -> "getProducts", not "getCustomerBaskets").
  const startsWith = contains.filter(s => s.toLowerCase().startsWith(q));
  const pool = startsWith.length ? startsWith : contains;
  if (pool.length === 1) {
    const slug = pool[0];
    return { ok: true, slug, file: slugToFile(refDir, slug), matchedFrom: 'fuzzy' };
  }
  return {
    ok: false,
    reason: pool.length === 0 ? 'slug-not-found' : 'slug-ambiguous',
    reference,
    query,
    candidates: pool.slice(0, 20),
  };
}

function stripExamples(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripExamples);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'examples') continue;
    out[k] = stripExamples(v);
  }
  return out;
}

function resolveSchemaRef(refDir, schemaRef) {
  // OAS refs look like "#/components/schemas/Product"; AMF uses the same pattern for types.
  const m = typeof schemaRef === 'string' && schemaRef.match(/^#\/components\/schemas\/(.+)$/);
  if (!m) return null;
  const typeFile = path.join(refDir, 'types', `${m[1]}.json`);
  if (!fs.existsSync(typeFile)) return { error: 'type-file-missing', typeFile };
  const typeDoc = readJson(typeFile);
  return typeDoc?.type || typeDoc;
}

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// Recursively inline nested `#/components/schemas/<Name>` refs found anywhere in a
// resolved type, reading each from types/<Name>.json. A `seen` set breaks cycles
// (A -> B -> A) and a depth cap bounds pathological nesting; an unresolvable or
// already-seen ref is left intact. Sibling keys on a $ref node (e.g. a local
// `description`) survive and win over the inlined target.
const MAX_REF_DEPTH = 8;

function inlineNestedRefs(node, refDir, seen, depth) {
  if (node == null || typeof node !== 'object' || depth > MAX_REF_DEPTH) return node;
  if (Array.isArray(node)) return node.map((n) => inlineNestedRefs(n, refDir, seen, depth + 1));
  if (typeof node.$ref === 'string') {
    const m = node.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (m && !seen.has(m[1])) {
      const typeFile = path.join(refDir, 'types', `${m[1]}.json`);
      const typeDoc = fs.existsSync(typeFile) ? safeReadJson(typeFile) : null;
      const target = typeDoc?.type?.schema !== undefined
        ? typeDoc.type.schema
        : (typeDoc?.schema !== undefined ? typeDoc.schema : typeDoc);
      if (target != null) {
        const nextSeen = new Set(seen).add(m[1]);
        const resolved = inlineNestedRefs(target, refDir, nextSeen, depth + 1);
        const { $ref, ...siblings } = node;
        const inlinedSiblings = inlineNestedRefs(siblings, refDir, seen, depth + 1);
        return (resolved && typeof resolved === 'object' && !Array.isArray(resolved))
          ? { ...resolved, ...inlinedSiblings }
          : resolved;
      }
    }
    return node; // unresolvable, cyclic, or non-schema ref: leave intact
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = inlineNestedRefs(v, refDir, seen, depth + 1);
  return out;
}

// resolveSchemaRef resolves only the top-level ref; a $ref nested inside the type
// (e.g. TokenRequest.grant_type -> GrantType) stays dangling, which forced a second
// hand-read of the nested type file. resolveSchemaRefDeep resolves the whole tree so
// --resolve-refs surfaces nested enums/objects in one lookup. Kept separate from
// resolveSchemaRef so triage.js's shallow body-schema resolution is unchanged.
function resolveSchemaRefDeep(refDir, schemaRef) {
  const shallow = resolveSchemaRef(refDir, schemaRef);
  if (!shallow || typeof shallow !== 'object' || shallow.error) return shallow;
  const m = typeof schemaRef === 'string' && schemaRef.match(/^#\/components\/schemas\/(.+)$/);
  const seen = new Set(m ? [m[1]] : []);
  return inlineNestedRefs(shallow, refDir, seen, 0);
}

function digest(doc, field, opts, refDir) {
  if (field === 'raw') return doc;

  if (doc.kind === 'type') {
    const t = opts.includeExamples ? doc.type : stripExamples(doc.type);
    return { kind: 'type', name: doc.type?.name ?? doc.slug, type: t };
  }
  if (doc.kind === 'summary') {
    return { kind: 'summary', reference: doc.reference, summary: doc.summary };
  }

  const ep = doc.endpoint || {};
  const header = {
    method: ep.method,
    path: ep.path,
    operationId: ep.operationId,
    summary: ep.summary,
  };

  const section = (name) => {
    switch (name) {
      case 'security': return { security: ep.security || [] };
      case 'parameters': return { parameters: ep.parameters || [], headers: ep.headers || [] };
      case 'body': {
        const body = opts.includeExamples ? ep.body : (ep.body ? stripExamples(ep.body) : null);
        const out = { body };
        if (opts.resolveRefs && body?.schemaRef) {
          out.bodySchema = resolveSchemaRefDeep(refDir, body.schemaRef);
        }
        return out;
      }
      case 'responses': {
        const responses = opts.includeExamples ? ep.responses : (ep.responses || []).map(stripExamples);
        const out = { responses };
        if (opts.resolveRefs) {
          out.responseSchemas = {};
          for (const r of (ep.responses || [])) {
            if (r.schemaRef) out.responseSchemas[r.code] = resolveSchemaRefDeep(refDir, r.schemaRef);
          }
        }
        return out;
      }
      case 'summary': return { description: ep.description };
      default: die(1, { error: `unknown field: ${name}` });
    }
  };

  if (field !== 'all') return { ...header, ...section(field) };

  return {
    ...header,
    security: ep.security || [],
    parameters: ep.parameters || [],
    headers: ep.headers || [],
    body: ep.body ? (opts.includeExamples ? ep.body : stripExamples(ep.body)) : null,
    responses: opts.includeExamples ? (ep.responses || []) : (ep.responses || []).map(stripExamples),
  };
}

function main() {
  const { cache, reference, slug, field, includeExamples, resolveRefs, area } = parseArgs(process.argv.slice(2));

  let refDir;
  let resolvedArea;
  try {
    const r = resolveReferenceDir(cache, reference, area ? { area } : {});
    refDir = r.dir;
    resolvedArea = r.area;
  } catch (e) {
    if (e instanceof AmbiguousReferenceError) {
      die(2, { error: e.message, reason: 'ambiguous-reference', reference, candidates: e.candidates });
    }
    if (e instanceof ReferenceNotCachedError) {
      die(2, { error: e.message, reason: 'reference-not-cached', reference });
    }
    throw e;
  }

  const resolved = resolveSlug(refDir, reference, slug);
  if (!resolved.ok) {
    const code = resolved.reason === 'reference-not-cached' ? 2 : 3;
    die(code, resolved);
  }

  const doc = readJson(resolved.file);
  if (doc.kind === 'type' && !fs.existsSync(resolved.file)) die(4, { error: 'type-missing', file: resolved.file });

  const body = digest(doc, field, { includeExamples, resolveRefs }, refDir);
  const out = {
    found: true,
    file: resolved.file,
    area: resolvedArea,
    reference: doc.reference || reference,
    slug: resolved.slug,
    matchedFrom: resolved.matchedFrom,
    kind: doc.kind,
    source: doc.source,
    url: doc.url,
    data: body,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// Run as a CLI only when invoked directly; allow `require()` to reuse the
// resolver (triage.js resolves a body.schemaRef to its type schema for diff.js).
if (require.main === module) {
  main();
}

module.exports = { resolveSchemaRef, resolveSchemaRefDeep };
