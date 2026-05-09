#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scrapeRefresh, ScrapeInvocationError } = require('../lib/scrape-refresh.js');
const {
  resolveReferenceDir,
  AmbiguousReferenceError,
  ReferenceNotCachedError,
} = require('../lib/scrape/resolve-cache.js');
const { walkTypes, ReferenceNotScrapedError } = require('./walk-types.js');
const { composePlan } = require('./compose.js');
const { renderCurlBlock } = require('./curl-block.js');

function die(code, obj) {
  const msg = obj && obj.error ? obj.error : JSON.stringify(obj);
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function readStdinJson() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = await readStdinJson().catch((e) => {
    die(2, { error: `scenario: expected JSON on stdin: ${e.message}` });
  });

  const { target, referenceUrl, cacheRoot, scrapeScript, graph: providedGraph } = input || {};
  if (!target) die(2, { error: 'scenario: missing `target`' });
  if (!referenceUrl) die(2, { error: 'scenario: missing `referenceUrl`' });

  let scrapeResult;
  try {
    scrapeResult = await scrapeRefresh({ scrapeScript, referenceUrl, cacheRoot });
  } catch (e) {
    if (e instanceof ScrapeInvocationError) {
      die(3, { error: `scenario: scrape failed: ${e.message}` });
    }
    throw e;
  }

  const reference = referenceUrl.split('/').filter(Boolean).pop();
  let area;
  let refDir;
  try {
    const r = resolveReferenceDir(cacheRoot, reference, scrapeResult.area ? { area: scrapeResult.area } : {});
    area = r.area;
    refDir = r.dir;
  } catch (e) {
    if (e instanceof AmbiguousReferenceError || e instanceof ReferenceNotCachedError) {
      die(3, { error: `scenario: ${e.message}` });
    }
    throw e;
  }
  const indexPath = path.join(refDir, '_index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    die(3, { error: `scenario: cannot read _index.json: ${e.message}` });
  }

  if (!index.endpoints || !(target in index.endpoints)) {
    die(2, { error: `scenario: target '${target}' not found in reference '${reference}'` });
  }

  let graph;
  try {
    graph = providedGraph || walkTypes({ targetSlug: target, reference, cacheRoot, area });
  } catch (e) {
    if (e instanceof ReferenceNotScrapedError) {
      die(3, { error: `scenario: ${e.message}` });
    }
    throw e;
  }

  if (!graph.nodes.some((n) => n.slug === target)) {
    die(2, { error: `scenario: provided graph does not include target '${target}'` });
  }

  const plan = composePlan({ graph, targetSlug: target, reference, cacheRoot, area });
  const runnable = renderCurlBlock({ plan });
  const sources = plan.steps.map((s) => s.specUrl);

  const out = { plan, runnable, sources };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((e) => die(1, { error: `scenario: unexpected: ${e.stack || e.message}` }));
