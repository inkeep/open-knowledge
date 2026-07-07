/**
 * Substrate-additive contract pinning for the Tier-3 test runner.
 *
 * The two-script substrate split documented in Precedent #43
 * only holds if `packages/app/package.json`'s `test` and `test:dom`
 * scripts maintain specific invocation flags. The "wrong-runner
 * failure mode" coverage was BLOCKED on behavioral reproduction
 * (the failure is structurally prevented by the `--path-ignore-patterns`
 * flag — to behaviorally observe it, one would have to mutate the script
 * temporarily, which pollutes the working tree). This meta-test converts
 * that blocked coverage into structural enforcement: when the package.json
 * scripts drift away from the contract, the test fails loudly with a
 * pointer at the broken invariant.
 *
 * Invariants pinned:
 *
 *   1. Unit-tier `test` script
 *        - MUST pass `--conditions development` (workspace package
 *          resolution for `workspace:*` source imports).
 *        - MUST pass `--path-ignore-patterns='**\/*.dom.test.tsx'` (Bun's
 *          default discovery would otherwise pull in Tier-3 files without
 *          the jsdom preload, causing `document is undefined` at first DOM
 *          access).
 *        - MUST NOT pass `--preload` for jsdom (the unit substrate stays
 *          no-DOM so production `typeof document === 'undefined'`
 *          short-circuits keep their contract).
 *
 *   2. Tier-3 `test:dom` script
 *        - MUST delegate to `bash scripts/run-test-dom.sh` (the wrapper
 *          handles "exit 0 when no Tier-3 tests exist" + the substring
 *          discovery filter, which inline `bun test` cannot).
 *
 *   3. `run-test-dom.sh` wrapper
 *        - MUST pass `--preload ./tests/dom/jsdom-preload.ts` (the
 *          invocation-scoped jsdom attachment).
 *        - MUST pass `--conditions development` (parity with unit tier).
 *        - MUST filter to `.dom.test.tsx` (the routing suffix).
 *        - MUST pass `--isolate` (mock.module file-scope; oven-sh/bun#12823).
 */

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
    // Match either single-quote or double-quote arg quoting and both
    // `--flag=value` and `--flag value` forms; the invariant is the flag +
    // suffix glob, not the shell-quoting style.
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
    // Match the preload-flag with either inline-array or back-to-back
    // arg form; what matters is the path resolves to the jsdom-preload
    // module relative to packages/app/.
    expect(runTestDomSource).toMatch(/--preload\s+[.'"\s]*\.?\/?tests\/dom\/jsdom-preload\.ts/);
  });

  test('run-test-dom.sh passes --conditions development (parity with unit tier)', () => {
    expect(runTestDomSource).toContain('--conditions development');
  });

  test('run-test-dom.sh filters discovery to the .dom.test.tsx suffix (D18 routing)', () => {
    expect(runTestDomSource).toContain('.dom.test.tsx');
  });

  test('run-test-dom.sh passes --isolate (mock.module file-scope under oven-sh/bun#12823)', () => {
    // Bun's mock.module is in-place: a mock declared at module level in
    // one .dom.test.tsx file persists into sibling files when bun test
    // iterates them in one invocation. Linux CI's filesystem iteration
    // ordered config-provider.dom.test.tsx (which mocks
    // '@/hooks/use-theme-bridge' to a no-op) BEFORE
    // use-theme-bridge.dom.test.tsx, replacing the real hook globally and
    // producing the Received: 0 mode the substrate hit on PR #853.
    // --isolate gives each file a fresh global object so module patches
    // don't bleed. Removing this flag would re-open the leak class.
    expect(runTestDomSource).toContain('--isolate');
  });
});
