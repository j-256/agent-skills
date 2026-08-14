'use strict';

const assert = require('node:assert/strict');
const { fetchUrl, validatedUrl } = require('../scrape/fetch-url.js');

assert.equal(validatedUrl('https://developer.salesforce.com/docs/apis').hostname, 'developer.salesforce.com');
assert.throws(() => validatedUrl('http://developer.salesforce.com/docs/apis'), /non-DSC URL/i);
assert.throws(() => validatedUrl('https://developer.salesforce.com.attacker.example/x'), /non-DSC URL/i);
assert.throws(() => validatedUrl('https://127.0.0.1/x'), /non-DSC URL/i);
assert.throws(() => validatedUrl('https://developer.salesforce.com:444/x'), /non-DSC URL/i);

(async () => {
  const originalFetch = globalThis.fetch;
  try {
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      if (requested.length === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://developer.salesforce.com/static/spec.yaml' },
        });
      }
      return new Response('openapi: 3.0.0', { status: 200 });
    };
    const body = await fetchUrl('https://developer.salesforce.com/docs/apis');
    assert.equal(body, 'openapi: 3.0.0');
    assert.deepEqual(requested, [
      'https://developer.salesforce.com/docs/apis',
      'https://developer.salesforce.com/static/spec.yaml',
    ]);

    globalThis.fetch = async () => new Response('', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
    await assert.rejects(
      () => fetchUrl('https://developer.salesforce.com/docs/apis'),
      /non-DSC URL/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
