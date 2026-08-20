#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// FAKE_MODE controls what this script does:
//   ok-refreshed  -> writes a real ref dir (_index.json) + area landing, prints
//                    a `refreshed: true` summary, exits 0
//   ok-fresh      -> prints a `refreshed: false` summary and exits 0 (no write)
//   not-found     -> prints a 404 error to stderr and exits 1
//   crash         -> prints something weird to stderr and exits 1
//   ok-nonjson    -> exits 0 but writes non-JSON to stdout (tests parse-error path)
// The ok-refreshed write mirrors the real scraper's side effect so the cache
// accessor (which resolves the ref dir after a refresh) can be tested offline.
// The write only happens when a cacheRoot arg is present, so summary-only
// consumers (test-scrape-refresh.js with /tmp/fake-cache) are unaffected unless
// they pass a writable root.
const mode = process.env.FAKE_MODE || 'ok-refreshed';

const [, , url, cacheRoot] = process.argv;
const reference = (url || '').split('/').filter(Boolean).pop() || 'unknown';

// Mirror areaKeyFromReferencesPath(url) from shared/scrape/scrape.js
// so the fake summary has the same `area` field the real scraper emits.
function areaKey(u) {
  let p = u || '';
  try { if (/^https?:\/\//.test(p)) p = new URL(p).pathname; } catch {}
  const stripped = p
    .replace(/[?#].*$/, '')
    .replace(/\/references\/[^/]+\/?$/, '/references')
    .replace(/^\/docs\//, '')
    .replace(/\/references\/?$/, '')
    .replace(/\/+$/, '');
  return stripped.replace(/\//g, '_') || '_root';
}
const area = areaKey(url);

if (mode === 'not-found') {
  process.stderr.write(`HTTP 404 fetching ${url}\n`);
  process.exit(1);
}
if (mode === 'crash') {
  process.stderr.write('unexpected boom\n');
  process.exit(1);
}
if (mode === 'ok-nonjson') {
  process.stdout.write('this is not json at all\n');
  process.exit(0);
}

// On a real refresh, the scraper writes files. Mirror that side effect so the
// cache accessor can resolve the ref dir afterward. Only when cacheRoot is a
// usable path. A bare reference URL (`.../references/<id>`) yields a landing URL
// (`.../references`) whose last segment is `references`; detect that so a
// landing-only refresh doesn't create a bogus `references` reference dir.
const isLandingOnly = (url || '').replace(/\/+$/, '').endsWith('/references');
if (mode === 'ok-refreshed' && cacheRoot) {
  const nowIso = new Date().toISOString();
  // Always (re)write the area landing manifest, listing this reference as a
  // sibling, mirroring runAreaLanding/runReferenceRoot's landing write.
  const landingDir = path.join(cacheRoot, '_landing');
  fs.mkdirSync(landingDir, { recursive: true });
  const landingPath = path.join(landingDir, `${area}.json`);
  let references = [];
  try {
    const prior = JSON.parse(fs.readFileSync(landingPath, 'utf8'));
    if (Array.isArray(prior.references)) references = prior.references;
  } catch {}
  if (!isLandingOnly && !references.some((r) => r && r.id === reference)) {
    references.push({ id: reference, title: reference });
  }
  fs.writeFileSync(landingPath, JSON.stringify({
    kind: 'area-landing', area, scrapedAt: nowIso, references,
  }));
  // Write the reference dir's _index.json (skipped for a landing-only refresh).
  if (!isLandingOnly) {
    const refDir = path.join(cacheRoot, area, reference);
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, '_index.json'), JSON.stringify({
      reference, area, scrapedAt: nowIso, endpoints: {},
    }));
  }
}

const summary = {
  area,
  reference,
  slugsWritten: mode === 'ok-refreshed' ? 3 : 0,
  format: 'oas-3',
  specUrl: 'https://example.test/spec.yaml',
  files: mode === 'ok-refreshed'
    ? [`${cacheRoot}/${area}/${reference}/Summary.json`, `${cacheRoot}/${area}/${reference}/getX.json`]
    : [],
  refreshed: mode === 'ok-refreshed',
  // Surface argv-derived info so tests can assert wiring like `--force`.
  argv: process.argv.slice(2),
};
process.stdout.write(JSON.stringify(summary) + '\n');
process.exit(0);
