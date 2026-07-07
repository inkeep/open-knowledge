/**
 * Shared test substrate for the Pattern D pre-warm / walk-currency suites
 * (`pattern-d-walk-currency.test.ts`, `walk-currency-extension.test.ts`,
 * `pattern-d-schema-identity.test.ts`, `TiptapEditor.test.tsx`).
 * Test-only module — not imported by production code.
 *
 * These suites need raw DOM globals for a real ProseMirror EditorView but no
 * React runtime, so they do not use the `*.dom.test.tsx` RTL tier (whose
 * jsdom arrives process-wide via `tests/dom/jsdom-preload.ts`). Instead each
 * file calls `installDomGlobals()` in its own `beforeAll` and runs the
 * returned restore in `afterAll` — sibling unit-tier files run in the same
 * `bun test` process and rely on the no-DOM contract; do not remove the
 * restore.
 */

import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { type Editor, Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { JSDOM } from 'jsdom';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { buildPatternDConstructorOptions } from './TiptapEditor';

/**
 * Install jsdom-backed DOM globals, returning a restore function that puts
 * back the previous global descriptors (or deletes ones we introduced) and
 * closes the jsdom window.
 */
export function installDomGlobals(): () => void {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'http://localhost:5173',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const installed: Record<string, unknown> = {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Document: win.Document,
    DocumentFragment: win.DocumentFragment,
    Text: win.Text,
    Range: win.Range,
    DOMParser: win.DOMParser,
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    InputEvent: win.InputEvent,
    CompositionEvent: win.CompositionEvent,
    FocusEvent: win.FocusEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(installed)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalRecord, key);
      }
    }
    dom.window.close();
  };
}

type ClipboardArg = Parameters<typeof buildPatternDConstructorOptions>[0]['clipboard'];

// Shape-only clipboard fake — avoids importing buildClipboardState (which
// would touch the markdown pipeline + DOM-style polyfills). The handlers are
// stored on editorProps, never invoked by construct/mount; `html.setView` IS
// invoked by onCreate, hence the no-op.
export const fakeClipboard = {
  mdManager: {},
  text: () => '',
  html: { serializer: {}, setView: () => {} },
  paste: () => false,
  drop: () => false,
} as unknown as ClipboardArg;

export function seedFragmentParagraph(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
}

/** Selection-only transaction — the "one click" of the production scenario. */
export function dispatchSelectionOnly(editor: Editor): void {
  const { state } = editor.view;
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1)));
}

export interface SeededPatternDProvider {
  docName: string;
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  awareness: Awareness;
  provider: HocuspocusProvider;
  /** Destroys the awareness + ydoc this builder created — nothing else. */
  cleanup: () => void;
}

/**
 * Provider stand-in for the Pattern D suites: a real Y.Doc + Awareness behind
 * the minimal HocuspocusProvider surface `buildPatternDConstructorOptions`
 * reads (`document`, `configuration.name`, `awareness`), with the `'default'`
 * fragment seeded before the provider is handed out so the pre-warm walk has
 * content to cache. The per-suite construct/mount tails (new Editor,
 * editor.mount, host removal, editor.destroy) legitimately differ and stay at
 * the call site; `cleanup` covers only what this builder created.
 */
export function buildSeededPatternDProvider(
  docNamePrefix: string,
  seed: (ydoc: Y.Doc) => void = (ydoc) => seedFragmentParagraph(ydoc, 'hello world'),
): SeededPatternDProvider {
  const docName = `${docNamePrefix}-${randomUUID()}`;
  const ydoc = new Y.Doc();
  seed(ydoc);
  const fragment = ydoc.getXmlFragment('default');
  const awareness = new Awareness(ydoc);
  const provider = {
    document: ydoc,
    configuration: { name: docName },
    awareness,
  } as unknown as HocuspocusProvider;
  const cleanup = () => {
    awareness.destroy();
    ydoc.destroy();
  };
  return { docName, ydoc, fragment, awareness, provider, cleanup };
}

