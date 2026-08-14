'use strict';

// ---------------------------------------------------------------------------
// Spec corrections: self-invalidating curated overrides.
//
// A correction asserts a fact that OVERRIDES what a spec declares (its
// security[]/schema). Because an override is trusted MORE than the spec, a
// STALE override fails confidently -- strictly worse than declining. The
// defense: a correction may carry a `specAnchor` snapshot of the exact spec
// field it overrides, and we re-check that field every run. If the spec still
// says what we recorded, the premise holds and the claim renders; if not, we
// STOP trusting it and flag "re-verify". This turns an eternal assertion into
// a self-invalidating one -- the family's decline-rather-than-fabricate thesis
// applied to our own corrections.
//
// This layer is product-neutral: `ctx` is an OPAQUE bag the anchor's own
// read() interprets, and volatility is DERIVED from entry shape, never an
// enum the author must set.

// Volatility is derived from shape, not stored:
//   infraInvariant flag  -> infra-invariant  (~never stale; e.g. an auth host -- no spec field to watch)
//   specAnchor present   -> spec-divergence  (watch the field; the dangerous, drift-prone class)
//   otherwise            -> platform-behavior (a dated runtime fact; re-verify on cadence via verifiedOn)
function deriveVolatility(entry) {
  if (entry && entry.infraInvariant === true) return 'infra-invariant';
  if (entry && entry.specAnchor) return 'spec-divergence';
  return 'platform-behavior';
}

// Re-evaluate a correction's specAnchor against the live spec reachable through
// `ctx`. The anchor supplies its OWN read(ctx) (WHERE the watched field lives --
// an inline op field, or a $ref-resolved schema field via spec-traversal) and
// holds(value) (is the premise still true?). Field-agnostic: this function
// hard-codes no notion of security vs schema.
//   no anchor          -> { state:'holds' }                (anchor-less; nothing to watch)
//   read throws/null    -> { state:'drifted', now:null }    (can't read -> fail toward re-verify, never silent trust)
//   holds throws        -> { state:'drifted', now:value }   (predicate blew up on the value -> re-verify, keep what we read)
//   holds(value)        -> { state:'holds'|'drifted', now:value }
function checkSpecAnchor(anchor, ctx) {
  if (!anchor) return { state: 'holds' };
  let now;
  try {
    now = anchor.read(ctx);
  } catch {
    return { state: 'drifted', now: null };
  }
  if (now == null) return { state: 'drifted', now: null };
  // A throwing holds() (e.g. a malformed value shape) funds toward drifted too --
  // same "fail toward re-verify, never toward silent trust" rule as a failed read,
  // but keep the value we read so the drift note can show what the spec says now
  try {
    return { state: anchor.holds(now) ? 'holds' : 'drifted', now };
  } catch {
    return { state: 'drifted', now };
  }
}

// Resolve every matching NOTE fact to ONE render-ready Note. Product-neutral:
// iterates opaque curated-fact objects, delegates the field read to each anchor.
// `ctx` carries whatever the anchors' read() functions need (opDoc for inline
// fields; cacheRoot/area/reference for schema-field reads via spec-traversal).
// Only attach:'note' facts are considered -- the body-mode facts (producer-body,
// op-body) share the same registry array but render via attachCuratedBodies, not
// here; the filter keeps them off the note channel.
function applyCuratedNotes({ context, facts, opDoc, cacheRoot, area, reference } = {}) {
  if (!Array.isArray(facts)) return [];
  const ctx = { opDoc, cacheRoot, area, reference };
  const notes = [];
  for (const c of facts) {
    if (c.attach !== 'note') continue; // body-mode facts render via attachCuratedBodies, not here
    if (typeof c.match !== 'function' || !c.match(context)) continue;
    const { state, now } = checkSpecAnchor(c.specAnchor, ctx);
    const base = {
      id: c.id, claim: c.claim, basis: c.basis, cite: c.cite != null ? c.cite : null,
      verifiedOn: Array.isArray(c.verifiedOn) ? c.verifiedOn : [],
      scope: c.scope != null ? c.scope : null,
      volatility: deriveVolatility(c),
    };
    if (c.specAnchor && state !== 'holds') {
      notes.push({ ...base, status: 'drifted', drift: { field: c.specAnchor.field, saw: c.specAnchor.saw, now } });
    } else {
      notes.push({ ...base, status: 'active' });
    }
  }
  return notes;
}

