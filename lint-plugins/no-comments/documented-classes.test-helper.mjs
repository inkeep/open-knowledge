import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const README = join(MODULE_DIR, 'README.md');
const SECTION = '## Violation classes';

function readmeLines() {
  return readFileSync(README, 'utf8').split('\n');
}

export function documentedViolationClasses() {
  const lines = readmeLines();
  const start = lines.indexOf(SECTION);
  if (start === -1) throw new Error(`README.md has no "${SECTION}" section`);

  const classes = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const heading = /^### (\S+)$/.exec(line);
    if (heading) classes.push(heading[1]);
  }
  if (classes.length === 0) throw new Error(`README.md's "${SECTION}" section documents none`);
  return classes;
}

export function documentedRegistryRows(heading) {
  const lines = readmeLines();
  const start = lines.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`README.md has no "### ${heading}" section`);

  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) continue;
    const cells = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) throw new Error(`README.md's "### ${heading}" section tabulates none`);
  return rows;
}

function classLiterals(pattern) {
  const source = readFileSync(join(MODULE_DIR, 'allowlist.mjs'), 'utf8');
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

export function admittedClasses() {
  return classLiterals(/\ballowed\('([a-z-]+)'/g);
}

export function emittedViolationClasses() {
  return classLiterals(/\bviolation\(\s*'([a-z-]+)'/g);
}
