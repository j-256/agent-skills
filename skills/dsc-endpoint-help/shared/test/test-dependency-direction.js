'use strict';

// Framework/tenant boundary guard: no file under engine/ or common/ may require
// from products/. The framework must never depend on a tenant (that inversion is
// the exact thing the product-first layout exists to forbid). Product files
// depending on engine/common is fine; this test only bites the wrong direction.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sharedRoot = path.join(__dirname, '..');
const guardedDirs = ['engine', 'common'];
const offenders = [];

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const src = fs.readFileSync(full, 'utf8');
    // any require string that reaches into products/
    if (/require\([^)]*products\//.test(src)) {
      offenders.push(path.relative(sharedRoot, full));
    }
  }
}

for (const d of guardedDirs) {
  const abs = path.join(sharedRoot, d);
  if (fs.existsSync(abs)) scan(abs);
}

assert.deepEqual(offenders, [],
  `engine/ and common/ must not require products/. Offenders: ${offenders.join(', ')}`);

console.log('ok');
