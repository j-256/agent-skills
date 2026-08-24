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
// providers live in `products/commerce-b2c/auth-providers.js`; another product's API family would
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

module.exports = { resolveAuthProvider };
