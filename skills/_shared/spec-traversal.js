'use strict';

// Generic spec-reading helpers, hoisted from dsc-scenario/scripts/walk-types.js
// so any skill (and _shared consumers like b2c-corrections.js) can read a cached
// reference's type schemas without depending UP into a skill's scripts/. Spec
// traversal is a product-neutral capability, not scenario-specific.

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('./scrape/resolve-cache.js');

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
// Normalize AMF to OAS so consumers handle both.
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

function loadType(cacheRoot, reference, typeName, area) {
  const refDir = refDirFor(cacheRoot, reference, area);
  const p = path.join(refDir, 'types', `${typeName}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

function typeHasProperty(cacheRoot, reference, typeName, fieldName, area) {
  if (!fieldName) return false;
  const typeDoc = loadType(cacheRoot, reference, typeName, area);
  if (!typeDoc) return false;
  const typeSchema = normalizeSchema(typeDoc.type && typeDoc.type.schema);
  const props = (typeSchema && typeSchema.properties) || {};
  return fieldName in props;
}

module.exports = { refDirFor, readJson, normalizeSchema, loadType, typeHasProperty, ReferenceNotScrapedError };
