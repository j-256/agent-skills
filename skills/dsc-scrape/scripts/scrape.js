#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { classifyUrl } = require('./classify.js');
const { fetchUrl } = require('./fetch-url.js');
const { parseCatalog } = require('./parse-catalog.js');
const { parseOas } = require('./parse-oas.js');
const { parseAmf } = require('./parse-amf.js');
const { writeSlug, writeIndex, writeLanding } = require('./write-slugs.js');

const DSC_BASE = 'https://developer.salesforce.com';

const CACHE_TTL_MS = process.env.DSC_CACHE_TTL_MS !== undefined
  ? Number(process.env.DSC_CACHE_TTL_MS)
  : 3600000;

function readPriorIndex(outRoot, reference) {
  const indexPath = path.join(outRoot, reference, '_index.json');
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
  const accept =
    entry.referenceType === 'rest-oa3' ? 'application/x-yaml,text/yaml,*/*' :
    entry.referenceType === 'rest-raml' ? 'application/json,*/*' :
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

async function handleReference(entry, { slugFilter, outRoot, referencePageUrl, catalog, force }) {
  if (entry.referenceType !== 'rest-oa3' && entry.referenceType !== 'rest-raml') {
    return {
      reference: entry.id,
      skipped: true,
      reason: `Unsupported referenceType: ${entry.referenceType}`,
    };
  }

  const prior = readPriorIndex(outRoot, entry.id);
  if (!force && !slugFilter && isFresh(prior)) {
    return {
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
  const siblings = catalog.filter((c) => c.id !== entry.id).map((c) => c.id);
  const referencePath = entry.href || `/docs/.../references/${entry.id}`;
  const scrapedAt = new Date().toISOString();

  writeIndex(outRoot, entry.id, {
    reference: entry.id,
    title: entry.title,
    referencePageUrl,
    scrapedAt,
    source: { format, specUrl: urlFetched },
    slugs: slugList,
    siblings,
  });

  const wanted = slugFilter ? slugs.filter((s) => slugFilter(s.slug)) : slugs;
  if (slugFilter && wanted.length === 0) {
    return {
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
    const file = writeSlug(outRoot, entry.id, s.slug, doc);
    written.push(file);
  }

  return {
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
  return await handleReference(entry, {
    slugFilter: (s) => s === slug,
    outRoot,
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
  return await handleReference(entry, { outRoot, referencePageUrl, catalog, force });
}

async function runCatalog({ url, referencesPath, outRoot, force }) {
  const html = await fetchReferencesPage(url);
  const catalog = parseCatalog(html);

  const landingName = referencesPath
    .replace(/^.*\/references\/?/, '')
    .replace(/\.html$/, '')
    .replace(/\//g, '-') || '_root';

  writeLanding(outRoot, landingName, {
    kind: 'landing',
    url,
    scrapedAt: new Date().toISOString(),
    references: catalog,
  });

  const results = [];
  for (const entry of catalog) {
    try {
      const r = await handleReference(entry, {
        outRoot,
        referencePageUrl: url,
        catalog,
        force,
      });
      results.push(r);
    } catch (err) {
      results.push({ reference: entry.id, error: err.message });
    }
  }
  return { landing: landingName, references: results };
}

async function main(argv) {
  const [, , url, outRoot, ...rest] = argv;
  if (!url || !outRoot) {
    console.error('Usage: node scripts/scrape.js <url> <out-root> [--all] [--force]');
    process.exit(2);
  }
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
  } else if (cls.kind === 'catalog' || cls.kind === 'landing') {
    if (!allMode && cls.kind === 'catalog') {
      console.error(
        'This URL is a /references/ catalog root. Pass --all to scrape every reference, or give a specific /references/<name>[?meta=<slug>] URL.'
      );
      process.exit(4);
    }
    result = await runCatalog({ ...cls, outRoot, force });
  }

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { main, handleReference };