function hasPublicDscUrl(text) {
  for (const token of text.split(/\s+/)) {
    const start = token.indexOf('https://');
    if (start === -1) continue;
    const candidate = token.slice(start).replace(/[),.;`]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'developer.salesforce.com') return true;
    } catch {
      continue;
    }
  }
  return false;
}

function assertCuratedFactsWellFormed(facts) {
  if (!Array.isArray(facts)) throw new Error('curated facts must be an array');
  for (const c of facts) {
    const where = `curated-fact '${c && c.id ? c.id : '(no id)'}'`;
    if (!c || typeof c.id !== 'string' || !c.id) throw new Error(`${where}: missing id`);
    const attach = c.attach;
    if (!['note', 'producer-body', 'op-body'].includes(attach)) {
      throw new Error(`${where}: attach must be note|producer-body|op-body (got ${attach})`);
    }
    // Common spine: every fact carries claim/provenance/basis/cite.
    if (typeof c.claim !== 'string' || !c.claim) throw new Error(`${where}: missing claim`);
    if (typeof c.provenance !== 'string' || !c.provenance) throw new Error(`${where}: missing provenance`);
    if (!['runtime-verified', 'doc-stated', 'platform-owner'].includes(c.basis)) {
      throw new Error(`${where}: basis must be runtime-verified|doc-stated|platform-owner`);
    }
    if (c.basis === 'runtime-verified' && !(Array.isArray(c.verifiedOn) && c.verifiedOn.length > 0)) {
      throw new Error(`${where}: runtime-verified needs a non-empty verifiedOn`);
    }
    if (!('cite' in c)) throw new Error(`${where}: cite is required (a URL, or explicit null)`);
    // Match is required for match-triggered modes (note, op-body); producer-body
    // triggers on producesType instead (Task 2).
    if ((attach === 'note' || attach === 'op-body') && typeof c.match !== 'function') {
      throw new Error(`${where}: ${attach} requires a match function`);
    }
    // specAnchor conditional-completeness (unchanged from today; applies to any anchored fact).
    if (c.specAnchor) {
      const a = c.specAnchor;
      if (typeof a.field !== 'string' || !a.field) throw new Error(`${where}: specAnchor.field required`);
      if (typeof a.saw !== 'string' || !a.saw) throw new Error(`${where}: specAnchor.saw (readable snapshot) required`);
      if (typeof a.read !== 'function') throw new Error(`${where}: specAnchor.read must be a function`);
      if (typeof a.holds !== 'function') throw new Error(`${where}: specAnchor.holds must be a function`);
      if (typeof c.scope !== 'string' || !c.scope) throw new Error(`${where}: an anchored fact needs an explicit scope bounds string`);
    }
    if (attach === 'producer-body' || attach === 'op-body') {
      if (attach === 'producer-body' && (typeof c.producesType !== 'string' || !c.producesType)) {
        throw new Error(`${where}: producer-body requires producesType (the produced body-type name)`);
      }
      if (c.family !== 'SCAPI' && c.family !== 'OCAPI') throw new Error(`${where}: body mode requires family SCAPI|OCAPI`);
      // Body-mode provenance renders into the user-facing curl banner (curl-block.js),
      // so it MUST cite a public developer.salesforce.com URL -- a ~/.cache or skill-file
      // path would leak a non-shareable location. (note facts are exempt: their
      // provenance legitimately cites docs/commerce-auth-matrix.md and is never rendered.)
      if (!hasPublicDscUrl(c.provenance)) {
        throw new Error(`${where}: body-mode provenance must cite a public developer.salesforce.com URL`);
      }
      if (!Array.isArray(c.leaves) || c.leaves.length === 0) throw new Error(`${where}: body mode requires a non-empty leaves[]`);
      for (const p of c.leaves) if (typeof p !== 'string' || !p) throw new Error(`${where}: each leaf is a non-empty path string`);
      if (!Array.isArray(c.bodyContents) || c.bodyContents.length === 0) throw new Error(`${where}: body mode requires a non-empty bodyContents[]`);
      for (const bc of c.bodyContents) if (!bc || !bc.field || !bc.why) throw new Error(`${where}: each bodyContents entry needs field + why`);
      for (const prefix of Object.keys(c.elementTypes || {})) {
        if (!c.leaves.some((p) => p === prefix || p.startsWith(`${prefix}.`))) {
          throw new Error(`${where}: elementTypes prefix '${prefix}' names no leaf`);
        }
      }
    }
  }
  // seeAlso (optional) must name an existing fact id -- a whole-registry cross-ref
  // pass, so a cross-reference cannot outlive the fact it points at (drift guard).
  const ids = new Set(facts.map((c) => c.id));
  for (const c of facts) {
    if (c.seeAlso != null && !ids.has(c.seeAlso)) {
      throw new Error(`curated-fact '${c.id}': seeAlso '${c.seeAlso}' names no existing fact`);
    }
  }
}

module.exports = { checkSpecAnchor, deriveVolatility, applyCuratedNotes, assertCuratedFactsWellFormed };
