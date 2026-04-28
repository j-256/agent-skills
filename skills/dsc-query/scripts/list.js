#!/usr/bin/env node
// Inspect a dsc-scrape cache.
//
// Usage:
//   node list.js <cache>                          list cached references
//   node list.js <cache> <reference>              list slugs in a reference (from _index.json)
//   node list.js <cache> <reference> --grep PAT   filter slugs by case-insensitive substring
//
// Output: JSON to stdout. Exit 2 if the cache/reference dir doesn't exist.

const fs = require('fs');
const path = require('path');

function die(code, obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) die(1, { error: 'usage: list.js <cache> [reference] [--grep PAT]' });

  const cache = argv[0];
  if (!fs.existsSync(cache)) die(2, { error: 'cache-missing', cache });

  let reference = null;
  let grep = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--grep') grep = argv[++i];
    else if (!reference) reference = a;
    else die(1, { error: `unexpected arg: ${a}` });
  }

  if (!reference) {
    const refs = fs.readdirSync(cache, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_'))
      .map(d => d.name)
      .sort();
    die(0, { cache, references: refs });
  }

  const refDir = path.join(cache, reference);
  if (!fs.existsSync(refDir)) die(2, { error: 'reference-not-cached', reference, cache });

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
    reference,
    title: index?.title ?? null,
    slugCount: slugs.length,
    slugs,
  });
}

main();
