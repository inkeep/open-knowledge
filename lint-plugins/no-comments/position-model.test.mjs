import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const OK_ROOT = join(MODULE_DIR, '..', '..');

const SELF = 'position-model.test.mjs';

const FAMILY = [
  ...readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.mjs') && name !== SELF)
    .map((name) => join(MODULE_DIR, name)),
  ...readdirSync(join(OK_ROOT, 'scripts'))
    .filter((name) => /^(?:no-comments-|comment-)/.test(name) && name.endsWith('.mjs'))
    .map((name) => join(OK_ROOT, 'scripts', name)),
];

const SOURCE_NAME = '(?:this\\.)?(?:source|text|content|src|input|markdown|body)';

const CODE_POINT_SHAPES = [
  new RegExp(`\\[\\s*\\.\\.\\.\\s*${SOURCE_NAME}\\s*\\]`),
  new RegExp(`Array\\.from\\(\\s*${SOURCE_NAME}\\s*[),]`),
  new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+[\\w$]+\\s+of\\s+${SOURCE_NAME}\\s*\\)`),
  new RegExp(`${SOURCE_NAME}\\.codePointAt\\s*\\(`),
  /Intl\.Segmenter\b/,
];

function iteratesByCodePoint(text) {
  return CODE_POINT_SHAPES.some((shape) => shape.test(text));
}

describe('one position model: UTF-16 code units, never code points', () => {
  test('no file in the family iterates source text by code point', () => {
    const offenders = [];
    for (const file of FAMILY) {
      const text = readFileSync(file, 'utf8');
      if (iteratesByCodePoint(text)) offenders.push(file.slice(OK_ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  test('the family is large enough that this guard is not vacuous', () => {
    expect(FAMILY.length).toBeGreaterThan(10);
  });

  test('the detector fires on every code-point-iteration shape it claims to cover', () => {
    const mustFire = [
      'const chars = [...source];',
      'const chars = [ ... this.source ];',
      'const chars = Array.from(source);',
      'const chars = Array.from(text, (c) => c);',
      'for (const ch of content) {}',
      'const cp = source.codePointAt(index);',
      'const seg = new Intl.Segmenter().segment(source);',
    ];
    for (const sample of mustFire) expect(iteratesByCodePoint(sample)).toBe(true);

    const mustNotFire = [
      'const units = source.slice(start, end);',
      'const at = source.charCodeAt(index);',
      'for (let i = 0; i < source.length; i += 1) {}',
      'const copy = [...violations];',
      'for (const violation of violations) {}',
      'const rows = Array.from(comments);',
    ];
    for (const sample of mustNotFire) expect(iteratesByCodePoint(sample)).toBe(false);
  });
});
