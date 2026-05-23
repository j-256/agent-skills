#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { classifyUrl } = require('./classify.js');
const { fetchUrl } = require('./fetch-url.js');
const { parseCatalog } = require('./parse-catalog.js');
const { parseApiCatalog } = require('./parse-api-catalog.js');
const { parseOas } = require('./parse-oas.js');
const { parseAmf } = require('./parse-amf.js');
const { parseSwagger2 } = require('./parse-swagger2.js');
const { writeSlug, writeIndex, writeLanding } = require('./write-slugs.js');
const { extractKeys } = require('./extract-keys.js');
const { CATALOG_KEYS } = require('./catalog-keys.js');

const DSC_BASE = 'https://developer.salesforce.com';

const CACHE_TTL_MS = process.env.DSC_CACHE_TTL_MS !== undefined
  ? Number(process.env.DSC_CACHE_TTL_MS)
  : 3600000;

function readJsonIfFresh(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isFresh(doc) ? doc : null;
  } catch {
    return null;
  }
}

function readPriorIndex(outRoot, area, reference) {
  const indexPath = path.join(outRoot, area, reference, '_index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return null;
  }
}

function isFresh(prior) {
  if (!prior?.scrapedAt) return false;
  const age = Date.now() - Date.parse(prior.scrapedAt);
  return age >= 0 && age < CACHE_TTL_MS;
}

