'use strict';

// Acronym extraction for catalog-time `searchKeys` enrichment. Pure function:
// takes a landing JSON document (the shape `_landing/<area>.json` files use,
// with `references: [{ id, title, ... }]`) and returns a deduplicated string
// array suitable to merge into a catalog product's `searchKeys`. No I/O.
//
// Per ref, two passes apply in order:
//   1. Parens-acronym pass: captures `(XYZ)` where XYZ is uppercase + digits
//      only (no spaces). Drops multi-word parens like `(REST API)`.
//   2. Bare-ALL-CAPS pass: captures word-boundary uppercase tokens of length
//      2+, then filters with a blocklist of generic technical / protocol
//      terms that aren't product anchors.
//
// Refs are processed in document order; both passes apply to each title
// before moving to the next ref. Dedup preserves first-seen across the
// whole walk -- so two products that both contain `(OCI)` only emit OCI
// once, ordered by which appeared first in `landing.references`.

const PARENS_RE = /\(([A-Z][A-Z0-9 ]{1,15})\)/g;
const BARE_RE = /\b([A-Z]{2,})\b/g;

// Generic / protocol noise. Excludes any token that COULD be a product anchor.
// Keep in sync with the spec's "Acronym landscape" table.
const NOISE_BLOCKLIST = new Set([
  'API', 'APIS', 'REST', 'HTTP', 'URL', 'SDK', 'OAS', 'RAML', 'JSON', 'HTML',
  'XML', 'YAML', 'OPENAPI', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
  'UI', 'OK', 'ID', 'SF', 'CSV', 'PDF',
  // Technical terms that surfaced in landing titles but aren't product anchors
  // (resolved at the bare-token stage; see spec section "Acronym landscape").
  'CDN', 'DX', 'GDPR', 'GDS', 'RPC', 'SEO',
]);

function extractKeys(landing) {
  if (!landing || typeof landing !== 'object') return [];
  const refs = Array.isArray(landing.references) ? landing.references : [];
  const seen = new Set();
  const out = [];

  for (const ref of refs) {
    const title = ref && typeof ref.title === 'string' ? ref.title : null;
    if (!title) continue;

    // Pass 1: parens-acronym on this title
    PARENS_RE.lastIndex = 0;
    let m;
    while ((m = PARENS_RE.exec(title)) !== null) {
      const inner = m[1].trim();
      if (inner.includes(' ')) continue; // drops "(REST API)"
      if (seen.has(inner)) continue;
      seen.add(inner);
      out.push(inner);
    }

    // Pass 2: bare-ALL-CAPS on this title
    BARE_RE.lastIndex = 0;
    while ((m = BARE_RE.exec(title)) !== null) {
      const tok = m[1];
      if (NOISE_BLOCKLIST.has(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
  }

  return out;
}

module.exports = { extractKeys, NOISE_BLOCKLIST };
