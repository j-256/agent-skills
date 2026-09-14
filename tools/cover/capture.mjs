import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capture, outputPath, terminalHtml } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = outputPath(root, 'Capture the actual endpoint query against the committed synthetic cache fixture.');
const query = 'plugins/dsc/skills/dsc-endpoint-help/scripts/query.js';
const cache = 'plugins/dsc/skills/dsc-endpoint-help/test/fixtures/fake-cache';
const raw = execFileSync(process.execPath, [query, cache, 'shopper-baskets', 'createBasket', '--field', 'security'], {
  cwd: root, encoding: 'utf8', timeout: 10_000,
});
const result = JSON.parse(raw);
assert.equal(result.found, true);
assert.equal(result.matchedFrom, 'exact');
const text = execFileSync('jq', ['{url, data}'], { input: raw, encoding: 'utf8', timeout: 5000 });
const command = 'node "$QUERY" "$CACHE" shopper-baskets createBasket --field security | jq \'{url, data}\'';
await capture({ output, html: terminalHtml('DSC Endpoint Help / fixture query', command, text), viewport: { width: 1600, height: 1000 },
  async ready(page) {
    await page.getByText('createBasket', { exact: false }).last().waitFor();
    assert.ok((await page.locator('#output').innerText()).includes(result.url));
  },
});
