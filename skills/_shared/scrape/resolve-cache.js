'use strict';

const fs = require('node:fs');
const path = require('node:path');

class AmbiguousReferenceError extends Error {
  constructor(reference, candidates) {
    const list = candidates.join(', ');
    super(
      `Reference '${reference}' exists in multiple cached areas: [${list}]. ` +
      `Pass {area} to disambiguate (e.g. ` +
      `'commerce_commerce-api' for SCAPI, 'revenue_subscription-management' for Subscription Management).`
    );
    this.name = 'AmbiguousReferenceError';
    this.reference = reference;
    this.candidates = candidates;
  }
}

class ReferenceNotCachedError extends Error {
  constructor(reference, cacheRoot) {
    super(
      `Reference '${reference}' is not cached under ${cacheRoot}. ` +
      `Run dsc-scrape against the area-landing URL first (e.g. ` +
      `https://developer.salesforce.com/docs/<area>/references).`
    );
    this.name = 'ReferenceNotCachedError';
    this.reference = reference;
    this.cacheRoot = cacheRoot;
  }
}

// A reference dir is one the scraper actually wrote: it holds an _index.json
// (written by every successful scrape) or, lacking that, at least one slug JSON at
// its top level. This distinguishes a real reference from a foreign or legacy tree
// that happens to sit under the cache root -- e.g. an old snapshots/<name>/<ts>/
// archive this tool never writes -- which would otherwise be mis-read as an
// area/reference and dead-end every lookup against it. A missing path or a plain
// file (not a dir) is not a reference dir.
function isReferenceDir(dir) {
  try {
    if (fs.existsSync(path.join(dir, '_index.json'))) return true;
    return fs.readdirSync(dir).some((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    return false;
  }
}

function landingsForReference(cacheRoot, reference) {
  const out = new Set();

  // Pass 1: scan _landing/<area>.json (catalog-driven discovery).
  const landingDir = path.join(cacheRoot, '_landing');
  if (fs.existsSync(landingDir)) {
    for (const f of fs.readdirSync(landingDir)) {
      if (!f.endsWith('.json')) continue;
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(landingDir, f), 'utf8'));
      } catch {
        continue;
      }
      const refs = Array.isArray(doc.references) ? doc.references : [];
      if (refs.some((r) => r && r.id === reference)) {
        out.add(f.replace(/\.json$/, ''));
      }
    }
  }

  // Pass 2: scan area dirs directly (covers the case where a reference root
  // was scraped without first scraping its area-landing – no _landing/<area>.json
  // file exists yet, but the reference dir does).
  if (!fs.existsSync(cacheRoot)) return [...out];
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const candidate = path.join(cacheRoot, entry.name, reference);
    if (isReferenceDir(candidate)) {
      out.add(entry.name);
    }
  }

  return [...out];
}

function resolveReferenceDir(cacheRoot, reference, { area } = {}) {
  if (area) {
    const dir = path.join(cacheRoot, area, reference);
    if (!fs.existsSync(dir)) {
      throw new ReferenceNotCachedError(`${area}/${reference}`, cacheRoot);
    }
    return { area, dir };
  }
  const candidates = landingsForReference(cacheRoot, reference);
  if (candidates.length === 0) {
    throw new ReferenceNotCachedError(reference, cacheRoot);
  }
  if (candidates.length > 1) {
    throw new AmbiguousReferenceError(reference, candidates);
  }
  const resolvedArea = candidates[0];
  return {
    area: resolvedArea,
    dir: path.join(cacheRoot, resolvedArea, reference),
  };
}

module.exports = {
  resolveReferenceDir,
  landingsForReference,
  isReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
};
