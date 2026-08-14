#!/usr/bin/env node
// Inspect a dsc-scrape cache.
//
// Usage:
//   node list.js <cache>                                  list cached references (across all areas)
//   node list.js <cache> <reference>                      list slugs in a reference
//   node list.js <cache> <reference> --area AREA          disambiguate when a ref id appears in multiple areas
//   node list.js <cache> <reference> --grep PAT           filter slugs by case-insensitive substring
//
// Output: JSON to stdout. Exit 2 if the cache/reference dir doesn't exist or is ambiguous.

const fs = require('fs');
const path = require('path');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
  landingsForReference,
  isReferenceDir,
} = require('../lib/scrape/resolve-cache.js');

function die(code, obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

function listAllReferences(cache) {
  // Walk <cache>/<area>/<reference>/. Areas are siblings of _landing/_catalog.json.
  const areas = fs.readdirSync(cache, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();
  const out = [];
  for (const area of areas) {
    const areaDir = path.join(cache, area);
    const refs = fs.readdirSync(areaDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    // Only list dirs that are actually references (skip foreign/legacy trees like
    // a stray snapshots/<name>/<ts>/ archive that would otherwise dead-end a lookup).
    for (const ref of refs) {
      if (isReferenceDir(path.join(areaDir, ref))) out.push({ area, reference: ref });
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) die(1, { error: 'usage: list.js <cache> [reference] [--area AREA] [--grep PAT]' });

  const cache = argv[0];
  if (!fs.existsSync(cache)) die(2, { error: 'cache-missing', cache });

  let reference = null;
  let grep = null;
  let area = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--grep') grep = argv[++i];
    else if (a === '--area') area = argv[++i];
    else if (!reference) reference = a;
    else die(1, { error: `unexpected arg: ${a}` });
  }

  if (!reference) {
    die(0, { cache, references: listAllReferences(cache) });
  }

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
      die(2, { error: e.message, reason: 'reference-not-cached', reference, cache });
    }
    throw e;
  }

  const indexPath = path.join(refDir, '_index.json');
  let slugs = [];
  let index = null;
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    slugs = Array.isArray(index.slugs) ? index.slugs : [];
  } else {
    slugs = fs.readdirSync(refDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => f.replace(/\.json$/, ''));
  }

  if (grep) {
    const g = grep.toLowerCase();
    slugs = slugs.filter(s => s.toLowerCase().includes(g));
  }

  die(0, {
    cache,
    area: resolvedArea,
    reference,
    title: index?.title ?? null,
    slugCount: slugs.length,
    slugs,
  });
}

main();
