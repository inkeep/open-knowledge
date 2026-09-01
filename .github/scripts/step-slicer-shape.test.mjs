import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SELF_PATH = fileURLToPath(import.meta.url);
const HERE = dirname(SELF_PATH);

const ROOTS = [HERE, join(HERE, '..', '..', 'scripts')];

const NESTED_SLICE = /\.slice\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(?:indexOf|lastIndexOf)\(/g;

const BASELINE = {
  'build-smoke-alert-payload.test.mjs': 3,
  'point-release-plan.test.mjs': 1,
  'release-cascade-shape.test.mjs': 18,
};

const countIn = (src) => [...src.matchAll(NESTED_SLICE)].length;

const SELF = basename(SELF_PATH);

const scanTargets = () =>
  ROOTS.flatMap((root) =>
    readdirSync(root)
      .filter((f) => f.endsWith('.test.mjs') && f !== SELF)
      .map((f) => [f, join(root, f)]),
  );

describe('unguarded step-slicer shape', () => {
  const targets = scanTargets();
  const files = targets.map(([label]) => label);

  test('the scanner finds both script roots and their test files', () => {
    expect(files.length).toBeGreaterThan(30);
    for (const root of ROOTS) {
      expect(
        readdirSync(root).filter((f) => f.endsWith('.test.mjs')).length,
        `${root}: no .test.mjs files found`,
      ).toBeGreaterThan(0);
    }
    expect(readdirSync(HERE)).toContain(SELF);
  });

  test('the pattern matches the unguarded form and not the guarded one', () => {
    expect(countIn("const s = src.slice(src.indexOf('- name: X'));")).toBe(1);
    expect(countIn('const s = src.slice(\n  src.indexOf(a),\n  src.indexOf(b),\n);')).toBe(1);
    expect(countIn("const s = o.src.slice(o.src.indexOf('- name: X'));")).toBe(1);
    expect(countIn("const s = src.slice(src.lastIndexOf('x'));")).toBe(1);
    expect(countIn("const s = ctx.source.slice(ctx.source.lastIndexOf('x'));")).toBe(1);
    expect(countIn("const at = src.indexOf('x');\nconst s = src.slice(at);")).toBe(0);
    expect(countIn('const s = src.slice(0, 40);')).toBe(0);
  });

  test('no new file introduces the unguarded shape', () => {
    const offenders = targets
      .filter(([label]) => !(label in BASELINE))
      .filter(([, path]) => countIn(readFileSync(path, 'utf8')) > 0)
      .map(([label]) => label);
    expect(
      offenders,
      "bind the index and refuse -1 before slicing; see this file's header for the safe form",
    ).toEqual([]);
  });

  test('every baselined file carries exactly its baselined count', () => {
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const target = targets.find(([label]) => label === file);
      expect(target, `${file}: baselined but not found in either script root`).toBeDefined();
      const found = countIn(readFileSync(target[1], 'utf8'));
      expect(
        found,
        `${file}: ${found} unguarded slice(indexOf(...)) sites, baseline ${allowed}. ` +
          'Lower the baseline in the same commit when you remove one; never raise it to add one.',
      ).toBe(allowed);
    }
  });

  test('the baseline names only files that still exist', () => {
    for (const file of Object.keys(BASELINE)) expect(files).toContain(file);
  });
});
