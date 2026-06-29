import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGE_APP_ROOT = resolve(import.meta.dir, '../..');
const PACKAGE_JSON_PATH = resolve(PACKAGE_APP_ROOT, 'package.json');
const RUN_TEST_DOM_PATH = resolve(PACKAGE_APP_ROOT, 'scripts/run-test-dom.sh');

interface PackageJson {
  scripts?: Record<string, string>;
}

const packageJson: PackageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
const runTestDomSource = readFileSync(RUN_TEST_DOM_PATH, 'utf-8');

describe('Tier-3 substrate-additive contract — package.json + run-test-dom.sh invariants', () => {
  test('unit-tier `test` script passes --conditions development', () => {
    const testScript = packageJson.scripts?.test;
    expect(testScript).toBeDefined();
    expect(testScript).toContain('--conditions development');
  });

  test("unit-tier `test` script passes --path-ignore-patterns='**/*.dom.test.tsx'", () => {
    const testScript = packageJson.scripts?.test;
    expect(testScript).toBeDefined();
    expect(testScript).toMatch(/--path-ignore-patterns[=\s]['"]\*\*\/\*\.dom\.test\.tsx['"]/);
  });

  test('unit-tier `test` script does NOT pass --preload (no jsdom in unit substrate)', () => {
    const testScript = packageJson.scripts?.test;
    expect(testScript).toBeDefined();
    expect(testScript).not.toContain('--preload');
  });

  test('`test:dom` script delegates to bash scripts/run-test-dom.sh', () => {
    const testDomScript = packageJson.scripts?.['test:dom'];
    expect(testDomScript).toBeDefined();
    expect(testDomScript).toContain('bash scripts/run-test-dom.sh');
  });

  test('run-test-dom.sh passes --preload ./tests/dom/jsdom-preload.ts (invocation-scoped jsdom)', () => {
    expect(runTestDomSource).toMatch(/--preload\s+[.'"\s]*\.?\/?tests\/dom\/jsdom-preload\.ts/);
  });

  test('run-test-dom.sh passes --conditions development (parity with unit tier)', () => {
    expect(runTestDomSource).toContain('--conditions development');
  });

  test('run-test-dom.sh filters discovery to the .dom.test.tsx suffix (D18 routing)', () => {
    expect(runTestDomSource).toContain('.dom.test.tsx');
  });

  test('run-test-dom.sh passes --isolate (mock.module file-scope under oven-sh/bun#12823)', () => {
    expect(runTestDomSource).toContain('--isolate');
  });
});
