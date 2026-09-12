import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { SCOPE_CONFIG_FILENAME } from './config.mjs';
import { isInScope, scopeForRoot, subjectScope } from './scope.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const predicateModules = readdirSync(MODULE_DIR)
  .filter((name) => name.endsWith('.mjs') && !name.includes('.test.'))
  .sort();

const config = subjectScope().config;

const declaredGlobs = [
  ...new Set([
    ...config.units.flatMap((unit) => [...unit.roots, ...unit.files]),
    ...config.walkRoots,
    ...config.include,
    ...config.exclude,
  ]),
]
  .filter((glob) => glob !== '.')
  .sort();

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the predicate carries no scope of its own', () => {
  test('the config declares enough for the assertion to bite', () => {
    expect(predicateModules).toContain('scope.mjs');
    expect(declaredGlobs.length).toBeGreaterThan(20);
  });

  const restates = (source, glob) =>
    /[/*]/.test(glob)
      ? source.includes(glob)
      : new RegExp(`(['"\`])${glob.replace(/[.*+?^$**{}()|[\]\\]/g, '\\$&')}\\1`).test(source);

  test.each(predicateModules)('%s restates no glob the config declares', (name) => {
    const source = readFileSync(join(MODULE_DIR, name), 'utf8');
    const restated = declaredGlobs.filter((glob) => restates(source, glob));
    expect({ name, restated }).toEqual({ name, restated: [] });
  });

  test('the restatement check bites: a hardcoded roots array is caught', () => {
    const planted = "const SCOPE_ROOTS = ['packages', 'scripts'];";
    expect(declaredGlobs.filter((glob) => restates(planted, glob))).toEqual([
      'packages',
      'scripts',
    ]);
    const plantedGlob = "const INCLUDE = ['packages/**/src/**/*.ts'];";
    expect(declaredGlobs.filter((glob) => restates(plantedGlob, glob))).toContain(
      'packages/**/src/**/*.ts',
    );
  });

  test('the repo-specific data left inside the predicate is one named registry', () => {
    const trees = ['md-conformance', 'lume-qa'];
    const carriers = predicateModules.filter((name) =>
      trees.some((tree) => readFileSync(join(MODULE_DIR, name), 'utf8').includes(tree)),
    );
    expect(carriers).toEqual(['rot.mjs']);
  });
});

describe('another root runs the same code against its own declaration', () => {
  const adopterRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'no-comments-adopter-'));
    roots.push(root);
    writeFileSync(
      join(root, SCOPE_CONFIG_FILENAME),
      JSON.stringify({
        version: 1,
        families: { go: { extensions: ['.go'], extractor: 'c-family' } },
        units: [{ id: 'cmd', family: 'go', roots: ['cmd'] }],
        exclude: ['**/vendor/**'],
      }),
    );
    mkdirSync(join(root, 'cmd/serve'), { recursive: true });
    writeFileSync(join(root, 'cmd/serve/main.go'), 'package main\n');
    mkdirSync(join(root, 'cmd/vendor'), { recursive: true });
    writeFileSync(join(root, 'cmd/vendor/dep.go'), 'package dep\n');
    return root;
  };

  test('the adopter scope admits its own tree and refuses this one, and the reverse', () => {
    const adopter = scopeForRoot(adopterRoot());
    expect(adopter.isInScope('cmd/serve/main.go')).toBe(true);
    expect(adopter.isInScope('cmd/vendor/dep.go')).toBe(false);
    expect(adopter.isInScope(config.include[0].replace(/\*\*/g, 'x').replace('*', 'a'))).toBe(
      false,
    );
    expect(isInScope('cmd/serve/main.go')).toBe(false);
  });

  test('two roots resolve independently rather than sharing one compiled scope', () => {
    const first = scopeForRoot(adopterRoot());
    const second = scopeForRoot(adopterRoot());
    expect(first).not.toBe(second);
    expect(first.config.root).not.toBe(second.config.root);
  });
});
