import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { appVitestConfig } from '../../vitest.config.ts';
import { appDomVitestConfig } from '../../vitest.dom.config.ts';

const PACKAGE_APP_ROOT = resolve(import.meta.dir, '../..');
const PACKAGE_JSON_PATH = resolve(PACKAGE_APP_ROOT, 'package.json');

interface PackageJson {
  scripts?: Record<string, string>;
}

const packageJson: PackageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));

describe('Tier-3 substrate-additive contract — package.json + vitest config invariants', () => {
  test('unit-tier `test` script runs vitest with the config pinning development conditions', () => {
    const testScript = packageJson.scripts?.test;
    expect(testScript).toBeDefined();
    expect(testScript).toContain('vitest run');
    expect(testScript).toContain('vitest.config.ts');
    expect(appVitestConfig.ssr.resolve.conditions).toContain('development');
  });

  test('unit-tier vitest config excludes **/*.dom.test.ts?(x) (Tier-3 stays out of the unit run)', () => {
    expect(appVitestConfig.test.exclude).toContain('**/*.dom.test.ts?(x)');
  });

  test('unit-tier vitest config runs in the node environment (no jsdom in the unit substrate)', () => {
    expect(appVitestConfig.test.environment).toBe('node');
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  test('`test:dom` script runs vitest with the dedicated jsdom project config', () => {
    const testDomScript = packageJson.scripts?.['test:dom'];
    expect(testDomScript).toBeDefined();
    expect(testDomScript).toContain('vitest run');
    expect(testDomScript).toContain('vitest.dom.config.ts');
  });

  test('dom project runs the jsdom environment with the per-project jsdom setup file', () => {
    expect(appDomVitestConfig.test.environment).toBe('jsdom');
    const setupFiles = appDomVitestConfig.test.setupFiles as string[];
    expect(setupFiles.some((path) => path.endsWith('tests/dom/jsdom-preload.ts'))).toBe(true);
  });

  test('dom project pins the development export condition (parity with the unit tier)', () => {
    expect(appDomVitestConfig.ssr.resolve.conditions).toContain('development');
  });

  test('dom project scopes include to the .dom.test suffix', () => {
    expect(appDomVitestConfig.test.include).toEqual(['**/*.dom.test.ts?(x)']);
  });

  test('dom project sets isolate:true for a fresh per-file module registry', () => {
    expect(appDomVitestConfig.test.isolate).toBe(true);
  });
});
