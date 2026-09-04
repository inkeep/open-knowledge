import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider } from '@hocuspocus/provider';
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
  copy: () => false,
} as unknown as ClipboardArg;

export function seedFragmentParagraph(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
}

interface SeededPatternDProvider {
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

export function appendToFirstParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = fragment.get(0) as Y.XmlElement;
  const xmlText = paragraph.get(0) as Y.XmlText;
  xmlText.insert(xmlText.length, text);
}

export async function flushMicrotasksAndTimers(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
