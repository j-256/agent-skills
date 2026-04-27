'use strict';

const DSC_HOST = 'developer.salesforce.com';

function classifyUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: 'decline', reason: `Not a valid URL: ${rawUrl}` };
  }

  if (u.hostname === 'docs.mulesoft.com') {
    return {
      kind: 'decline',
      reason: 'MuleSoft docs (docs.mulesoft.com) are a separate platform. Out of scope.',
    };
  }

  if (u.hostname !== DSC_HOST) {
    return {
      kind: 'decline',
      reason: `Not a developer.salesforce.com URL (got ${u.hostname}).`,
    };
  }

  const path = u.pathname;

  if (/\/atlas\./.test(path) || path.endsWith('.htm')) {
    return {
      kind: 'decline',
      reason: 'Atlas-format DSC book (e.g. /docs/atlas.*.htm). These use a different viewer without RAML/OAS custom elements. Out of scope.',
    };
  }

  const refIdx = path.indexOf('/references');
  if (refIdx === -1) {
    return {
      kind: 'decline',
      reason: 'URL has no /references/ segment. This skill only handles reference pages under developer.salesforce.com/docs/.../references/.',
    };
  }

  const afterRef = path.slice(refIdx + '/references'.length);

  if (afterRef === '' || afterRef === '/') {
    return { kind: 'catalog', url: rawUrl, referencesPath: path };
  }

  const parts = afterRef.replace(/^\//, '').split('/');

  if (parts.length === 1) {
    const meta = u.searchParams.get('meta');
    if (meta && meta !== 'Summary') {
      return {
        kind: 'slug',
        url: rawUrl,
        reference: parts[0],
        slug: meta,
        referencePageUrl: `https://${DSC_HOST}${path}?meta=Summary`,
      };
    }
    return {
      kind: 'reference-root',
      url: rawUrl,
      reference: parts[0],
      referencePageUrl: `https://${DSC_HOST}${path}?meta=Summary`,
    };
  }

  if (parts.length >= 2 && parts[parts.length - 1].endsWith('.html')) {
    return { kind: 'landing', url: rawUrl, referencesPath: path };
  }

  return {
    kind: 'decline',
    reason: `Unrecognized /references/ URL shape: ${path}`,
  };
}

module.exports = { classifyUrl };
