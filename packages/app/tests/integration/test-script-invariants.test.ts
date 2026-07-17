/**
 * Substrate-additive contract pinning for the Tier-3 test runner.
 *
 * The two-project substrate split only holds if the `test` and `test:dom`
 * scripts (and the vitest configs they name) maintain specific invariants. This
 * meta-test converts that into structural enforcement: when the package.json
 * scripts or the dom project config drift away from the contract, the test
 * fails loudly with a pointer at the broken invariant.
 *
 * Invariants pinned:
 *
 *   1. Unit-tier `test` script + its vitest config
 *        - The script MUST run vitest with `vitest.config.ts` (the config
 *          that carries the substrate contract below).
 *        - The config MUST pin the `development` export condition
 *          (`ssr.resolve.conditions`) so `workspace:*` imports resolve to
 *          source, not stale dist.
 *        - The config MUST exclude `**\/*.dom.test.tsx` so Tier-3 files stay
 *          out of the unit run (they belong to the dedicated jsdom project).
 *        - The config MUST run in the `node` environment so the unit
 *          substrate stays no-DOM and production
 *          `typeof document === 'undefined'` short-circuits keep their
 *          contract.
 *
 *   2. Tier-3 `test:dom` script + its dedicated jsdom project config
 *        - The script MUST run vitest with `vitest.dom.config.ts`.
 *        - The config MUST use the `jsdom` environment (declarative DOM
 *          globals, replacing the retired invocation-scoped preload chain).
 *        - The config MUST carry `tests/dom/jsdom-preload.ts` as a per-project
 *          setupFile (the DOM-global backfill jsdom omits).
 *        - The config MUST pin the `development` export condition (parity with
 *          the unit tier).
 *        - The config MUST scope its `include` to `**\/*.dom.test.tsx` (the
 *          routing suffix).
 *        - The config MUST set `isolate: true` so each file runs in a fresh
 *          module registry — the parity-critical property the retired
 *          `bun test --isolate` flag provided (oven-sh/bun#12823).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    // The `--conditions development` workspace-src resolution moved from a bun
    // CLI flag onto the shared vitest base (`ssr.resolve.conditions`), which the
    // app config spreads.
    expect(appVitestConfig.ssr.resolve.conditions).toContain('development');
  });

  test('unit-tier vitest config excludes **/*.dom.test.tsx (Tier-3 stays out of the unit run)', () => {
    // The bun `--path-ignore-patterns='**/*.dom.test.tsx'` flag is now the
    // config `test.exclude` glob; the dom tier runs in its own jsdom project.
    expect(appVitestConfig.test.exclude).toContain('**/*.dom.test.tsx');
  });

  test('unit-tier vitest config runs in the node environment (no jsdom in the unit substrate)', () => {
    // Keeps production `typeof document === 'undefined'` short-circuits honest —
    // the unit tier must not carry jsdom globals.
    expect(appVitestConfig.test.environment).toBe('node');
    // Runtime no-bleed proof: this meta-test itself runs in a non-dom project
    // (the integration tier is node-env). The jsdom project's `environment:
    // 'jsdom'` is scoped per project, so no DOM global leaks into node-env
    // projects — `document` is genuinely absent here even though 1833 dom-tier
    // tests render against jsdom's `document` in their own project.
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
    // Declarative replacement for the retired `--preload ./tests/dom/jsdom-preload.ts`
    // invocation flag: the jsdom environment installs DOM globals per project and
    // the setupFile backfills the handful jsdom omits.
    expect(appDomVitestConfig.test.environment).toBe('jsdom');
    const setupFiles = appDomVitestConfig.test.setupFiles as string[];
    expect(setupFiles.some((path) => path.endsWith('tests/dom/jsdom-preload.ts'))).toBe(true);
  });

  test('dom project pins the development export condition (parity with the unit tier)', () => {
    expect(appDomVitestConfig.ssr.resolve.conditions).toContain('development');
  });

  test('dom project scopes include to the .dom.test.tsx routing suffix', () => {
    expect(appDomVitestConfig.test.include).toEqual(['**/*.dom.test.tsx']);
  });

  test('dom project sets isolate:true (per-file fresh module registry, oven-sh/bun#12823)', () => {
    // Bun's mock.module is in-place: a mock declared at module level in one
    // .dom.test.tsx file persists into sibling files run in one invocation. Linux
    // CI's filesystem iteration ordered config-provider.dom.test.tsx (which mocks
    // '@/hooks/use-theme-bridge' to a no-op) BEFORE use-theme-bridge.dom.test.tsx,
    // replacing the real hook globally and producing the Received: 0 mode the
    // substrate hit on PR #853. `isolate: true` gives each file a fresh module
    // registry so mocks don't bleed. Removing it would re-open the leak class.
    expect(appDomVitestConfig.test.isolate).toBe(true);
  });
});
