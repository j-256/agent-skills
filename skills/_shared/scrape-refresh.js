'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class ScrapeInvocationError extends Error {
  constructor(message, { exitCode = null, stderr = '' } = {}) {
    super(message);
    this.name = 'ScrapeInvocationError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const DEFAULT_SCRIPT = require.resolve('./scrape/scrape.js');
const DEFAULT_CACHE = path.join(os.homedir(), '.cache/dsc-scrape');

function run(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function scrapeRefresh({
  scrapeScript = DEFAULT_SCRIPT,
  referenceUrl,
  cacheRoot = DEFAULT_CACHE,
  force = false,
} = {}) {
  if (typeof referenceUrl !== 'string' || referenceUrl.length === 0) {
    throw new ScrapeInvocationError('scrapeRefresh: referenceUrl is required');
  }
  if (!fs.existsSync(scrapeScript)) {
    throw new ScrapeInvocationError(
      `scrapeRefresh: dsc-scrape script not found at ${scrapeScript} – install the dsc-scrape skill, or pass scrapeScript explicitly.`,
    );
  }

  const args = [referenceUrl, cacheRoot];
  if (force) args.push('--force');

  const { code, stdout, stderr } = await run(scrapeScript, args);
  if (code !== 0) {
    throw new ScrapeInvocationError(
      `scrapeRefresh: dsc-scrape exited ${code}: ${stderr.trim()}`,
      { exitCode: code, stderr },
    );
  }

  let summary;
  try {
    summary = JSON.parse(stdout.trim());
  } catch {
    throw new ScrapeInvocationError(
      `scrapeRefresh: dsc-scrape did not print a JSON summary. stdout: ${stdout.slice(0, 200)}`,
      { exitCode: 0, stderr },
    );
  }

  return {
    refreshed: summary.refreshed === true,
    reference: summary.reference,
    format: summary.format,
    specUrl: summary.specUrl,
    files: Array.isArray(summary.files) ? summary.files : [],
    cacheRoot,
    rawSummary: summary,
  };
}

module.exports = { scrapeRefresh, ScrapeInvocationError };
