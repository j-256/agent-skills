'use strict';

// B2C auth-preamble renderer. Emits the token-acquisition shell (PKCE setup,
// authorize/login legs, token exchange, ACCESS_TOKEN capture) that curl-block.js
// prepends to the runnable -- so the whole runnable is deterministic and the
// model relays it verbatim, closing the model-composed-auth seam.
//
// PRODUCT-SPECIFIC (B2C): SLAS URLs, the AM host, the OCAPI capture idiom, PKCE,
// and form-field sets live here, beside b2c-auth-providers.js -- never in the
// product-neutral curl-block.js. The leg CONTRACTS are curated fact (the spec
// states auth params in prose, not schema; see docs/commerce-auth-matrix.md), so
// they are encoded templates here, grounded by an opt-in live test, not read
// from the spec in the render path.
//
// Contract: renderAuthPreamble(plan) -> { lines, sources } | null. null when the
// branch is 'unknown'/absent or the flow data a branch needs is missing (degrade
// to no-preamble rather than emit a half-formed one).

const { pkceShellSnippet } = require('./pkce.js');
const { interpolatePath } = require('./shell-vars.js');
const { amRoleScope } = require('./slas-flows.js');

// SLAS reference basePath -- a stable B2C fact (same category as AM_TOKEN_URL).
// ${ORGANIZATION_ID} is a literal in the string so it interpolates at runtime in
// the emitted bash; single ${BASE_URL} host covers SLAS + checkout (same host).
const SLAS_BASE = '/shopper/auth/v1/organizations/${ORGANIZATION_ID}';
const SLAS_REF_URL = 'https://developer.salesforce.com/docs/commerce/commerce-api/references/auth';

// The canonical DSC citation for a SLAS leg slug.
function slasSource(slug) {
  return `${SLAS_REF_URL}?meta=${slug}`;
}

// --- shared primitives (private) ---

// The two PKCE lines, reused verbatim from pkce.js (single source of the
// 96-byte/128-char form). Returned as an array of physical lines.
function pkceLines() {
  return pkceShellSnippet().split('\n');
}

// Capture the auth code from a 303 Location header (never a JSON body). Emits
// AUTH_LOCATION + AUTH_CODE, and USID when captureUsid. `curlArgs` are extra
// lines placed inside the curl (method, headers, data) for the login variant.
function captureCodeFrom303({ url, curlArgs = [], captureUsid = true }) {
  const lines = [
    `AUTH_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \\`,
    ...curlArgs,
    `  "${url}")`,
    `AUTH_CODE=$(printf '%s' "$AUTH_LOCATION" | grep -oE 'code=[^&]+' | cut -d= -f2)`,
  ];
  if (captureUsid) {
    lines.push(`USID=$(printf '%s' "$AUTH_LOCATION" | grep -oE 'usid=[^&]+' | cut -d= -f2)`);
  }
  return lines;
}

// The token exchange: POST form to `url`, capture ACCESS_TOKEN via jq. formFields
// is an array of "key=value" strings emitted as --data-urlencode lines.
function tokenExchangeLines({ url, formFields, tokenVar = 'ACCESS_TOKEN', respVar = 'TOKEN_RESPONSE' }) {
  const lines = [
    `${respVar}=$(curl -sS -X POST \\`,
    `  "${url}" \\`,
    `  -H "Content-Type: application/x-www-form-urlencoded" \\`,
  ];
  formFields.forEach((f, i) => {
    const last = i === formFields.length - 1;
    lines.push(`  --data-urlencode "${f}"${last ? ')' : ' \\'}`);
  });
  lines.push(`${tokenVar}=$(echo "$${respVar}" | jq -r .access_token)`);
  return lines;
}

// --- branch renderers (private) ---

