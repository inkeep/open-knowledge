import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { buildPatternDConstructorOptions } from './TiptapEditor';
import {
  buildSeededPatternDProvider,
  fakeClipboard,
  installDomGlobals,
} from './walk-currency-test-harness';

/**
 * Pin the load-bearing invariants of the Pattern D editor-construction
 * options so a future refactor can't silently:
 *   - drop `element: null` (which would re-introduce TipTap's auto-mount →
 *     double-mount regression that surfaced under measurement), or
 *   - break pre-warm's construct-time walk (content injection +
 *     in-place mapping population inside `new Editor(...)`, keyed to the
 *     editor's own Schema instance).
 *
 * pre-warm is unconditional;
 * the wrapped `onBeforeCreate` derives both `editor.options.content` and the
 * Collaboration-handed mapping from one
 * `initProseMirrorDoc(fragment, editor.schema)` walk during construction.
 *
 * The `element: null` pin asserts on the options object only. The pre-warm
 * pins construct a real `new Editor(options)` (still no mount — `element:
 * null` bypasses auto-mount) because the walk now runs inside the
 * constructor; jsdom globals are installed per-file via the shared
 * walk-currency harness (see `walk-currency-test-harness.ts` for the
 * install/restore contract with sibling no-DOM-tier files).
 */
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
      // awareness is read by the cursor extension's addProseMirrorPlugins
      // which only fires at editor-construction time. Options-building doesn't
      // call that path, so undefined awareness is safe for these tests.
      awareness: undefined,
    } as unknown as HocuspocusProvider;
  }

  test('always passes element: null explicitly (1-way door regression guard)', () => {
    // The load-bearing invariant: TipTap gates auto-mount
    // on truthy `options.element`, AND `options.element` defaults to a fresh
    // `document.createElement('div')` when omitted. Only an explicit
    // `null` bypasses both — `undefined` falls through to the default div.
    // Measurement caught this exact bug when `element` was omitted; we pin it
    // here so the regression can't return.
    const opts = buildPatternDConstructorOptions({
      provider: makeFakeProvider(),
      clipboard: fakeClipboard,
      ctorStart: 0,
    });
    expect(opts.element).toBeNull();
    // Stronger pin: the field is PRESENT (not omitted). `'element' in opts`
    // distinguishes "explicit null" from "missing key" — the latter triggers
    // the auto-mount default and is the bug shape we're guarding against.
    expect('element' in opts).toBe(true);
    expect(opts.element).not.toBeUndefined();
  });

  /** Build options against a seeded one-paragraph fragment, exposing the
   *  mapping Map the options handed to the Collaboration extension so the
   *  pins can observe it across the `new Editor(...)` boundary. */
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
    // The pre-warm walk runs inside `new Editor(...)` (wrapped onBeforeCreate)
    // and injects `editor.options.content` BEFORE TipTap's createDoc() parses
    // it, so the editor opens with the current Y.Doc state instead of waiting
    // for the on-mount _forceRerender. Asserted synchronously after the
    // constructor returns — no mount, no Y.Doc update can paper over a broken
    // injection here.
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
    // The pre-warm relies on `Collaboration.configure({ ySyncOptions: { mapping } })`
    // forwarding the SAME Map reference end-to-end so y-tiptap's ySyncPlugin
    // skips `_forceRerender()` on first mount (verified
    // — mapping != null branch). The reference is captured here BEFORE
    // `new Editor(...)` and must be empty before / non-empty after it: the
    // walk runs at construction (an already-populated Map at options-build
    // time means the walk ran before the editor's schema existed — the
    // foreign-schema content-loss shape the schema-affinity pin guards), and
    // it populates the handed instance in place (a swapped-in replacement Map
    // would leave ySyncPlugin holding a stale empty reference). An
    // empty-but-non-null mapping never loses text — rebuilds create fresh
    // view-schema nodes — but silently degrades item preservation and
    // per-session undo attribution, which content assertions can't observe;
    // hence the size pin rather than a content check.
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
    // ProseMirror content matching is NodeType-identity-based: mapping nodes
    // built against any OTHER Schema instance are silently dropped by the
    // first incremental rebuild's `tr.replace` fitter — user-visible content
    // loss that then propagates to the CRDT. This pin turns the type-level
    // inexpressible schema-instance affinity into a CI-enforced identity
    // check; it also goes red if a @tiptap/core bump reorders the
    // constructor's beforeCreate/createDoc sequence (see
    // buildPatternDConstructorOptions's constructor-order contract).
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
