import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export function outputPath(root, description) {
  let options;
  try {
    options = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, output: { type: 'string' } } }).values;
  } catch (error) {
    console.error(`${error.message}; see --help`);
    process.exit(2);
  }
  if (options.help) {
    console.log(`Usage: npm --prefix tools/cover run capture -- [--output FILE]\n\n${description}\n\nInstall capture dependencies with npm ci --prefix tools/cover, then\nnpm exec --prefix tools/cover -- playwright install chromium.\nDefault output: docs/screenshots/cover.png\nExit status: 0 success, 1 capture failure, 2 usage, 3 missing dependency.`);
    process.exit(0);
  }
  return resolve(root, options.output ?? 'docs/screenshots/cover.png');
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export async function capture({ output, html, url, ready, setup, viewport = { width: 1440, height: 960 }, colorScheme = 'dark' }) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.error('Missing capture dependencies; run npm ci --prefix tools/cover'); process.exit(3); }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    if (setup) await setup(page);
    if (html !== undefined) await page.setContent(html);
    else await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    if (errors.length) throw new Error(errors.join('\n'));
    await mkdir(dirname(output), { recursive: true });
    await page.screenshot({ path: output, animations: 'disabled' });
    console.log(`Captured ${output}`);
  } finally { await browser.close(); }
}

export function terminalHtml(title, command, output) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    * { box-sizing: border-box } body { margin: 0; padding: 50px; background: #11141a; color: #e4e9ee; font: 18px/1.55 monospace }
    main { border: 1px solid #303640; border-radius: 12px; overflow: hidden; background: #181c24 }
    header { padding: 13px 24px; border-bottom: 1px solid #303640; color: #9ca7b5; font-size: 15px }
    pre { padding: 26px 30px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere }
    .command { color: #92c5fc; padding-bottom: 0 }
    </style><main><header>${escapeHtml(title)}</header><pre class="command">$ ${escapeHtml(command)}</pre><pre id="output">${escapeHtml(output)}</pre></main>`;
}
