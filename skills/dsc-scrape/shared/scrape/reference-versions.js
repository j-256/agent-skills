'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { landingsForReference } = require('./resolve-cache.js');

class VersionResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionResolutionError';
  }
}

// Split a reference id into {base, version}. A trailing `-v<N>` is the version;
// an id without that suffix is the implicit version 1. Anchored on the hyphen so
// only `<base>-v<N>` matches -- ids like `tmf621v4` (no hyphen) or `bot-api-v5`
// (hyphen, but no unsuffixed sibling) are handled by the caller's grouping, and
// title-only versioning never reaches this function.
function parseVersionedId(id) {
  const m = /^(.+)-v(\d+)$/.exec(id);
  if (m) return { base: m[1], version: Number(m[2]) };
  return { base: id, version: 1 };
}

// basePath is read from a sibling's own _index.json, so it is null for any
// version that hasn't been scraped yet (e.g. the latest sibling on a cold
// per-reference cache, before scenario.js bumps + scrapes it). That's fine:
// the prefer-latest path in scenario.js consumes only latest/hasMultipleVersions/
// requestedIsVersioned, never basePath -- basePath is surfaced for the
// "what versions exist?" enumeration use documented in dsc-scenario SKILL.md.
function readBasePath(cacheRoot, area, id) {
  const p = path.join(cacheRoot, area, id, '_index.json');
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof doc.basePath === 'string' ? doc.basePath : null;
  } catch {
    return null;
  }
}

// Report the version siblings of a reference id, newest last. Facts only --
// the caller decides whether to use `latest` (see dsc-scenario SKILL.md
// "Prefer the latest reference version"). Never throws on an uncached id;
// returns a single-entry no-op shape so callers can use it unconditionally.
function resolveVersions(cacheRoot, referenceId, opts = {}) {
  if (typeof cacheRoot !== 'string' || cacheRoot.length === 0) {
    throw new VersionResolutionError('resolveVersions: cacheRoot must be a non-empty string');
  }
  if (typeof referenceId !== 'string' || referenceId.length === 0) {
    throw new VersionResolutionError('resolveVersions: referenceId must be a non-empty string');
  }
  const { area } = opts;
  const { base } = parseVersionedId(referenceId);
  const requestedIsVersioned = /^(.+)-v(\d+)$/.test(referenceId);

  // Which area landings to scan: the explicit area, or every area the id lives in.
  const areas = area ? [area] : landingsForReference(cacheRoot, referenceId);

  const siblings = new Map(); // id -> {id, version, basePath}
  for (const a of areas) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(cacheRoot, '_landing', `${a}.json`), 'utf8'));
    } catch {
      continue;
    }
    for (const r of Array.isArray(doc.references) ? doc.references : []) {
      if (!r || typeof r.id !== 'string') continue;
      if (parseVersionedId(r.id).base !== base) continue;
      const { version } = parseVersionedId(r.id);
      siblings.set(r.id, { id: r.id, version, basePath: readBasePath(cacheRoot, a, r.id) });
    }
  }

  // No landing carried the id: no-op shape (don't error -- that's the resolver's job).
  if (siblings.size === 0) {
    const { version } = parseVersionedId(referenceId);
    return {
      requested: referenceId,
      requestedIsVersioned,
      latest: referenceId,
      versions: [{ id: referenceId, version, basePath: null }],
      hasMultipleVersions: false,
    };
  }

  const versions = [...siblings.values()].sort((x, y) => x.version - y.version);
  return {
    requested: referenceId,
    requestedIsVersioned,
    latest: versions[versions.length - 1].id,
    versions,
    hasMultipleVersions: versions.length > 1,
  };
}

if (require.main === module) {
  const os = require('node:os');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`reference-versions: expected JSON on stdin: ${e.message}\n`);
      process.exit(2);
    }
    const cacheRoot = input.cacheRoot || path.join(os.homedir(), '.cache/dsc-scrape');
    try {
      const result = resolveVersions(cacheRoot, input.reference, input.area ? { area: input.area } : {});
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (e) {
      process.stderr.write(`reference-versions: ${e.message}\n`);
      process.exit(1);
    }
  });
}

module.exports = { resolveVersions, parseVersionedId, VersionResolutionError };
