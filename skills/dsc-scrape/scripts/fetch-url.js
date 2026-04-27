'use strict';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchUrl(url, { referer, accept = '*/*' } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': accept,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  if (referer) headers['Referer'] = referer;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  }
  return await res.text();
}

module.exports = { fetchUrl };
