'use strict';

const DSC_BASE = 'https://developer.salesforce.com';

const ENTITY = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeEntities(s) {
  return s.replace(/&(?:quot|amp|lt|gt|apos|#39);/g, (m) => ENTITY[m]);
}

function absolutize(href) {
  if (!href) return null;
  if (/^https?:\/\//.test(href)) return href;
  return DSC_BASE + href;
}

function classifyReferenceHref(href) {
  if (typeof href !== 'string') return 'unknown';
  if (/\/atlas\./.test(href) || href.endsWith('.htm')) return 'atlas';
  if (/\.html$/.test(href)) return 'static-html';
  if (/\/references\/?$/.test(href)) return 'area-landing';
  if (/\/references\/[^/]+$/.test(href)) return 'reference-root';
  return 'unknown';
}

function parseApiCatalog(html) {
  const decoded = decodeEntities(html);
  const seen = new Set();
  const products = [];

  const re = /\{"title":"([^"]+?)","body":"([^"]+?)","href":"(\/docs\/[^"]+?)","overviewHref":"([^"]+?)","guidesHref":"([^"]+?)","referenceHref":"([^"]+?)"\}/g;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    const referenceHref = m[6];
    if (seen.has(referenceHref)) continue;
    seen.add(referenceHref);
    products.push({
      title: m[1],
      body: m[2],
      overviewUrl: absolutize(m[4]),
      guidesUrl: absolutize(m[5]),
      referenceUrl: absolutize(referenceHref),
      referenceShape: classifyReferenceHref(referenceHref),
    });
  }

  return products;
}

module.exports = { parseApiCatalog };
