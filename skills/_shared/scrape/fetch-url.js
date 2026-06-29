'use strict';

// Browser impersonation for developer.salesforce.com fetches. The header set
// must be internally consistent with the request *type*, or it reads as a bot:
// a top-level page load is a navigation (Sec-Fetch-Mode: navigate, Dest:
// document, plus Upgrade-Insecure-Requests + Sec-Fetch-User), while a spec
// fetched by the page's JS is a subresource (Mode: cors, Dest: empty, with a
// Referer). The scraper makes exactly those two shapes: an HTML reference page
// (accept: text/html, no referer) and a spec file (a referer, non-HTML accept).
// Client Hints (sec-ch-ua*) must agree with the UA's Chrome major + platform.
//
// Keep CHROME_MAJOR current: a years-stale version is itself a tell (Chrome/120
// in 2026 screams bot). Chrome's reduced-UA policy freezes every UA token but
// the major version, and the macOS token is pinned at 10_15_7 regardless of the
// real OS -- so refreshing is a one-token edit. Refresh from the current stable
// major, via either source:
//   - Google's Version History API: GET
//     https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions?pageSize=1
//     and take the leading number of the `version` field; or
//   - the locally-installed Chrome's CFBundleShortVersionString.
// A few majors stale is fine -- plenty of real users lag updates; the goal is
// "ordinary", not "bleeding edge". Snapshotted here rather than fetched at
// runtime so the skill stays self-contained (no network/dep just to pick a UA).

const CHROME_MAJOR = '149';
const PLATFORM = '"macOS"';
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
// GREASE brand + the two real brands, the form current Chrome emits.
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not=A?Brand";v="24"`;

// Full navigation Accept string a real Chrome sends for a document request --
// more realistic than "text/html,*/*", and still leads with text/html so server
// content-negotiation returns the same HTML.
const NAV_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

async function fetchUrl(url, { referer, accept = '*/*' } = {}) {
  // A document navigation is the HTML-page case (text/html accept). A spec/XHR
  // subresource is everything else. The scraper's two call sites map cleanly:
  // HTML page -> navigation; spec fetch (with referer) -> subresource.
  const isNavigation = /text\/html/.test(accept) && !referer;

  const headers = {
    // The low-entropy Client Hints Chrome sends unprompted on every request. The
    // high-entropy ones (sec-ch-ua-full-version-list, -arch, -platform-version)
    // are deliberately omitted: a real browser sends those only after the server
    // asks via an Accept-CH response header, so volunteering them unprompted is
    // itself a bot tell. That's also why sec-ch-ua carries only the major version.
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': PLATFORM,
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': UA,
    'Accept': isNavigation ? NAV_ACCEPT : accept,
    'Accept-Language': 'en-US,en;q=0.9',
    // Note: Accept-Encoding is left to undici so it decodes the response itself;
    // setting it manually risks receiving a body undici won't decompress.
  };

  if (isNavigation) {
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none';
    headers['Sec-Fetch-User'] = '?1';
    headers['Priority'] = 'u=0, i';
  } else {
    headers['Sec-Fetch-Dest'] = 'empty';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['Sec-Fetch-Site'] = referer && sameOrigin(referer, url) ? 'same-origin' : 'cross-site';
    headers['Priority'] = 'u=1, i';
    if (referer) headers['Referer'] = referer;
  }

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  }
  return await res.text();
}

module.exports = { fetchUrl };
