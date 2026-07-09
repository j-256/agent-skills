'use strict';

// Runnable cURL-block renderer (product-neutral). Composes, in order: a header
// (shebang, `set -euo pipefail`, jq preflight, and a TOP fill-in block of the
// connection values the user must supply), the deterministic auth preamble
// (delegated to renderAuthPreamble -- the B2C token-acquisition shell lives
// there, never here), and one block per plan step. Every shell var is named
// through the shared shellVar helper so one convention (snake NAMES_LIKE_THIS)
// is emitted everywhere. The fill-in block is derived by scanning the composed
// body for referenced-minus-assigned vars, so a var a producer/auth capture
// assigns (ACCESS_TOKEN, BASKET_ID, ...) drops out automatically.

const { renderAuthPreamble } = require('../lib/b2c-auth-render.js');
const { shellVar, interpolatePath } = require('../lib/shell-vars.js');

// Derive the connection/environment vars the user must supply: every ${VAR}
// referenced in the fully-composed runnable MINUS every VAR the script itself
// assigns (VAR=... at line start). Correct-by-construction only once the auth
// preamble renders -- before that, ACCESS_TOKEN's producer was model-prose the
// scan couldn't see, so it would wrongly appear as a fill-in. First-appearance
// order, deduped.
function scanFillInVars(body) {
  const referenced = [];
  const seen = new Set();
  const refRe = /\$\{([A-Z0-9_]+)\}/g;
  let m;
  while ((m = refRe.exec(body)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); referenced.push(m[1]); }
  }
  const assigned = new Set();
  const asgRe = /^([A-Z0-9_]+)=/gm;
  while ((m = asgRe.exec(body)) !== null) assigned.add(m[1]);
  return referenced.filter((v) => !assigned.has(v));
}

// Trailing-comment hints for the fill-in block. Unknown vars fall back to the
// generic phrase (the old legend's "supply from your environment").
const VAR_HINTS = {
  BASE_URL: 'your instance API base, e.g. https://<short-code>.api.commercecloud.salesforce.com',
  ORGANIZATION_ID: 'your org id, e.g. f_ecom_abcd_001',
  SITE_ID: 'your site id, e.g. RefArch',
  CLIENT_ID: 'your SLAS/OCAPI client id',
  CLIENT_SECRET: 'your SLAS private client secret',
  REDIRECT_URI: 'a redirect URI registered on the client',
  CHANNEL_ID: 'the channel id (typically equals SITE_ID)',
  SHOPPER_USER: 'registered shopper username',
  SHOPPER_PASS: 'registered shopper password',
  IDP_NAME: 'your federated IDP name (the hint value)',
  AUTH_CODE: 'the code= value from the browser redirect (federated login)',
  LOGIN_ID: 'the registered shopper login id (TSOB)',
  IDP_ORIGIN: 'the IDP origin (TSOB)',
  AM_CLIENT_ID: 'your Account Manager client id',
  AM_CLIENT_SECRET: 'your Account Manager client secret',
  AM_TENANT: 'your realm/tenant, e.g. abcd_001 (from the org id f_ecom_<realm>)',
};

function fillInHint(v) {
  return VAR_HINTS[v] || 'supply from your environment (no structural producer found)';
}

