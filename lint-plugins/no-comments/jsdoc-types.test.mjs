import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { analyzeSource, loadPrecedentNumbers } from './index.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..', '..');
const PRECEDENTS = loadPrecedentNumbers(REPO_ROOT);

const FIXTURE = readFileSync(join(MODULE_DIR, '__fixtures__', 'jsdoc-types.fixture.mjs'), 'utf8');

function violationsFor(source, relPath) {
  return analyzeSource({ source, relPath, precedentNumbers: PRECEDENTS }).violations;
}

describe('the jsdoc-type class: the only typing mechanism the untyped strata have', () => {
  test('type-only JSDoc is admitted in .mjs', () => {
    expect(violationsFor(FIXTURE, 'scripts/probe.mjs')).toEqual([]);
  });

  test('the same file is prose in .ts, where the language has real syntax', () => {
    const classes = violationsFor(FIXTURE, 'packages/core/src/probe.ts').map((v) => v.class);
    expect(classes.length).toBeGreaterThan(0);
    expect(new Set(classes)).toEqual(new Set(['prose']));
  });

  test('a description smuggled behind the type grammar is prose', () => {
    const source = "/** @param {string} name The name we normalize for the picker */\nexport const f = 1;\n";
    expect(violationsFor(source, 'scripts/probe.mjs').map((v) => v.class)).toEqual(['prose']);
  });

  test('@ts-check is a directive; knip built-ins stay excluded', () => {
    expect(violationsFor('// @ts-check\nexport const a = 1;\n', 'scripts/probe.mjs')).toEqual([]);
    for (const tag of ['@public', '@beta', '@alias next']) {
      const source = `/** ${tag} */\nexport const a = 1;\n`;
      expect(
        violationsFor(source, 'scripts/probe.mjs').map((v) => v.class),
        tag,
      ).toEqual(['prose']);
    }
  });
});
