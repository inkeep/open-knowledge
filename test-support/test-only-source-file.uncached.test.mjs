import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from './test-only-source-file.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('test-only source files', () => {
  test.each([
    'module.test.ts',
    'module.test.tsx',
    'module.dom.test.tsx',
    'module.uncached.test.ts',
    'module.test-helper.ts',
    'module.test-helper.tsx',
    'module.type-tests.ts',
    'module.type-tests.tsx',
    'module.e2e.ts',
    '/project/src/module.type-tests.ts',
    'C:\\project\\src\\module.test-helper.ts',
  ])('recognizes %s', (path) => {
    expect(isTestOnlySourceFile(path)).toBe(true);
  });

  test.each([
    '',
    'module.ts',
    'module.tsx',
    'module.d.ts',
    'module.spec.ts',
    'module.test.ts.bak',
    'module.type-tests.ts/production.ts',
    'module.test-helper.ts/production.ts',
    'module.test.backup.ts',
    'module-test-helper.ts',
  ])('keeps %s outside the test-only set', (path) => {
    expect(isTestOnlySourceFile(path)).toBe(false);
  });

  test('runner selection does not admit helpers or type checks', () => {
    expect(isTestOnlySourceFile('module.uncached.test.ts', 'vitest')).toBe(true);
    expect(isTestOnlySourceFile('module.test.tsx', 'vitest')).toBe(true);
    expect(isTestOnlySourceFile('module.test-helper.ts', 'vitest')).toBe(false);
    expect(isTestOnlySourceFile('module.type-tests.ts', 'vitest')).toBe(false);
    expect(isTestOnlySourceFile('module.e2e.ts', 'vitest')).toBe(false);
    expect(isTestOnlySourceFile('module.e2e.ts', 'playwright')).toBe(true);
  });

  test('Node imports the ESM module directly without a loader', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { isTestOnlySourceFile } from './test-support/test-only-source-file.mjs'; process.stdout.write(JSON.stringify([isTestOnlySourceFile('a.type-tests.ts'), isTestOnlySourceFile('a.ts')]));",
      ],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, false]);
  });
});