/** Any Y transaction origin other than the binding's own — in production the
 *  origin is the HocuspocusProvider instance. */
const REMOTE_PROVIDER_ORIGIN = Object.freeze({ kind: 'remote-provider-stand-in' });

/**
 * Apply a remote peer's edit to `local` exactly the way a provider does:
 * replicate state to a second Y.Doc, mutate there, apply the diff update
 * back into `local` with a non-binding origin.
 */
export function applyRemoteEdit(local: Y.Doc, mutate: (fragment: Y.XmlFragment) => void): void {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.transact(() => {
    mutate(remote.getXmlFragment('default'));
  });
  const diff = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local));
  Y.applyUpdate(local, diff, REMOTE_PROVIDER_ORIGIN);
  remote.destroy();
}

export function appendToFirstParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = fragment.get(0) as Y.XmlElement;
  const xmlText = paragraph.get(0) as Y.XmlText;
  xmlText.insert(xmlText.length, text);
}

/** Insert a fresh paragraph node at `index` — the structural counterpart to
 *  `appendToFirstParagraph` for gap edits that add nodes the pre-warm walk
 *  never saw. */
export function insertParagraphAt(fragment: Y.XmlFragment, index: number, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(index, [paragraph]);
}

export async function flushMicrotasksAndTimers(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Ordering recorder for the construct→mount-gap timing invariant.
 *
 * The gap tests rely on a `queueMicrotask`-applied edit landing in the
 * post-construct `await scheduler.yield()` window — after `construct()`
 * returns and BEFORE `editor.mount()` creates the EditorView. That ordering
 * is the whole point of the fix under test: if `scheduler.yield()` ever
 * resolved on the microtask queue, the gap edit would land post-mount and the
 * binding's own observer would handle it normally — the tests would pass
 * vacuously without exercising the walk-currency guard at all.
 *
 * The recorder stamps a monotonically-increasing ordinal at two points: when
 * the gap edit is applied (`recordGapEdit`) and when the EditorView is created
 * (`recordViewCreated`, driven by a one-shot ProseMirror `view()` hook — the
 * precise mount signal, fired synchronously during `editor.mount()`, unlike
 * TipTap's `create` event which it defers via `setTimeout(0)`). Ordinals
 * (not timestamps) avoid same-millisecond ties on fast machines. Each slot is
 * stamped at most once.
 */
export interface GapOrderingRecorder {
  recordGapEdit(): void;
  recordViewCreated(): void;
  /** Ordinal stamped when the gap edit was applied; null if it never ran. */
  readonly gapEditOrdinal: number | null;
  /** Ordinal stamped when the EditorView was created; null if it never ran. */
  readonly viewCreatedOrdinal: number | null;
}

export function createGapOrderingRecorder(): GapOrderingRecorder {
  let counter = 0;
  let gapEditOrdinal: number | null = null;
  let viewCreatedOrdinal: number | null = null;
  return {
    recordGapEdit() {
      if (gapEditOrdinal === null) {
        counter += 1;
        gapEditOrdinal = counter;
      }
    },
    recordViewCreated() {
      if (viewCreatedOrdinal === null) {
        counter += 1;
        viewCreatedOrdinal = counter;
      }
    },
    get gapEditOrdinal() {
      return gapEditOrdinal;
    },
    get viewCreatedOrdinal() {
      return viewCreatedOrdinal;
    },
  };
}

/**
 * Test-only extension contributing a ProseMirror plugin whose `view()` hook
 * fires `record.recordViewCreated()` the instant the EditorView is
 * constructed (i.e. inside `editor.mount()`). Mirrors the production
 * walk-currency extension's `new Plugin({ view })` shape. Appended to the
 * Pattern D constructor options so the mount signal is captured on the real
 * mount spine without touching production code.
 */
export function viewCreationSignalExtension(record: GapOrderingRecorder): Extension {
  return Extension.create({
    name: 'viewCreationSignal',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          view: () => {
            record.recordViewCreated();
            return {};
          },
        }),
      ];
    },
  });
}
