'use strict';

const fs = require('fs');
const { cachePath, slugFilename } = require('./cache-path.js');

function referenceDir(outRoot, area, reference) {
  return cachePath(outRoot, area, reference);
}

function pathForSlug(outRoot, area, reference, slug) {
  const dir = referenceDir(outRoot, area, reference);
  if (slug.startsWith('type:')) {
    const typeName = slug.slice('type:'.length);
    return {
      dir: cachePath(dir, 'types'),
      file: slugFilename(typeName),
    };
  }
  return { dir, file: slugFilename(slug) };
}

function writeSlug(outRoot, area, reference, slug, doc) {
  const { dir, file } = pathForSlug(outRoot, area, reference, slug);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = cachePath(dir, file);
  fs.writeFileSync(fullPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return fullPath;
}

function writeIndex(outRoot, area, reference, index) {
  const dir = referenceDir(outRoot, area, reference);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = cachePath(dir, '_index.json');
  fs.writeFileSync(fullPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return fullPath;
}

function writeLanding(outRoot, landingName, doc) {
  const dir = cachePath(outRoot, '_landing');
  fs.mkdirSync(dir, { recursive: true });
  const file = cachePath(dir, slugFilename(landingName));
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

module.exports = { referenceDir, writeSlug, writeIndex, writeLanding };
