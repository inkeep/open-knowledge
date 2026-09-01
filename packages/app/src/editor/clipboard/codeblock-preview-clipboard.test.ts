import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildPreviewIframeHeader } from '../extensions/preview-iframe-header.ts';
import { sharedExtensions } from '../extensions/shared.ts';
import { OPT_OUT_ATTR } from './clipboard-sanitize.ts';
import { type WalkerEnv, walkLiveDomToInlineStyledFragment } from './clipboard-walker.ts';

function installDomGlobals(): () => void {
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
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(installed)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalRecord, key);
    }
    dom.window.close();
  };
}

let restore: (() => void) | null = null;
beforeAll(() => {
  restore = installDomGlobals();
});
afterAll(() => {
  restore?.();
  restore = null;
});

const schema = getSchema(sharedExtensions);
const CODE = '<h1>Hi</h1>\n<script>document.title="x"</script>';

function previewCodeBlockDoc(): PmNode {
  const code = schema.text(CODE);
  const codeBlock = schema.nodes.codeBlock.create({ language: 'html', meta: 'preview' }, code);
  return schema.nodes.doc.create(null, codeBlock);
}

function buildCodeBlockPreviewDom(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'ok-codeblock relative my-3';
  wrapper.setAttribute('data-preview', 'true');
  wrapper.setAttribute('data-code-visible', 'false');

  const preview = document.createElement('div');
  preview.className = 'ok-codeblock-preview ok-codeblock-preview--solo';
  preview.setAttribute('contenteditable', 'false');
  preview.setAttribute('style', 'height: 320px; width: 480px;');

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'HTML preview');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('srcdoc', buildPreviewIframeHeader('light') + CODE);
  iframe.className = 'ok-codeblock-preview-frame';
  preview.appendChild(iframe);

  const handles = document.createElement('div');
  handles.className = 'ok-resize-handles';
  for (const dir of ['e', 's', 'se']) {
    const h = document.createElement('div');
    h.className = `ok-resize-handle ok-resize-handle-${dir}`;
    handles.appendChild(h);
  }
  preview.appendChild(handles);
  wrapper.appendChild(preview);

  const pre = document.createElement('pre');
  pre.className = 'ok-codeblock-pre m-0 overflow-x-auto px-5 py-4 font-mono text-sm';
  pre.setAttribute('aria-hidden', 'true');
  const code = document.createElement('code');
  code.className = 'hljs block whitespace-pre bg-transparent p-0 language-html';
  code.textContent = CODE;
  pre.appendChild(code);
  wrapper.appendChild(pre);

  const chrome = document.createElement('div');
  chrome.className = 'ok-codeblock-chrome';
  chrome.setAttribute('contenteditable', 'false');
  chrome.setAttribute(OPT_OUT_ATTR, 'true');
  const btn = document.createElement('button');
  btn.textContent = 'copy';
  chrome.appendChild(btn);
  wrapper.appendChild(chrome);

  return wrapper;
}

function fakeView(doc: PmNode, nodeDom: HTMLElement) {
  const codeBlock = doc.firstChild;
  if (!codeBlock) throw new Error('expected a codeBlock child');
  return {
    state: {
      doc,
      selection: { from: 0, to: codeBlock.nodeSize },
    },
    nodeDOM: (pos: number) => (pos === 0 ? nodeDom : null),
  } as unknown as Parameters<typeof walkLiveDomToInlineStyledFragment>[1];
}

function unmountedView(doc: PmNode) {
  const codeBlock = doc.firstChild;
  if (!codeBlock) throw new Error('expected a codeBlock child');
  return {
    state: {
      doc,
      selection: { from: 0, to: codeBlock.nodeSize },
    },
    nodeDOM: () => null,
  } as unknown as Parameters<typeof walkLiveDomToInlineStyledFragment>[1];
}

function emitFragmentHtml(): { holder: HTMLElement; html: string } {
  const doc = previewCodeBlockDoc();
  const nodeDom = buildCodeBlockPreviewDom();
  const env: WalkerEnv = {
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  const frag = walkLiveDomToInlineStyledFragment(
    undefined as unknown as Parameters<typeof walkLiveDomToInlineStyledFragment>[0],
    fakeView(doc, nodeDom),
    env,
  );
  const holder = document.createElement('div');
  holder.appendChild(frag);
  return { holder, html: holder.innerHTML };
}

describe('preview-active codeBlock clipboard emission (text/html tier)', () => {
  test('emits no iframe / srcdoc render-header into the payload', () => {
    const { holder, html } = emitFragmentHtml();
    expect(holder.querySelector('iframe')).toBeNull();
    expect(html).not.toContain('srcdoc');
    expect(html).not.toContain('Content-Security-Policy');
  });

  test('emits no preview render chrome (resize handles) into the payload', () => {
    const { holder } = emitFragmentHtml();
    expect(holder.querySelector('.ok-resize-handle')).toBeNull();
    expect(holder.querySelector('.ok-codeblock-preview')).toBeNull();
  });

  test('emits the clean code source, present and not destination-hidden', () => {
    const { holder } = emitFragmentHtml();
    const pre = holder.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent ?? '').toContain('<h1>Hi</h1>');
    expect(pre?.getAttribute('style') ?? '').not.toContain('display');
  });
});

describe('preview-active codeBlock clipboard emission — Activity-hidden (unmounted) path', () => {
  function emitFromUnmounted(): { holder: HTMLElement; html: string } {
    const doc = previewCodeBlockDoc();
    const env: WalkerEnv = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
    };
    const frag = walkLiveDomToInlineStyledFragment(
      undefined as unknown as Parameters<typeof walkLiveDomToInlineStyledFragment>[0],
      unmountedView(doc),
      env,
    );
    const holder = document.createElement('div');
    holder.appendChild(frag);
    return { holder, html: holder.innerHTML };
  }

  test('emits the clean fenced source, not an empty (dropped) payload', () => {
    const { holder } = emitFromUnmounted();
    const pre = holder.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent ?? '').toContain('<h1>Hi</h1>');
    expect(pre?.textContent ?? '').toContain('html preview');
  });

  test('emits no iframe / srcdoc render internals via the palette path', () => {
    const { holder, html } = emitFromUnmounted();
    expect(holder.querySelector('iframe')).toBeNull();
    expect(html).not.toContain('srcdoc');
  });
});
