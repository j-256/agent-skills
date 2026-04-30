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

    const interpolatedPath = interpolatePath(step.path);
    const curl = [
      `${respVar}=$(curl -sS -X ${step.method} \\`,
      `  "\${BASE_URL}${interpolatedPath}" \\`,
      '  -H "Authorization: Bearer ${ACCESS_TOKEN}" \\',
      '  -H "Content-Type: application/json"',
    ];
    // If any body field is required, stub it with a JSON placeholder.
    const bodyFields = step.requiredInputs.filter((i) => i.in === 'body');
    if (bodyFields.length > 0) {
      const stub = {};
      for (const f of bodyFields) stub[f.name] = `<${f.name}>`;
      curl[curl.length - 1] += ' \\';
      curl.push(`  -d '${JSON.stringify(stub)}'`);
    }
    curl[curl.length - 1] += ')';
    lines.push(curl.join('\n'));
    lines.push('');

    // Extract any IDs this step produces that a later step needs.
    // Look at consumers in idPassing whose `from` is this step.
    const producedFields = new Set();
    for (const entry of plan.idPassing) {
      for (const i of entry.inputs) {
        if (i.from === step.slug) producedFields.add(i.field);
      }
    }
    for (const field of producedFields) {
      const varName = field.toUpperCase();
      lines.push(`${varName}=$(echo "$${respVar}" | jq -r .${field})`);
      boundVars.add(varName);
    }
    if (producedFields.size > 0) lines.push('');
  }

  // Legend.
  lines.push('# ----------------------------------------------------------');
  lines.push('# Placeholders:');
  lines.push('#   BASE_URL:      your instance base URL, e.g. https://zz00-001.dx.commercecloud.salesforce.com');
  lines.push('#   ACCESS_TOKEN:  shopper/admin access token (obtain via SLAS or your auth flow)');
  const unresolvedParams = new Set();
  for (const step of plan.steps) {
    for (const inp of step.requiredInputs) {
      if (inp.in !== 'path') continue;
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
