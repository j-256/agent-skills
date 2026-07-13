'use strict';

// Product-neutral auth-provider registry.
//
// An auth provider is a self-contained, non-auto-loaded description of how one
// family of API operations is authenticated. The registry is the single router:
// given a target operation's IDENTITY (area / reference / declared security[] /
// HTTP method / path) it returns the resolved provider -- the auth branch, the
// lightest-sufficient tier, the concrete request-auth shape the renderer emits,
// the token-getting flow, and the per-branch prerequisites (instance-config
// facts the skill can't verify, surfaced only when that branch fires).
//
// This layer knows NOTHING about B2C Commerce. B2C is ONE product whose
// providers live in `b2c-auth-providers.js`; another product's API family would
// register its own provider set and route through this same resolver without
// touching either the generic layer or B2C's data. The design goal (per the
// commerce-auth-matrix design notes): combine code + convention, prefer
// pattern-matching over 1:1 enumeration, keep the metadata rigid and structured
// so the deterministic renderer consumes it optimally and the model chooses
// nothing.
//
// The provider contract (all fields are data, consumed verbatim by the renderer):
//
//   AuthProvider {
//     id:      "b2c-ocapi-shop"                 // unique id, for diagnostics
//     branch:  "ocapi-shop"                     // resolved auth-branch id
//     match:   (context) => boolean             // PATTERN over target identity
//     resolve: (context) => ResolvedAuth        // pick tier + request shape
//   }
//
//   ResolvedAuth {
//     branch, tier, requestAuth:{query,bearer}, token, prerequisites
//   }
//
// Matching is code + convention: a provider's `match` is a predicate (usually a
// regex over reference-family + area), NOT a 1:1 op list -- but a provider MAY
// pin a specific op inside `resolve` when a pattern would be wrong (the OCAPI
// Shop tier boundary is the canonical example: it is NOT derivable from the
// security array, so ocapi-shop curates a proven-public read list rather than
// guessing the tier from scheme shape). Determinism first: branch, tier, token
// URL, request shape, and capture idiom are all metadata; the model never picks.

// Resolve the auth for one target operation against an ordered provider list.
// The FIRST provider whose match() returns true wins -- so callers order
// specific-scheme providers (ShopperToken, AmOAuth2) before family providers
// (ocapi-shop-*, ocapi-data-*), matching the matrix's "reference family first,
// then declared scheme" rule where the two could overlap. Returns the resolved
// auth object, or null when no provider matches (the caller maps that to the
// 'unknown' branch -- plan still composes, just no pre-target auth-step block).
function resolveAuthProvider({ context, providers } = {}) {
  if (!context || !Array.isArray(providers)) return null;
  for (const provider of providers) {
    if (typeof provider.match !== 'function' || typeof provider.resolve !== 'function') continue;
    if (!provider.match(context)) continue;
    const resolved = provider.resolve(context);
    if (!resolved) continue;
    // Normalize the shape so every consumer can rely on the same fields being
    // present regardless of how terse a provider's resolve() was.
    return {
      providerId: provider.id,
      branch: resolved.branch != null ? resolved.branch : provider.branch,
      tier: resolved.tier != null ? resolved.tier : null,
      requestAuth: {
        query: (resolved.requestAuth && resolved.requestAuth.query) || {},
        bearer: !!(resolved.requestAuth && resolved.requestAuth.bearer),
      },
      token: resolved.token != null ? resolved.token : null,
      prerequisites: Array.isArray(resolved.prerequisites) ? resolved.prerequisites : [],
    };
  }
  return null;
}

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

module.exports = { resolveAuthProvider, checkSpecAnchor, deriveVolatility, applyCuratedNotes };