function renderSlas(plan) {
  const flow = plan.authFlow;
  if (!flow || !Array.isArray(flow.slugs) || flow.slugs.length === 0) return null;
  const lines = [];
  const sources = [];
  const leg1 = flow.slugs[0];
  // Federated IDP = authorizeCustomer with a non-guest hint. That path emits a
  // browser/paste seam and does NOT run captureCodeFrom303, so no ${USID} is
  // captured. Computed at function scope because the shared token leg below must
  // omit usid on this path (an unassigned ${USID} would be promoted by the fill-in
  // scan to an unsatisfiable :? var). Guest + registered-b2c both capture a usid.
  const federated = leg1 !== 'authenticateCustomer' && !!flow.authorizeHint && flow.authorizeHint !== 'guest';

  // tsob: a single client_credentials POST to trusted-system/token. No PKCE, no
  // authorize leg -- a service mints a shopper token on behalf of a login_id.
  if (leg1 === 'getTrustedSystemAccessToken') {
    lines.push('# Auth -- SLAS trusted-system (private client, on behalf of a shopper)');
    lines.push(`# Spec: ${slasSource('getTrustedSystemAccessToken')}`);
    lines.push(
      `TOKEN_RESPONSE=$(curl -sS -X POST \\`,
      `  "\${BASE_URL}${SLAS_BASE}/oauth2/trusted-system/token" \\`,
      `  -H "Authorization: Basic $(printf '%s:%s' "\${CLIENT_ID}" "\${CLIENT_SECRET}" | base64)" \\`,
      `  -H "Content-Type: application/x-www-form-urlencoded" \\`,
      `  --data-urlencode "grant_type=client_credentials" \\`,
      `  --data-urlencode "hint=ts_ext_on_behalf_of" \\`,
      `  --data-urlencode "login_id=\${LOGIN_ID}" \\`,
      `  --data-urlencode "idp_origin=\${IDP_ORIGIN}" \\`,
      `  --data-urlencode "channel_id=\${CHANNEL_ID}")`,
      `ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)`,
      '',
    );
    sources.push(slasSource('getTrustedSystemAccessToken'));
    return { lines, sources };
  }

  // All other SLAS flows are PKCE (public client).
  lines.push('# Auth -- SLAS PKCE (public client)', ...pkceLines(), '');

  if (leg1 === 'authenticateCustomer') {
    // registered-b2c: POST /oauth2/login, shopper Basic header, 4 required params,
    // NO grant_type (that belongs on the /token exchange). 303 capture.
    lines.push('# Auth leg 1 -- authenticateCustomer (registered B2C login)');
    lines.push(`# Spec: ${slasSource('authenticateCustomer')}`);
    lines.push(...captureCodeFrom303({
      url: `\${BASE_URL}${SLAS_BASE}/oauth2/login`,
      curlArgs: [
        `  -X POST \\`,
        `  -H "Authorization: Basic $(printf '%s:%s' "\${SHOPPER_USER}" "\${SHOPPER_PASS}" | base64)" \\`,
        `  -H "Content-Type: application/x-www-form-urlencoded" \\`,
        `  --data-urlencode "code_challenge=\${CODE_CHALLENGE}" \\`,
        `  --data-urlencode "channel_id=\${CHANNEL_ID}" \\`,
        `  --data-urlencode "client_id=\${CLIENT_ID}" \\`,
        `  --data-urlencode "redirect_uri=\${REDIRECT_URI}" \\`,
      ],
    }));
    lines.push('');
    sources.push(slasSource('authenticateCustomer'));
  } else {
    // authorizeCustomer: guest (hint=guest, headless 303) OR federated
    // (hint=${IDP_NAME}, interactive -- code can't be captured headlessly).
    // `federated` is computed at function scope (the token leg needs it too).
    const hint = federated ? '${IDP_NAME}' : 'guest';
    lines.push(`# Auth leg 1 -- authorizeCustomer (hint=${federated ? 'federated IDP' : 'guest'})`);
    lines.push(`# Spec: ${slasSource('authorizeCustomer')}`);
    const authorizeUrl = `\${BASE_URL}${SLAS_BASE}/oauth2/authorize?response_type=code&client_id=\${CLIENT_ID}&redirect_uri=\${REDIRECT_URI}&hint=${hint}&code_challenge=\${CODE_CHALLENGE}&code_challenge_method=S256`;
    if (federated) {
      // Interactive IDP: emit the URL for a human to open, and DO NOT auto-assign
      // AUTH_CODE -- the fill-in scan surfaces it with a :? preflight. A read
      // prompt mid-script is banned (breaks paste-and-run); a fill-in var is the
      // sanctioned seam. Never name the B2C login op here.
      lines.push(`echo "Open this URL in a browser, authenticate at your IDP, then paste the code= value into AUTH_CODE below:"`);
      lines.push(`echo "${authorizeUrl}"`);
      lines.push(`# AUTH_CODE is filled in from the browser redirect (see the fill-in block at the top).`);
    } else {
      lines.push(...captureCodeFrom303({ url: authorizeUrl }));
    }
    lines.push('');
    sources.push(slasSource('authorizeCustomer'));
  }

  // Shared token leg (guest / federated / registered-b2c).
  lines.push('# Auth leg 2 -- getAccessToken (exchange code for a shopper token)');
  lines.push(`# Spec: ${slasSource('getAccessToken')}`);
  lines.push(...tokenExchangeLines({
    url: `\${BASE_URL}${SLAS_BASE}/oauth2/token`,
    formFields: [
      'grant_type=authorization_code_pkce',
      'client_id=${CLIENT_ID}',
      'redirect_uri=${REDIRECT_URI}',
      'code=${AUTH_CODE}',
      'code_verifier=${CODE_VERIFIER}',
      // SLAS requires channel_id on the token request as of 2024-07-31 (getAccessToken
      // description). Without it a guest token 400s "Guest token requires a channel_id
      // parameter". Required for guest, registered-b2c, and federated alike.
      'channel_id=${CHANNEL_ID}',
      // usid is captured from the 303 on guest/registered-b2c (assigned at
      // column 0, so it drops out of the fill-in block). Federated has no 303
      // capture, so sending usid=${USID} would leave it unassigned and the
      // fill-in scan would promote it to an unsatisfiable :? var -- omit it.
      ...(federated ? [] : ['usid=${USID}']),
    ],
  }));
  lines.push('');
  sources.push(slasSource('getAccessToken'));
  return { lines, sources };
}

