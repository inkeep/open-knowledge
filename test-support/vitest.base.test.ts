import { describe, expect, test } from 'bun:test';
import { importMetaDirPlugin } from './vitest.base';

type TransformFn = (code: string) => { code: string } | null;
const transform = importMetaDirPlugin.transform as unknown as TransformFn;

// Build the bun-only marker at runtime so its literal never appears in this
// file's own source — otherwise the plugin (which transforms every file,
// including this one) would rewrite the test inputs before the test runs.
const BUN_DIR = `import.meta.${'dir'}`;

describe('importMetaDirPlugin', () => {
  test('rewrites the bun-only import.meta.dir to a Node directory expression', () => {
    const result = transform(`const d = ${BUN_DIR};`);
    expect(result?.code).toContain('new URL(".", import.meta.url)');
    expect(result?.code).not.toMatch(/import\.meta\.dir\b/);
  });

  test('leaves the native import.meta.dirname untouched', () => {
    // A greedy substring replace would corrupt `import.meta.dirname` into
    // `(...))name`; the transform must no-op when only the native form is present.
    expect(transform('const d = import.meta.dirname;')).toBeNull();
  });

  test('rewrites only the bun form when both appear in one file', () => {
    const result = transform(`const a = ${BUN_DIR}; const b = import.meta.dirname;`);
    expect(result?.code).toContain('const b = import.meta.dirname;');
    expect(result?.code).toContain('new URL(".", import.meta.url)');
  });

  test('no-ops files that mention neither form', () => {
    expect(transform('const x = 1;')).toBeNull();
  });
});