function renderCurlBlock({ plan }) {
  // 1. Auth preamble (deterministic; may be null for the unknown branch).
  const preamble = renderAuthPreamble(plan);

  // 2. Body: header comment + auth preamble + one block per step.
  const body = [];
  body.push(`# Reproduce: ${plan.targetSlug} (reference: ${plan.reference})`);
  body.push(`# Combined scopes required: ${plan.combinedScopes.join(', ')}`);
  body.push('');
  if (preamble) { body.push(...preamble.lines); }

  for (const step of plan.steps) {
    const stem = shellVar(step.slug);
    const respVar = `${stem}_RESPONSE`;

    body.push(`# ${step.method} ${step.path}  -- ${step.slug}`);
    body.push(`# Spec: ${step.specUrl}`);

    // Curated submittability body: when this producer step is annotated by the
    // submittability registry, its request body must be populated beyond the
    // FK-threading minimum for the downstream target to ACCEPT the produced
    // resource (e.g. createBasket must carry items/shipping/billing/payment or
    // createOrder rejects the basket). This is curated runtime knowledge, NOT in
    // the spec -- so it's rendered with an explicit business-rule banner + the
    // provenance citation, never passed off as spec-derived. The fields come from
    // the registry's bodyContents (body-property names + their failure modes),
    // not from a separate grafted populate step (that would be over-decomposition).
    const submittableBody = step.submittableBody;
    if (submittableBody && Array.isArray(submittableBody.bodyContents) && submittableBody.bodyContents.length) {
      body.push(`# \u26A0 Checkout business-rule (curated), NOT stated in the spec: ${submittableBody.typeName} must be populated`);
      body.push('#   below for the target to accept it. The spec enumerates no required-set; this is');
      body.push('#   curated runtime knowledge. Provenance:');
      body.push(`#   ${submittableBody.provenance}`);
      for (const c of submittableBody.bodyContents) {
        body.push(`#   - ${c.field}: ${c.why}`);
      }
    }

    const interpolatedPath = interpolatePath(step.path);
    // Per-reference URL prefix from the step's basePath (e.g. /checkout/widgets/v2).
    // Run through interpolatePath so an OCAPI basePath's {siteId} segment becomes
    // ${SITE_ID}, consistent with how path params are interpolated. Absent basePath
    // -> '' -> URL unchanged.
    const basePath = interpolatePath(step.basePath || '');
    // Request-auth query params (OCAPI's client_id floor). requestAuth is set by
    // compose from the family-aware auth provider: OCAPI steps carry
    // {client_id:'$CLIENT_ID'}, SCAPI steps carry {} (no query param). Values are
    // shell var refs ('$CLIENT_ID') -> render as ${CLIENT_ID}. Absent requestAuth
    // (older/hand-authored plans) degrades to no query string, unchanged behavior.
    const authQuery = (step.requestAuth && step.requestAuth.query) || {};
    const queryString = Object.entries(authQuery)
      .map(([k, v]) => `${k}=${String(v).replace(/^\$(\w+)$/, '${$1}')}`)
      .join('&');
    const url = `\${BASE_URL}${basePath}${interpolatedPath}${queryString ? `?${queryString}` : ''}`;
    // Bearer header: sent unless the tier is explicitly token-less (OCAPI Tier 1,
    // client_id-only public reads). requestAuth.bearer defaults truthy for every
    // pre-existing plan shape, so SCAPI and OCAPI Tier 2 are unchanged.
    const sendBearer = !step.requestAuth || step.requestAuth.bearer !== false;
    const curl = [
      `${respVar}=$(curl -sS -X ${step.method} \\`,
      `  "${url}" \\`,
      ...(sendBearer ? ['  -H "Authorization: Bearer ${ACCESS_TOKEN}" \\'] : []),
      '  -H "Content-Type: application/json"',
    ];
    // If any body field is required, stub it with a JSON placeholder. Skip
    // unnamed fields: a from-bridge body input whose producer family has no
    // dominant path id arrives with name=null (needsNaming), and a stub keyed
    // by null would render a bogus `{"null":"<null>"}` body.
    const bodyFields = step.requiredInputs.filter((i) => i.in === 'body' && i.name);
    const stub = {};
    for (const f of bodyFields) stub[f.name] = `<${f.name}>`;
    // Layer the curated submittable-body fields on top of the spec-required ones.
    // Each curated field is a body property the downstream target needs populated
    // (productItems, shipments[].shippingMethod, billingAddress, paymentInstruments,
    // ...). A bracketed/dotted field name denotes nested/array structure, so it is
    // rendered as a `<field>` placeholder comment-keyed by its raw name rather than
    // forced into a flat JSON key. Flat names go straight into the stub object.
    if (submittableBody && Array.isArray(submittableBody.bodyContents)) {
      for (const c of submittableBody.bodyContents) {
        if (!c || !c.field) continue;
        if (/[.\[\]]/.test(c.field)) continue; // nested/array path -> covered by the banner above
        stub[c.field] = `<${c.field}>`;
      }
    }
    if (Object.keys(stub).length > 0) {
      curl[curl.length - 1] += ' \\';
      curl.push(`  -d '${JSON.stringify(stub)}'`);
    }
    curl[curl.length - 1] += ')';
    body.push(curl.join('\n'));
    body.push('');

    // Extract any IDs this step produces that a later step needs -- shellVar for
    // the var name (snake), jq on the field. A null/empty field means the bridge
    // producer's family had no dominant path id (the walker set needsNaming); skip
    // it rather than emitting a bogus `NULL=$(... jq -r .null)`. compose already
    // strips those null-viaField inputs out of idPassing, so this skip is
    // belt-and-suspenders; the human-readable note for that case is emitted below
    // off the consumer step's surviving from-bridge input, not from idPassing.
    const producedFields = new Set();
    for (const entry of plan.idPassing) {
      for (const i of entry.inputs) {
        if (i.from !== step.slug || !i.field) continue;
        producedFields.add(i.field);
      }
    }
    for (const field of producedFields) {
      const varName = shellVar(field);
      body.push(`${varName}=$(echo "$${respVar}" | jq -r .${field})`);
    }

    // Missing-id-field note. A from-bridge body input the walker couldn't name
    // (needsNaming -- the producer reference's family addresses nothing by id)
    // survives on THIS (consumer) step's requiredInputs even after compose
    // strips the null viaField from idPassing. So drive the note off that
    // surviving input rather than idPassing, which is empty on the real
    // degraded flow. Name the producer from the step's structural evidence (the
    // null-viaField producer edge) so the note points at the response to read.
    const unnamedBridge = step.requiredInputs.some(
      (i) => i.in === 'body' && i.fromBridge && i.needsNaming && !i.name,
    );
    let emittedNote = false;
    if (unnamedBridge) {
      const producerEv = (step.evidence || []).find((e) => e.producer && !e.viaField);
      const producer = producerEv ? producerEv.producer : 'the producer step';
      body.push(`# (no dominant id field on ${producer}'s reference; supply its id from the ${producer} response above manually)`);
      emittedNote = true;
    }
    if (producedFields.size > 0 || emittedNote) body.push('');
  }

  const bodyStr = body.join('\n');

  // 3. Fill-in block: referenced-minus-assigned over the WHOLE body (auth
  //    preamble included, which is why ACCESS_TOKEN correctly drops out when a
  //    token leg produces it).
  const fillVars = scanFillInVars(bodyStr);

  // 4. Header: shebang, set, jq preflight, then the fill-in block.
  const head = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }',
    '',
  ];
  if (fillVars.length) {
    head.push('# ---- Fill in your connection values ----');
    for (const v of fillVars) head.push(`${v}=""              # ${fillInHint(v)}`);
    const guards = fillVars.map((v) => `"\${${v}:?fill in ${v} above}"`).join(' ');
    head.push(`: ${guards}`);
    head.push('');
  }

  return `${[...head, bodyStr].join('\n')}\n`;
}

module.exports = { renderCurlBlock, scanFillInVars };
