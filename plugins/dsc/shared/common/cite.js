'use strict';

class CitationMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CitationMissingError';
  }
}

function citeEnvelope(envelope) {
  if (envelope == null || typeof envelope !== 'object') {
    throw new CitationMissingError(`citeEnvelope: expected a slug envelope object, got ${typeof envelope}`);
  }
  const url = envelope.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new CitationMissingError(
      `citeEnvelope: envelope has no url field (reference=${envelope.reference || '?'}, slug=${envelope.slug || '?'})`,
    );
  }
  return url;
}

module.exports = { citeEnvelope, CitationMissingError };
