'use strict';

class RequestParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestParseError';
  }
}

function parseUrlParts(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new RequestParseError(`parseRequest: invalid URL: ${urlString}`);
  }
  const query = Object.fromEntries(u.searchParams.entries());
  return { url: urlString, path: u.pathname, query };
}

function extractToken(headers) {
  const auth = headers['authorization'];
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

// --- Strategy 1: method + url object
function parseMethodUrlPair(input) {
  const { method, url } = input;
  if (typeof method !== 'string' || typeof url !== 'string') {
    throw new RequestParseError('parseRequest: object input requires {method, url} as strings');
  }
  const parts = parseUrlParts(url);
  return {
    method: method.toUpperCase(),
    url: parts.url,
    path: parts.path,
    query: parts.query,
    headers: {},
    body: null,
    token: null,
  };
}

// --- Strategy 2: raw HTTP request
function looksLikeRawHttp(s) {
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d(\.\d)?/i.test(s);
}

function parseRawHttp(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const splitIdx = normalized.indexOf('\n\n');
  const headerBlock = splitIdx >= 0 ? normalized.slice(0, splitIdx) : normalized;
  const body = splitIdx >= 0 ? normalized.slice(splitIdx + 2) : '';

  const lines = headerBlock.split('\n');
  const requestLine = lines.shift();
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+HTTP\/\d(\.\d)?$/i.exec(requestLine.trim());
  if (!m) throw new RequestParseError(`parseRequest: malformed request line: ${requestLine}`);
  const method = m[1].toUpperCase();
  const requestTarget = m[2];

  const headerEntries = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) throw new RequestParseError(`parseRequest: malformed header: ${line}`);
    const k = line.slice(0, colon).trim().toLowerCase();
    const v = line.slice(colon + 1).trim();
    headerEntries.set(k, v);
  }

  const headers = Object.fromEntries(headerEntries);

  let url;
  if (/^https?:\/\//i.test(requestTarget)) {
    url = requestTarget;
  } else {
    const host = headers['host'];
    if (!host) throw new RequestParseError('parseRequest: raw HTTP request missing Host header');
    url = `https://${host}${requestTarget}`;
  }
  const parts = parseUrlParts(url);

  return {
    method,
    url: parts.url,
    path: parts.path,
    query: parts.query,
    headers,
    body: body.length > 0 ? body : null,
    token: extractToken(headers),
  };
}

// --- Strategy 3: cURL command line
// Tokenize a cURL command into args, respecting single quotes, double quotes,
// and backslash-newline continuations.
function tokenizeCurl(src) {
  const s = src.replace(/\\\r?\n/g, ' ').trim();
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let buf = '';
      while (j < s.length && s[j] !== quote) {
        if (s[j] === '\\' && j + 1 < s.length && quote === '"') {
          buf += s[j + 1]; j += 2;
        } else {
          buf += s[j]; j++;
        }
      }
      if (j >= s.length) throw new RequestParseError('parseRequest: unterminated quote in cURL');
      out.push(buf);
      i = j + 1;
    } else {
      let j = i;
      let buf = '';
      while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== "'" && s[j] !== '"') {
        buf += s[j]; j++;
      }
      out.push(buf);
      i = j;
    }
  }
  return out;
}

function parseCurl(src) {
  const args = tokenizeCurl(src);
  if (args[0] !== 'curl') throw new RequestParseError('parseRequest: not a cURL command');

  let method = null;
  let url = null;
  const headerEntries = new Map();
  let body = null;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--request') {
      method = (args[++i] || '').toUpperCase();
    } else if (a === '-H' || a === '--header') {
      const h = args[++i] || '';
      const colon = h.indexOf(':');
      if (colon !== -1) {
        headerEntries.set(
          h.slice(0, colon).trim().toLowerCase(),
          h.slice(colon + 1).trim(),
        );
      }
    } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-urlencode') {
      body = args[++i] || '';
      if (method === null) method = 'POST';
    } else if (a === '-G' || a === '--get') {
      method = 'GET';
    } else if (a.startsWith('-')) {
      // Known cURL flags that take a value. We skip the value so it isn't
      // mistaken for a URL. If we guess wrong about an unknown flag, we'd
      // rather miss its value than accidentally swallow a URL – so we use
      // an allowlist rather than a "looks like a URL?" heuristic.
      const valueFlags = new Set([
        '-A', '--user-agent',
        '-b', '--cookie',
        '-c', '--cookie-jar',
        '-e', '--referer',
        '-o', '--output',
        '-u', '--user',
        '--cacert',
        '--cert',
        '--connect-timeout',
        '--key',
        '--max-time',
        '--proxy', '-x',
        '--proxy-user',
        '--resolve',
      ]);
      if (valueFlags.has(a) && i + 1 < args.length) i++;
      // All other unrecognized flags: ignore, don't consume a value.
    } else {
      if (url === null) url = a;
    }
  }

  if (url === null) throw new RequestParseError('parseRequest: cURL command has no URL');
  if (method === null) method = 'GET';

  const headers = Object.fromEntries(headerEntries);
  const parts = parseUrlParts(url);
  return {
    method,
    url: parts.url,
    path: parts.path,
    query: parts.query,
    headers,
    body,
    token: extractToken(headers),
  };
}

function parseRequest(input) {
  if (input == null) throw new RequestParseError('parseRequest: input was null/undefined');

  if (typeof input === 'object') return parseMethodUrlPair(input);

  if (typeof input !== 'string') {
    throw new RequestParseError('parseRequest: expected string or {method, url} object');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) throw new RequestParseError('parseRequest: empty input');

  if (trimmed.startsWith('curl ') || trimmed.startsWith('curl\t')) return parseCurl(trimmed);
  if (looksLikeRawHttp(trimmed)) return parseRawHttp(trimmed);

  throw new RequestParseError(
    'parseRequest: input does not look like a cURL command or raw HTTP request – pass {method, url} instead',
  );
}

module.exports = { parseRequest, RequestParseError };
