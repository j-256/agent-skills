'use strict';

// Hand-curated synonym/acronym map for catalog-PRESENT products. Sister file
// to aliases.js -- this layer covers community jargon that the auto-derive
// pass (extract-keys.js) can't reach because the strings don't appear in
// catalog OR landing data:
//
//   - "SCAPI"      -- Salesforce-internal jargon for "B2C Commerce API"
//   - "MIAW"       -- community shorthand for "Messaging for In-App and Web API"
//   - "cquotient"  -- community term for the Einstein activity tracking host
//                     (api.cquotient.com); maps to "B2C Commerce Einstein API"
//   - "Data Cloud" -- pre-rebrand name for "Data 360 Connect REST API"
//
// Match contract: lowercase the user hint, then substring-match against keys.
// The cascade prose in each consuming SKILL.md describes this surface.
//
// Schema:
//   key   -- lowercased user-hint substring (string)
//   value -- productTitle (string) matching a `title` in `_catalog.json`
//
// URL-shaped entries do NOT belong here -- they live in aliases.js (the
// catalog-MISSING fallback). test-catalog-keys.js enforces the split.
//
// Drift handling: live test (DSC_LIVE_TESTS=1) confirms each productTitle
// still resolves against the live `/docs/apis` catalog.

const CATALOG_KEYS = {
  'scapi':       'B2C Commerce API',
  'miaw':        'Messaging for In-App and Web API',
  'cquotient':   'B2C Commerce Einstein API',
  'data cloud':  'Data 360 Connect REST API',
};

module.exports = { CATALOG_KEYS };
