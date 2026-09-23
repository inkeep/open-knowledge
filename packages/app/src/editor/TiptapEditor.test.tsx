import type { HocuspocusProvider } from '@hocuspocus/provider';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { buildPatternDConstructorOptions } from './TiptapEditor';
import { fakeClipboard, installDomGlobals } from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

describe('buildPatternDConstructorOptions', () => {
  function makeFakeProvider(): HocuspocusProvider {
    const ydoc = new Y.Doc();
    return {
      document: ydoc,
      configuration: { name: 'test-doc' },
      awareness: undefined,
    } as unknown as HocuspocusProvider;
  }

  test('always passes element: null explicitly (1-way door regression guard)', () => {
    const opts = buildPatternDConstructorOptions({
      provider: makeFakeProvider(),
      clipboard: fakeClipboard,
      ctorStart: 0,
    });
    expect(opts.element).toBeNull();
    expect('element' in opts).toBe(true);
    expect(opts.element).not.toBeUndefined();
  });
});
