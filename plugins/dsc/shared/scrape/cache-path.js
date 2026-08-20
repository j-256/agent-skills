'use strict';

const path = require('node:path');

function cacheSegment(value, label = 'cache path segment') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function cachePath(root, ...segments) {
  return path.join(root, ...segments.map((segment) => cacheSegment(segment)));
}

function slugFilename(slug) {
  if (typeof slug !== 'string' || slug.length === 0 || slug.includes('\0')) {
    throw new Error(`Invalid slug: ${JSON.stringify(slug)}`);
  }
  return `${slug.replace(/[/\\]/g, '_')}.json`;
}

module.exports = { cachePath, cacheSegment, slugFilename };
