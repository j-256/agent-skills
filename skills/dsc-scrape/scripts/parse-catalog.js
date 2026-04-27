'use strict';

const ATTR_PATTERNS = [
  /\sreference-set-config='([^']+)'/,
  /\sreference-config='([^']+)'/,
];

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

function parseCatalog(html) {
  let raw = null;
  for (const re of ATTR_PATTERNS) {
    const m = html.match(re);
    if (m) {
      raw = m[1];
      break;
    }
  }
  if (!raw) {
    throw new Error('No reference-set-config or reference-config attribute found');
  }

  const decoded = decodeEntities(raw);
  const data = JSON.parse(decoded);
  const refList = Array.isArray(data.refList) ? data.refList : [];

  return refList.map((r) => ({
    id: r.id ?? null,
    title: r.title ?? r.id ?? null,
    source: r.source ?? null,
    amf: r.amf || null,
    href: r.href ?? null,
    referenceType: r.referenceType ?? null,
  }));
}

module.exports = { parseCatalog };
