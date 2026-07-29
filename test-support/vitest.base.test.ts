import { describe, expect, test } from 'vitest';
import { importMetaDirPlugin } from './vitest.base';

type TransformFn = (code: string) => { code: string } | null;
const transform = importMetaDirPlugin.transform as unknown as TransformFn;

// Build the bun-only marker at runtime so its literal never appears in this
// file's own source — otherwise the plugin (which transforms every file,
// including this one) would rewrite the test inputs before the test runs.
const BUN_DIR = `import.meta.${'dir'}`;

describe('importMetaDirPlugin', () => {
  test('rewrites the bun-only import.meta.dir to native import.meta.dirname', () => {
    const result = transform(`const d = ${BUN_DIR};`);
    expect(result?.code).toBe('const d = import.meta.dirname;');
  });

  test('does NOT rewrite to a URL pathname (Windows regression guard)', () => {
    // `new URL(".", import.meta.url).pathname` is a URL pathname, not a
    // filesystem path: on Windows it is `/C:/repo/pkg/src` — leading slash,
    // forward separators — which ENOENTs as a `spawnSync` cwd and corrupts any
    // `path` math built on it. Real-Windows-verified failure mode; see the
    // plugin's comment.
    const result = transform(`const d = ${BUN_DIR};`);
    expect(result?.code).not.toContain('new URL');
    expect(result?.code).not.toContain('pathname');
  });

  test('leaves the native import.meta.dirname untouched', () => {
    // A greedy substring replace would corrupt `import.meta.dirname` into
    // `(...))name`; the transform must no-op when only the native form is present.
    expect(transform('const d = import.meta.dirname;')).toBeNull();
  });

  test('rewrites only the bun form when both appear in one file', () => {
    const result = transform(`const a = ${BUN_DIR}; const b = import.meta.dirname;`);
    expect(result?.code).toBe('const a = import.meta.dirname; const b = import.meta.dirname;');
  });

  test('no-ops files that mention neither form', () => {
    expect(transform('const x = 1;')).toBeNull();
  });
});
