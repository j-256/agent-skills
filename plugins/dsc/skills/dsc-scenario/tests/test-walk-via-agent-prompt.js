'use strict';

const assert = require('node:assert/strict');
const { walkViaAgentPrompt } = require('../scripts/walk-types.js');

// Happy path: template variables substituted, base text preserved.
{
  const prompt = walkViaAgentPrompt({
    targetSlug: 'createOrder',
    reference: 'shopper-orders',
    cacheRoot: '/home/x/.cache/dsc-scrape',
  });
  assert.match(prompt, /targetSlug: createOrder/);
  assert.match(prompt, /reference:  shopper-orders/);
  assert.match(prompt, /cacheRoot:  \/home\/x\/\.cache\/dsc-scrape/);
  // Core instructions present.
  assert.match(prompt, /Never invent a producer/);
  assert.match(prompt, /JSON only, no prose/);
  // No leftover placeholders.
  assert.ok(!/\{\{TARGET_SLUG\}\}/.test(prompt));
  assert.ok(!/\{\{REFERENCE\}\}/.test(prompt));
  assert.ok(!/\{\{CACHE_ROOT\}\}/.test(prompt));
}

// Every call produces the same prompt shape for the same inputs.
{
  const a = walkViaAgentPrompt({ targetSlug: 'x', reference: 'y', cacheRoot: '/z' });
  const b = walkViaAgentPrompt({ targetSlug: 'x', reference: 'y', cacheRoot: '/z' });
  assert.equal(a, b);
}

// Missing inputs throw.
assert.throws(() => walkViaAgentPrompt({}), /targetSlug/);
assert.throws(() => walkViaAgentPrompt({ targetSlug: 'x' }), /reference/);
assert.throws(() => walkViaAgentPrompt({ targetSlug: 'x', reference: 'y' }), /cacheRoot/);

console.log('ok');