const AM_AUTHORIZE_URL = 'https://account.demandware.com/dwsso/oauth2/authorize';

// AM app token. private-cc: a single client_credentials POST. public-pkce: PKCE +
// AM authorize + token exchange. The host is absolute (account.demandware.com) --
// never ${BASE_URL}. AM has no DSC reference page (deliberate by Salesforce), so
// AM legs contribute NO source; the plan-list Note is the citation contract.
function renderAm(plan) {
  const flow = plan.authFlow;
  if (!flow || !flow.tokenUrl) return null;
  const lines = [];
  const isPkce = flow.grantType === 'authorization_code_pkce';

  // Scope = tenant role + API scopes (space-joined). Tenant is a fill-in var
  // (${AM_TENANT}); we don't know the instance at render time.
  const apiScopes = Array.isArray(plan.combinedScopes) ? plan.combinedScopes : [];
  const scope = [amRoleScope('${AM_TENANT}'), ...apiScopes].join(' ');

  if (isPkce) {
    lines.push('# Auth -- Account Manager (public client + PKCE)', ...pkceLines(), '');
    lines.push('# Auth leg 1 -- AM authorize');
    lines.push('# Note: Account Manager has no DSC reference page (deliberate by Salesforce).');
    lines.push(...captureCodeFrom303({
      url: `${AM_AUTHORIZE_URL}?response_type=code&client_id=\${AM_CLIENT_ID}&redirect_uri=\${REDIRECT_URI}&code_challenge=\${CODE_CHALLENGE}&code_challenge_method=S256`,
      captureUsid: false,
    }));
    lines.push('');
    lines.push('# Auth leg 2 -- AM token exchange');
    lines.push(...tokenExchangeLines({
      url: flow.tokenUrl,
      formFields: ['grant_type=authorization_code_pkce', 'client_id=${AM_CLIENT_ID}', 'redirect_uri=${REDIRECT_URI}', 'code=${AUTH_CODE}', 'code_verifier=${CODE_VERIFIER}'],
    }));
    lines.push('');
    return { lines, sources: [] };
  }

  // private-cc (default): single client_credentials POST.
  lines.push('# Auth -- Account Manager app token (client_credentials)');
  lines.push('# Note: Account Manager has no DSC reference page (deliberate by Salesforce);');
  lines.push('#   see the auth guide on the consuming reference for setup details.');
  lines.push(
    `TOKEN_RESPONSE=$(curl -sS -X POST \\`,
    `  "${flow.tokenUrl}" \\`,
    `  -H "Authorization: Basic $(printf '%s:%s' "\${AM_CLIENT_ID}" "\${AM_CLIENT_SECRET}" | base64)" \\`,
    `  -H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  --data-urlencode "grant_type=client_credentials" \\`,
    `  --data-urlencode "scope=${scope}")`,
    `ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)`,
    '',
  );
  return { lines, sources: [] };
}

