'use strict';

// Catalog-missing aliases: products that publish a working `/references/`
// area-landing on developer.salesforce.com but don't appear in the
// `/docs/apis` machine-readable catalog (`_catalog.json`). Without this
// map, the synthesis cascade has no way to resolve a user's natural-language
// hint ("Marketing Cloud Growth", "MCG", "Agentforce") to a URL after the
// catalog fuzzy-match comes up empty – the only fallback would be asking
// the user for a URL they may not know.
//
// Keys are lowercased user-hint substrings. Values are the canonical
// reference-area URL on developer.salesforce.com. Match contract is
// "lowercase the user hint, then substring-match against keys" – the
// cascade prose in each consuming SKILL.md describes this.
//
// URL drift on Salesforce rebrands is the known failure mode. A live-URL
// test (gated behind DSC_LIVE_TESTS=1) confirms each entry still resolves.

const CATALOG_MISSING_ALIASES = {
  'marketing cloud growth': 'https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/references',
  'mcg': 'https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/references',
  'marketing cloud next': 'https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/references',
  'agentforce': 'https://developer.salesforce.com/docs/ai/agentforce/references',
  // NB: 'scapi' is intentionally NOT here -- "B2C Commerce API" (the SCAPI product)
  // IS in the /docs/apis catalog, so it is a catalog-PRESENT synonym and lives in
  // catalog-keys.js. A duplicate here would collide (test-catalog-keys guards it).
  'ocapi': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
  'open commerce api': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
  'b2c-commerce': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
  'b2c commerce ocapi': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
  '/dw/shop': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
  '/dw/data': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
  'x-dw-client-id': 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references',
};

module.exports = { CATALOG_MISSING_ALIASES };
