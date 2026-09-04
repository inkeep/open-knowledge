import { JSDOM } from 'jsdom';
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

export async function flushMicrotasksAndTimers(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
