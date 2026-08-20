#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_DESCRIPTION_CHARACTERS = 300;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const SKILLS_ROOT = path.join(REPOSITORY_ROOT, 'skills');

function readFrontmatter(skillFile) {
  const source = fs.readFileSync(skillFile, 'utf8').replaceAll('\r\n', '\n');
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error('missing YAML frontmatter');

  const fields = new Map();
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z][a-z-]*):\s+(.+)$/);
    if (field) fields.set(field[1], field[2].trim());
  }
  return fields;
}

const failures = [];
const skillNames = fs.readdirSync(SKILLS_ROOT)
  .filter((entry) => !entry.startsWith('_'))
  .filter((entry) => fs.existsSync(path.join(SKILLS_ROOT, entry, 'SKILL.md')))
  .sort();

for (const skillName of skillNames) {
  const skillFile = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
  try {
    const fields = readFrontmatter(skillFile);
    const declaredName = fields.get('name');
    const description = fields.get('description');

    if (declaredName !== skillName) {
      failures.push(`${skillName}: frontmatter name is ${declaredName ?? 'missing'}`);
    }
    if (!description) {
      failures.push(`${skillName}: description is missing or not a single line`);
      continue;
    }

    const characterCount = [...description].length;
    console.log(`${skillName}: ${characterCount}/${MAX_DESCRIPTION_CHARACTERS}`);
    if (characterCount > MAX_DESCRIPTION_CHARACTERS) {
      failures.push(`${skillName}: description has ${characterCount} characters`);
    }
  } catch (error) {
    failures.push(`${skillName}: ${error.message}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${skillNames.length} skills`);
}
