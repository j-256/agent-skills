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
  reference,
  slugsWritten: mode === 'ok-refreshed' ? 3 : 0,
  format: 'oas-3',
  specUrl: 'https://example.test/spec.yaml',
  files: mode === 'ok-refreshed'
    ? [`${cacheRoot}/${reference}/Summary.json`, `${cacheRoot}/${reference}/getX.json`]
    : [],
  refreshed: mode === 'ok-refreshed',
  // Surface argv-derived info so tests can assert wiring like `--force`.
  argv: process.argv.slice(2),
};
process.stdout.write(JSON.stringify(summary) + '\n');
process.exit(0);