// OCAPI customers/auth: the JWT comes back in the RESPONSE Authorization header,
// not a JSON body -- capture it like the SLAS 303 idiom (dump headers, grep),
// never with jq. url already carries ?client_id=.
function captureJwtFromHeader({ url, body }) {
  return [
    `AUTH_HEADERS=$(curl -sS -D - -o /dev/null -X POST \\`,
    `  "${url}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(body)}')`,
    `ACCESS_TOKEN=$(printf '%s' "$AUTH_HEADERS" | grep -i '^authorization:' | sed 's/^[Aa]uthorization: *[Bb]earer *//' | tr -d '\\r')`,
  ];
}

// Lift the OCAPI shop base (/s/{siteId}/dw/shop/v<ver>) from any sibling step's
// basePath and interpolate {siteId} -> ${SITE_ID}. Falls back to a bare version
// placeholder if no step carries a shop basePath (defensive; every real OCAPI
// shop plan has at least the target step).
function ocapiShopBase(plan) {
  const step = (plan.steps || []).find((s) => s && typeof s.basePath === 'string' && /\/dw\/shop\//.test(s.basePath));
  const base = step ? step.basePath : '/s/{siteId}/dw/shop/v_';
  return interpolatePath(base);
}

function renderOcapiShop(plan) {
  const tier = plan.auth && plan.auth.tier;
  // Tier 1 (client_id only): no token leg at all.
  if (tier === 'client-id') return { lines: [], sources: [] };

  const token = plan.auth && plan.auth.token;
  if (!token || token.flow !== 'ocapi-customers-auth') return null;
  const base = ocapiShopBase(plan);
  const url = `\${BASE_URL}${base}/customers/auth?client_id=\${CLIENT_ID}`;
  const sourceUrl = `https://developer.salesforce.com/docs/commerce/b2c-commerce/references/${token.reference}?meta=${token.slug}`;

  const lines = [
    '# Auth -- OCAPI-native customers/auth (guest JWT in the response Authorization header)',
    `# Spec: ${sourceUrl}`,
    ...captureJwtFromHeader({ url, body: token.body || { type: 'guest' } }),
    '# Registered shopper? change {"type":"guest"} to {"type":"credentials"} and add:',
    `#   -H "Authorization: Basic $(printf '%s:%s' "$SHOPPER_USER" "$SHOPPER_PASS" | base64)"`,
    '',
  ];
  return { lines, sources: [sourceUrl] };
}

function renderOcapiData(plan) {
  const token = plan.auth && plan.auth.token;
  if (!token || token.flow !== 'am-app-token') return null;
  // Identical to AM private-cc but NO tenant scope (OCAPI authz is the BM
  // allowlist; the token's scopes are placeholders per the auth-matrix doc).
  const lines = [
    '# Auth -- Account Manager app token (client_credentials) for OCAPI Data',
    '# Note: Account Manager has no DSC reference page (deliberate by Salesforce).',
    `TOKEN_RESPONSE=$(curl -sS -X POST \\`,
    `  "${token.tokenUrl}" \\`,
    `  -H "Authorization: Basic $(printf '%s:%s' "\${AM_CLIENT_ID}" "\${AM_CLIENT_SECRET}" | base64)" \\`,
    `  -H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  --data-urlencode "grant_type=client_credentials")`,
    `ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)`,
    '',
  ];
  return { lines, sources: [] };
}

function renderAuthPreamble(plan) {
  if (!plan || !plan.authBranch || plan.authBranch === 'unknown') return null;
  switch (plan.authBranch) {
    case 'shopper-slas': return renderSlas(plan);
    case 'am': return renderAm(plan);
    case 'ocapi-shop': return renderOcapiShop(plan);
    case 'ocapi-data': return renderOcapiData(plan);
    default: return null;
  }
}

module.exports = { renderAuthPreamble };
