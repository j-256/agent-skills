#!/usr/bin/env node
'use strict';

// FAKE_MODE controls what this script does:
//   ok-refreshed  -> prints a `refreshed: true` summary and exits 0
//   ok-fresh      -> prints a `refreshed: false` summary and exits 0
//   not-found     -> prints a 404 error to stderr and exits 1
//   crash         -> prints something weird to stderr and exits 1
//   ok-nonjson    -> exits 0 but writes non-JSON to stdout (tests parse-error path)
const mode = process.env.FAKE_MODE || 'ok-refreshed';

const [, , url, cacheRoot] = process.argv;
const reference = (url || '').split('/').filter(Boolean).pop() || 'unknown';

// Mirror areaKeyFromReferencesPath(url) from skills/_shared/scrape/scrape.js
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
