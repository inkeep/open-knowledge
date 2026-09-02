import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { buildPatternDConstructorOptions } from './TiptapEditor';
import {
  buildSeededPatternDProvider,
  fakeClipboard,
  installDomGlobals,
} from './walk-currency-test-harness';

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

  function buildSeededOptions() {
    const { provider, cleanup } = buildSeededPatternDProvider('tiptap-editor-pins');
    const options = buildPatternDConstructorOptions({
      provider,
      clipboard: fakeClipboard,
      ctorStart: 0,
    });
    const collaboration = options.extensions?.find((ext) => ext.name === 'collaboration') as
      | {
          options?: {
            ySyncOptions?: { mapping?: Map<unknown, ProseMirrorNode | ProseMirrorNode[]> };
          };
        }
      | undefined;
    const handedMapping = collaboration?.options?.ySyncOptions?.mapping;
    if (!(handedMapping instanceof Map)) {
      throw new Error('expected the options to hand a Map via ySyncOptions.mapping');
    }
    return { options, handedMapping, cleanup };
  }

  test('the construct-time walk injects the walked fragment content into the editor state (Q21 pre-warm)', () => {
    const { options, cleanup } = buildSeededOptions();
    let editor: Editor | null = null;
    try {
      editor = new Editor(options);
      expect(editor.state.doc.textContent).toContain('hello world');
    } finally {
      editor?.destroy();
      cleanup();
    }
  });

  test('ySyncOptions.mapping is the options-handed Map instance, populated in place by construction', () => {
    const { options, handedMapping, cleanup } = buildSeededOptions();
    let editor: Editor | null = null;
    try {
      expect(handedMapping.size).toBe(0);
      editor = new Editor(options);
      expect(handedMapping.size).toBeGreaterThanOrEqual(1);
    } finally {
      editor?.destroy();
      cleanup();
    }
  });

  test('every mapping node belongs to the constructed editor schema instance (schema affinity)', () => {
    const { options, handedMapping, cleanup } = buildSeededOptions();
    let editor: Editor | null = null;
    try {
      editor = new Editor(options);
      const nodes = [...handedMapping.values()].flatMap((value) =>
        Array.isArray(value) ? value : [value],
      );
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      for (const node of nodes) {
        expect(node.type.schema).toBe(editor.schema);
      }
    } finally {
      editor?.destroy();
      cleanup();
    }
  });
});
