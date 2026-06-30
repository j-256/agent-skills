'use strict';

// Convert slug -> shell-safe variable stem (e.g., createContainer -> CREATECONTAINER).
function varStem(slug) {
  return slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// Convert a templated path (/containers/{containerId}/items/{itemId}) into a
// shell-interpolating string (/containers/${CONTAINERID}/items/${ITEMID}).
// Every {name} becomes ${NAME}; the legend at the bottom of the block
// notes which of those have no structural producer.
function interpolatePath(templatePath) {
  return templatePath.replace(/\{([^}]+)\}/g, (_m, name) => `\${${name.toUpperCase()}}`);
}

function renderCurlBlock({ plan }) {
  const lines = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('set -euo pipefail');
  lines.push('');
  lines.push(`# Reproduce: ${plan.targetSlug} (reference: ${plan.reference})`);
  lines.push(`# Combined scopes required: ${plan.combinedScopes.join(', ')}`);
  lines.push('');

  const boundVars = new Set();

  for (const step of plan.steps) {
    const stem = varStem(step.slug);
    const respVar = `${stem}_RESPONSE`;

    lines.push(`# ${step.method} ${step.path}  – ${step.slug}`);
    lines.push(`# Spec: ${step.specUrl}`);

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
      lines.push(`# ⚠ Checkout business-rule (curated), NOT stated in the spec: ${submittableBody.typeName} must be populated`);
      lines.push('#   below for the target to accept it. The spec enumerates no required-set; this is');
      lines.push('#   curated runtime knowledge. Provenance:');
      lines.push(`#   ${submittableBody.provenance}`);
      for (const c of submittableBody.bodyContents) {
        lines.push(`#   - ${c.field}: ${c.why}`);
      }
    }

    const interpolatedPath = interpolatePath(step.path);
    // Per-reference URL prefix from the step's basePath (e.g. /checkout/widgets/v2).
    // Run through interpolatePath so an OCAPI basePath's {siteId} segment becomes ${SITEID},
    // consistent with how path params are interpolated. Absent basePath -> '' -> URL unchanged.
    const basePath = interpolatePath(step.basePath || '');
    const curl = [
      `${respVar}=$(curl -sS -X ${step.method} \\`,
      `  "\${BASE_URL}${basePath}${interpolatedPath}" \\`,
      '  -H "Authorization: Bearer ${ACCESS_TOKEN}" \\',
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
    lines.push(curl.join('\n'));
    lines.push('');

    // Extract any IDs this step produces that a later step needs.
    // Look at consumers in idPassing whose `from` is this step. A null/empty
    // field means the bridge producer's family had no dominant path id (the
    // walker set needsNaming) -- skip it rather than emitting a bogus
    // `NULL=$(... jq -r .null)`. compose already strips those null-viaField
    // inputs out of idPassing, so this skip is belt-and-suspenders; the
    // human-readable note for that case is emitted below off the consumer
    // step's surviving from-bridge input, not from idPassing.
    const producedFields = new Set();
    for (const entry of plan.idPassing) {
      for (const i of entry.inputs) {
        if (i.from !== step.slug) continue;
        if (!i.field) continue;
        producedFields.add(i.field);
      }
    }
    for (const field of producedFields) {
      const varName = field.toUpperCase();
      lines.push(`${varName}=$(echo "$${respVar}" | jq -r .${field})`);
      boundVars.add(varName);
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
      lines.push(`# (no dominant id field on ${producer}'s reference; supply its id from the ${producer} response above manually)`);
      emittedNote = true;
    }
    if (producedFields.size > 0 || emittedNote) lines.push('');
  }

  // Legend.
  lines.push('# ----------------------------------------------------------');
  lines.push('# Placeholders:');
  lines.push('#   BASE_URL:      your instance base URL, e.g. https://zz00-001.dx.commercecloud.salesforce.com');
  lines.push('#   ACCESS_TOKEN:  shopper/admin access token (obtain via SLAS or your auth flow)');
  const unresolvedParams = new Set();
  for (const step of plan.steps) {
    for (const inp of step.requiredInputs) {
      if (inp.in !== 'path' || !inp.name) continue;
      const v = inp.name.toUpperCase();
      if (!boundVars.has(v)) unresolvedParams.add(inp.name);
    }
  }
  for (const name of unresolvedParams) {
    lines.push(`#   ${name.toUpperCase()}: supply from your environment (no structural producer found)`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = { renderCurlBlock };
