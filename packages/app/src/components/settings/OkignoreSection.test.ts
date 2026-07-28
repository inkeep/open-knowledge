import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  derivePreviewPaths,
  parseRows,
  readShowAdvanced,
  writeShowAdvanced,
} from './OkignoreSection';

describe('OkignoreSection module', () => {
  test('loads the component and exported helpers', async () => {
    const mod = await import('./OkignoreSection');
    expect(typeof mod.OkignoreSection).toBe('function');
    expect(typeof mod.parseRows).toBe('function');
    expect(typeof mod.derivePreviewPaths).toBe('function');
    expect(typeof mod.readShowAdvanced).toBe('function');
    expect(typeof mod.writeShowAdvanced).toBe('function');
  });
});

describe('parseRows helper', () => {
  test('returns no rows for empty bodies, blanks, or comments', () => {
    expect(parseRows('')).toEqual([]);
    expect(parseRows('\n\n  \n\t\n')).toEqual([]);
    expect(parseRows('# header\n# another comment\n')).toEqual([]);
  });

  test('returns each non-comment, non-blank line as a trimmed row', () => {
    expect(parseRows('# header\n  drafts/  \n\n\t*.tmp\t\n')).toEqual(['drafts/', '*.tmp']);
  });

  test('treats a leading hash as a comment while preserving escaped hash patterns', () => {
    expect(parseRows('# not a row\n\\#literal\nactual\n')).toEqual(['\\#literal', 'actual']);
  });
});

describe('derivePreviewPaths helper', () => {
  test('reattaches document extensions and includes asset paths', () => {
    const pages = new Set<string>(['drafts/foo', 'index', 'orphan']);
    const pageMeta = new Map<string, { docExt?: string }>([
      ['drafts/foo', { docExt: '.md' }],
      ['index', { docExt: '.mdx' }],
    ]);
    const assetPaths = new Set<string>(['images/diagram.png']);

    expect(derivePreviewPaths(pages, pageMeta, assetPaths)).toEqual([
      'drafts/foo.md',
      'index.mdx',
      'orphan.md',
      'images/diagram.png',
    ]);
  });

  test('returns an empty list on empty inputs', () => {
    expect(derivePreviewPaths(new Set(), new Map(), new Set())).toEqual([]);
  });
});

describe('advanced-toggle localStorage helpers', () => {
  let storage: Map<string, string>;
  const originalLocalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
  const originalConsoleDebug = console.debug;

  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: () => null,
      get length() {
        return storage.size;
      },
    } as Storage;
    console.debug = () => {};
  });

  afterEach(() => {
    console.debug = originalConsoleDebug;
    if (originalLocalStorage === undefined) {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
    }
  });

  test('defaults off and round-trips persisted true/false values', () => {
    expect(readShowAdvanced()).toBe(false);
    writeShowAdvanced(true);
    expect(storage.get('okignore-show-advanced')).toBe('true');
    expect(readShowAdvanced()).toBe(true);
    writeShowAdvanced(false);
    expect(storage.get('okignore-show-advanced')).toBe('false');
    expect(readShowAdvanced()).toBe(false);
  });

  test('treats only the string true as enabled', () => {
    storage.set('okignore-show-advanced', '1');
    expect(readShowAdvanced()).toBe(false);
    storage.set('okignore-show-advanced', 'true');
    expect(readShowAdvanced()).toBe(true);
  });

  test('fails closed when localStorage is unavailable or throws', () => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    expect(readShowAdvanced()).toBe(false);
    expect(() => writeShowAdvanced(true)).not.toThrow();

    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    expect(readShowAdvanced()).toBe(false);
    expect(() => writeShowAdvanced(true)).not.toThrow();
  });
});
