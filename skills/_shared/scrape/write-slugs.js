'use strict';

const fs = require('fs');
const path = require('path');

function sanitize(name) {
  return name.replace(/[/\\]/g, '_');
}

function pathForSlug(outRoot, reference, slug) {
  const dir = path.join(outRoot, reference);
  if (slug.startsWith('type:')) {
    const typeName = slug.slice('type:'.length);
    return {
      dir: path.join(dir, 'types'),
      file: `${sanitize(typeName)}.json`,
    };
  }
  return { dir, file: `${sanitize(slug)}.json` };
}

function writeSlug(outRoot, reference, slug, doc) {
  const { dir, file } = pathForSlug(outRoot, reference, slug);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, file);
  fs.writeFileSync(fullPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return fullPath;
}

function writeIndex(outRoot, reference, index) {
  const dir = path.join(outRoot, reference);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, '_index.json');
  fs.writeFileSync(fullPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return fullPath;
}

function writeLanding(outRoot, landingName, doc) {
  const dir = path.join(outRoot, '_landing');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${landingName}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

module.exports = { writeSlug, writeIndex, writeLanding };