function areaKeyFromReferencesPath(referencesPath) {
  // Accepts either a URL or a path; strips query/hash if present.
  let p = referencesPath;
  try {
    if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  } catch {
    // fall through to path treatment
  }
  const stripped = p
    .replace(/[?#].*$/, '')
    .replace(/\/references\/[^/]+\/?$/, '/references')
    .replace(/^\/docs\//, '')
    .replace(/\/references\/?$/, '')
    .replace(/\/+$/, '');
  return stripped.replace(/\//g, '_') || '_root';
}

function slugUrl(referencePath, slug) {
  return `${DSC_BASE}${referencePath}?meta=${encodeURIComponent(slug)}`;
}

async function fetchReferencesPage(url) {
  return await fetchUrl(url, { accept: 'text/html,*/*' });
}

async function fetchSpec(entry, referencePageUrl) {
  if (!entry.source) {
    throw new Error(`Catalog entry has no source (referenceType=${entry.referenceType}): ${entry.id}`);
  }
  const specUrl = DSC_BASE + entry.source;
  const sourceIsYaml = /\.(ya?ml)$/i.test(entry.source || '');
  const accept =
    entry.referenceType === 'rest-oa3' ? 'application/x-yaml,text/yaml,*/*' :
    entry.referenceType === 'rest-raml' ? 'application/json,*/*' :
    entry.referenceType === 'rest-oa2' ? (sourceIsYaml ? 'application/x-yaml,text/yaml,*/*' : 'application/json,*/*') :
    '*/*';
  const amfUrl = entry.amf ? DSC_BASE + entry.amf : null;
  const urlToFetch = entry.referenceType === 'rest-raml' && amfUrl ? amfUrl : specUrl;
  const body = await fetchUrl(urlToFetch, { referer: referencePageUrl, accept });
  return { urlFetched: urlToFetch, specUrl, body };
}

function parseSpec(entry, body) {
  if (entry.referenceType === 'rest-oa3') {
    const doc = yaml.load(body);
    return { format: 'oas-3', slugs: parseOas(doc) };
  }
  if (entry.referenceType === 'rest-raml') {
    const doc = JSON.parse(body);
    return { format: 'amf-raml', slugs: parseAmf(doc) };
  }
  if (entry.referenceType === 'rest-oa2') {
    const isYaml = /\.(ya?ml)$/i.test(entry.source || '');
    const doc = isYaml ? yaml.load(body) : JSON.parse(body);
    return { format: 'swagger-2', slugs: parseSwagger2(doc) };
  }
  throw new Error(`Unsupported referenceType: ${entry.referenceType}`);
}

function envelopeSlug({ entry, format, specUrl, slug, referencePath, scrapedAt }) {
  return {
    kind: slug.kind,
    reference: entry.id,
    slug: slug.slug,
    url: slugUrl(referencePath, slug.slug),
    scrapedAt,
    source: {
      format,
      specUrl,
    },
    ...(slug.kind === 'endpoint' ? { endpoint: slug.endpoint } : {}),
    ...(slug.kind === 'type' ? { type: slug.type } : {}),
    ...(slug.kind === 'summary' ? { summary: slug.summary } : {}),
  };
}

async function handleReference(entry, { slugFilter, outRoot, area, referencePageUrl, catalog, force }) {
  if (!area) throw new Error('handleReference: area is required');
  if (
    entry.referenceType !== 'rest-oa3' &&
    entry.referenceType !== 'rest-raml' &&
    entry.referenceType !== 'rest-oa2'
  ) {
    return {
      area,
      reference: entry.id,
      skipped: true,
      reason: `Unsupported referenceType: ${entry.referenceType}`,
    };
  }

  const prior = readPriorIndex(outRoot, area, entry.id);
  if (!force && !slugFilter && isFresh(prior)) {
    return {
      area,
      reference: entry.id,
      slugsWritten: 0,
      format: prior.source?.format,
      specUrl: prior.source?.specUrl,
      files: [],
      refreshed: false,
    };
  }

  const { urlFetched, specUrl, body } = await fetchSpec(entry, referencePageUrl);
  const { format, slugs } = parseSpec(entry, body);
  const slugList = slugs.map((s) => s.slug);
  const endpoints = {};
  for (const s of slugs) {
    if (s.kind !== 'endpoint') continue;
    endpoints[s.slug] = {
      method: s.endpoint.method,
      path: s.endpoint.path,
    };
  }
  const siblings = catalog.filter((c) => c.id !== entry.id).map((c) => c.id);
  const referencePath = entry.href || `/docs/.../references/${entry.id}`;
  const scrapedAt = new Date().toISOString();

  writeIndex(outRoot, area, entry.id, {
    reference: entry.id,
    area,
    title: entry.title,
    referencePageUrl,
    scrapedAt,
    source: { format, specUrl: urlFetched },
    slugs: slugList,
    endpoints,
    siblings,
  });

  const wanted = slugFilter ? slugs.filter((s) => slugFilter(s.slug)) : slugs;
  if (slugFilter && wanted.length === 0) {
    return {
      area,
      reference: entry.id,
      requestedSlug: true,
      error: `No slug matched filter in reference ${entry.id}`,
      availableSlugs: slugList.slice(0, 40),
    };
  }

  const written = [];
  for (const s of wanted) {
    const doc = envelopeSlug({
      entry,
      format,
      specUrl: urlFetched,
      slug: s,
      referencePath,
      scrapedAt,
    });
    const file = writeSlug(outRoot, area, entry.id, s.slug, doc);
    written.push(file);
  }

  return {
    area,
    reference: entry.id,
    slugsWritten: written.length,
    format,
    specUrl: urlFetched,
    files: written,
    refreshed: true,
  };
}

async function runSlug({ reference, slug, referencePageUrl, outRoot, force }) {
  const html = await fetchReferencesPage(referencePageUrl);
  const catalog = parseCatalog(html);
  const entry = catalog.find((c) => c.id === reference);
  if (!entry) {
    throw new Error(`Reference "${reference}" not found in catalog at ${referencePageUrl}. Available: ${catalog.map((c)=>c.id).slice(0,10).join(', ')}...`);
  }
  const area = areaKeyFromReferencesPath(referencePageUrl);
  return await handleReference(entry, {
    slugFilter: (s) => s === slug,
    outRoot,
    area,
    referencePageUrl,
    catalog,
    force,
  });
}

async function runReferenceRoot({ reference, referencePageUrl, outRoot, force }) {
  const html = await fetchReferencesPage(referencePageUrl);
  const catalog = parseCatalog(html);
  const entry = catalog.find((c) => c.id === reference);
  if (!entry) {
    throw new Error(`Reference "${reference}" not found in catalog at ${referencePageUrl}.`);
  }
  const area = areaKeyFromReferencesPath(referencePageUrl);
  if (!entry.source && entry.referenceType !== 'rest-oa3' && entry.referenceType !== 'rest-raml' && entry.referenceType !== 'rest-oa2') {
    return await runWrapperLanding({ wrapperId: entry.id, referencePageUrl, area, catalog, outRoot, force });
  }
  return await handleReference(entry, { outRoot, area, referencePageUrl, catalog, force });
}

async function runWrapperLanding({ wrapperId, referencePageUrl, area, catalog, outRoot, force }) {
  writeLanding(outRoot, wrapperId, {
    kind: 'landing',
    url: referencePageUrl,
    area,
    scrapedAt: new Date().toISOString(),
    references: catalog,
  });
  const results = [];
  for (const entry of catalog) {
    try {
      const r = await handleReference(entry, {
        outRoot,
        area,
        referencePageUrl,
        catalog,
        force,
      });
      results.push(r);
    } catch (err) {
      results.push({ reference: entry.id, error: err.message });
    }
  }
  return { landing: wrapperId, area, references: results };
}

async function runAreaLanding({ url, referencesPath, outRoot, force, scrapeAll }) {
  const areaKey = areaKeyFromReferencesPath(referencesPath);
  const landingDir = path.join(outRoot, '_landing');
  const landingPath = path.join(landingDir, `${areaKey}.json`);

  let catalog;
  let landingDoc;
  const cached = !force ? readJsonIfFresh(landingPath) : null;
  if (cached && Array.isArray(cached.references)) {
    catalog = cached.references;
    landingDoc = cached;
  } else {
    const html = await fetchReferencesPage(url);
    catalog = parseCatalog(html);
    landingDoc = {
      kind: 'area-landing',
      url,
      area: areaKey,
      scrapedAt: new Date().toISOString(),
      references: catalog,
    };
    writeLanding(outRoot, areaKey, landingDoc);
  }

  const result = {
    kind: 'area-landing',
    area: areaKey,
    landingFile: landingPath,
    references: catalog.map((c) => ({
      id: c.id,
      title: c.title,
      referenceType: c.referenceType,
      href: c.href,
    })),
    refreshed: !cached,
  };

  if (!scrapeAll) return result;

  const scraped = [];
  for (const entry of catalog) {
    try {
      const r = await handleReference(entry, {
        outRoot,
        area: areaKey,
        referencePageUrl: url,
        catalog,
        force,
      });
      scraped.push(r);
    } catch (err) {
      scraped.push({ reference: entry.id, error: err.message });
    }
  }
  result.scraped = scraped;
  return result;
}

async function runDocsLanding({ url, referencesPath, outRoot, force }) {
  const html = await fetchReferencesPage(url);
  const catalog = parseCatalog(html);

  const landingName = referencesPath
    .replace(/^.*\/references\/?/, '')
    .replace(/\.html$/, '')
    .replace(/\//g, '-') || '_root';
  const area = landingName;

  writeLanding(outRoot, landingName, {
    kind: 'landing',
    url,
    area,
    scrapedAt: new Date().toISOString(),
    references: catalog,
  });

  const results = [];
  for (const entry of catalog) {
    try {
      const r = await handleReference(entry, {
        outRoot,
        area,
        referencePageUrl: url,
        catalog,
        force,
      });
      results.push(r);
    } catch (err) {
      results.push({ reference: entry.id, error: err.message });
    }
  }
  return { landing: landingName, area, references: results };
}

async function enrichCatalog({ catalogDoc, outRoot, force }) {
  const products = catalogDoc.products;
  const scrapeable = new Set(['area-landing', 'reference-root']);

  // Group hand-curated catalog-keys by productTitle for one-pass lookup.
  // Uppercase the key to match the auto-derive pass's casing convention.
  const handByTitle = new Map();
  for (const [key, productTitle] of Object.entries(CATALOG_KEYS)) {
    if (!handByTitle.has(productTitle)) handByTitle.set(productTitle, []);
    handByTitle.get(productTitle).push(key.toUpperCase());
  }

  for (const product of products) {
    if (!scrapeable.has(product.referenceShape)) {
      product.searchKeys = [];
      continue;
    }
    let landingDoc = null;
    try {
      const landingResult = await runAreaLanding({
        url: product.referenceUrl,
        referencesPath: new URL(product.referenceUrl).pathname,
        outRoot,
        force,
        scrapeAll: false,
      });
      const landingPath = landingResult.landingFile;
      if (landingPath && fs.existsSync(landingPath)) {
        landingDoc = JSON.parse(fs.readFileSync(landingPath, 'utf8'));
      }
    } catch {
      // Landing fetch failed (404, network) -- continue without auto-derived keys.
      // The product still gets hand-curated keys if any, plus an empty array fallback.
      landingDoc = null;
    }

    const auto = landingDoc ? extractKeys(landingDoc) : [];
    const hand = handByTitle.get(product.title) || [];
    const merged = [];
    const seen = new Set();
    for (const k of [...auto, ...hand]) {
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(k);
    }
    product.searchKeys = merged;
  }
}

async function runApiCatalog({ url, outRoot, force }) {
  const catalogPath = path.join(outRoot, '_catalog.json');
  const cached = !force ? readJsonIfFresh(catalogPath) : null;

  // Cached AND already enriched: nothing to do.
  if (cached && Array.isArray(cached.products) && cached.products.every((p) => 'searchKeys' in p)) {
    return {
      kind: 'api-catalog',
      catalogFile: catalogPath,
      productCount: cached.products.length,
      refreshed: false,
    };
  }

  let doc;
  if (cached) {
    // Fresh catalog but missing searchKeys -- one-time backfill.
    doc = cached;
  } else {
    const html = await fetchReferencesPage(url);
    const products = parseApiCatalog(html);
    if (products.length === 0) {
      throw new Error(`No products parsed from ${url}. Page markup may have changed.`);
    }
    fs.mkdirSync(outRoot, { recursive: true });
    doc = {
      kind: 'api-catalog',
      url,
      scrapedAt: new Date().toISOString(),
      products,
    };
    // Write the unenriched catalog first so a crash mid-enrichment still
    // leaves something usable on disk.
    fs.writeFileSync(catalogPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }

  await enrichCatalog({ catalogDoc: doc, outRoot, force });

  fs.writeFileSync(catalogPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return {
    kind: 'api-catalog',
    catalogFile: catalogPath,
    productCount: doc.products.length,
    refreshed: !cached,
  };
}

// Detect misparsed CLI invocations early. The script takes positional
// args `<url> <out-root> [--all] [--force]` – there is no `--cache-root`
// or `--cache` flag. When a caller invents one (`scrape.js <url>
// --cache-root ~/.cache/dsc-scrape`) the literal flag string lands as
// `outRoot` and a stray dir gets created at cwd. Same for an
// unexpanded literal `~` when shell expansion was disabled or `HOME`
// was empty in the subprocess env. Reject these before any side effect.
function validateScrapeArgv(argv) {
  const [, , url, outRoot] = argv;
  if (!url || !outRoot) {
    return { ok: false, reason: 'missing-args' };
  }
  if (outRoot.startsWith('--')) {
    return { ok: false, reason: 'flag-as-outroot', value: outRoot };
  }
  if (outRoot === '~' || outRoot.startsWith('~/')) {
    return { ok: false, reason: 'literal-tilde-outroot', value: outRoot };
  }
  if (outRoot.startsWith('-')) {
    return { ok: false, reason: 'short-flag-as-outroot', value: outRoot };
  }
  return { ok: true };
}

const USAGE_LINE = 'Usage: node scripts/scrape.js <url> <out-root> [--all] [--force]';

function printValidationError(check) {
  if (check.reason === 'missing-args') {
    console.error(USAGE_LINE);
    return;
  }
  if (check.reason === 'flag-as-outroot') {
    console.error(`ERROR: out-root looks like a misparsed flag (outRoot was: '${check.value}').`);
    console.error('       This script has no --cache-root / --cache flag; the cache root is the second positional arg.');
    console.error(USAGE_LINE);
    return;
  }
  if (check.reason === 'literal-tilde-outroot') {
    console.error(`ERROR: out-root is a literal tilde (outRoot was: '${check.value}').`);
    console.error('       Shell tilde expansion did not run – pass an expanded absolute path instead.');
    console.error(USAGE_LINE);
    return;
  }
  if (check.reason === 'short-flag-as-outroot') {
    console.error(`ERROR: out-root looks like a misparsed flag (outRoot was: '${check.value}').`);
    console.error('       The cache root is the second positional arg, not a flag value.');
    console.error(USAGE_LINE);
    return;
  }
  console.error(USAGE_LINE);
}

async function main(argv) {
  const check = validateScrapeArgv(argv);
  if (!check.ok) {
    printValidationError(check);
    process.exit(2);
  }
  const [, , url, outRoot, ...rest] = argv;
  const allMode = rest.includes('--all');
  const force = rest.includes('--force');

  const cls = classifyUrl(url);
  if (cls.kind === 'decline') {
    console.error('DECLINE:', cls.reason);
    process.exit(3);
  }

  let result;
  if (cls.kind === 'slug') {
    result = await runSlug({ ...cls, outRoot, force });
  } else if (cls.kind === 'reference-root') {
    result = await runReferenceRoot({ ...cls, outRoot, force });
  } else if (cls.kind === 'api-catalog') {
    result = await runApiCatalog({ ...cls, outRoot, force });
  } else if (cls.kind === 'area-landing') {
    result = await runAreaLanding({ ...cls, outRoot, force, scrapeAll: allMode });
  } else if (cls.kind === 'landing') {
    result = await runDocsLanding({ ...cls, outRoot, force });
  }

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { main, handleReference, areaKeyFromReferencesPath, validateScrapeArgv };
