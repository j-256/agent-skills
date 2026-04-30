'use strict';

const assert = require('node:assert/strict');
const { citeEnvelope, CitationMissingError } = require('../cite.js');

// Happy path: envelope has a url field.
const envelope = {
  kind: 'endpoint',
  reference: 'shopper-baskets',
  slug: 'createBasket',
  url: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket',
};
assert.equal(
  citeEnvelope(envelope),
  'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket',
);

// Missing url: should throw a named error the caller can catch by type.
const broken = { kind: 'endpoint', reference: 'x', slug: 'y' };
assert.throws(
  () => citeEnvelope(broken),
  (err) => err instanceof CitationMissingError && /no url/i.test(err.message),
);

// Non-string url: still throws (defensive).
const weird = { kind: 'endpoint', reference: 'x', slug: 'y', url: 42 };
assert.throws(
  () => citeEnvelope(weird),
  (err) => err instanceof CitationMissingError,
);

// Empty-string url: throws.
const empty = { kind: 'endpoint', reference: 'x', slug: 'y', url: '' };
assert.throws(
  () => citeEnvelope(empty),
  (err) => err instanceof CitationMissingError,
);

// Non-object input: throws.
assert.throws(() => citeEnvelope(null), (err) => err instanceof CitationMissingError);
assert.throws(() => citeEnvelope(undefined), (err) => err instanceof CitationMissingError);
assert.throws(() => citeEnvelope('oops'), (err) => err instanceof CitationMissingError);

console.log('ok');
