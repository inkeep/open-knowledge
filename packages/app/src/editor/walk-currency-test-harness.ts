
import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { type Editor, Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { JSDOM } from 'jsdom';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { buildPatternDConstructorOptions } from './TiptapEditor';

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
  cleanup: () => void;
}

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

export interface GapOrderingRecorder {
  recordGapEdit(): void;
  recordViewCreated(): void;
  readonly gapEditOrdinal: number | null;
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
