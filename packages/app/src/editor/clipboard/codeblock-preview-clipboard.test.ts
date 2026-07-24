/**
 * Clipboard fidelity contract (WYSIWYG app tier): a preview-active `html
 * preview` code block must NOT leak its non-portable render internals into the
 * cross-app `text/html` payload.
 *
 * Domain invariant: when a preview-active code-block NodeView is fully selected
 * and copied, the live-DOM walker tier must emit the clean `<pre><code>` source
 * representation of the block — never the `.ok-codeblock-preview` render
 * (`<iframe srcdoc>` whose srcdoc is the CSP-meta + theme-CSS + bootstrap-JS
 * header from buildPreviewIframeHeader, plus a duplicate of the code, plus the
 * ResizeHandles chrome). This is the same guarantee the walker already enforces
 * for the other non-portable live renders (block Math KaTeX, Mermaid SVG): a
 * destination (Gmail, Notion, Slack, Docs) receives readable source, not
 * several KB of inert `srcdoc` markup and render chrome.
 *
 * Mechanism-agnostic on purpose. The invariant has two candidate enforcement
 * points — source-fallback recognition of a preview-active code block at the
 * walker boundary, OR opt-out enrollment of the preview wrapper so the walker
 * drops it and the clean `<pre>` sibling carries the block. Either satisfies
 * the invariant; the oracle here asserts ONLY on the emitted fragment shape, so
 * it does not pin which mechanism the fix uses.
 *
 * Substrate: drives the REAL production `walkLiveDomToInlineStyledFragment`
 * against a `nodeDOM` that mirrors CodeBlockView's preview-active render. A bare
 * EditorView registers no React nodeViews (it renders the default `<pre><code>`
 * and never the preview iframe), so the NodeView DOM the walker sees in
 * production is supplied explicitly — every transformation under test is
 * production code. jsdom globals are installed in beforeAll and RESTORED in
 * afterAll so sibling no-DOM unit files keep their contract. Same pattern as
 * `clipboard-line-structure.test.ts`.
 */

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

/** A real one-codeBlock doc: fence `html preview` with an HTML body. */
function previewCodeBlockDoc(): PmNode {
  const code = schema.text(CODE);
  const codeBlock = schema.nodes.codeBlock.create({ language: 'html', meta: 'preview' }, code);
  return schema.nodes.doc.create(null, codeBlock);
}

/**
 * Build a DOM subtree carrying the non-portable content of CodeBlockView's
 * preview-active render: `.ok-codeblock` wrapper → `.ok-codeblock-preview`
 * (iframe[srcdoc] + resize-handle chrome) + hidden `<pre>` + opted-out
 * `.ok-codeblock-chrome`.
 *
 * The load-bearing property is that the preview wrapper itself carries NO
 * clipboard opt-out — that is why the walker must recognise the block and emit
 * source rather than drop it. This reproduces enough of that shape to make the
 * leak assertions meaningful; it is not a byte-faithful mirror of every class
 * name (the resize-handle markup in particular is abbreviated — the walker
 * replaces the whole preview subtree regardless, so the assertions key on the
 * stable `.ok-resize-handle` / `.ok-codeblock-preview` base classes). A fix
 * that enrolls the wrapper in the opt-out instead would change this render;
 * keep the fixture in lock-step with CodeBlockView in that case — the
 * assertions below stay identical either way.
 */
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

/** Minimal EditorView stand-in — the walker only touches these members. */
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

/**
 * A view whose live DOM is unmounted for the block — `nodeDOM` returns null,
 * the Activity-hidden case where the walker defers to `paletteFor` instead of
 * cloning the live tree. The palette must emit the same clean source shape the
 * mounted path does, or the block is silently dropped from the payload.
 */
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
    // slice arg is unused by the walker (it reads view.state.selection).
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
    // The code body survives as readable source text (either the live
    // `<pre><code>` clone or a source-fallback `<pre class="mdx-component">`).
    expect(pre?.textContent ?? '').toContain('<h1>Hi</h1>');
    // Not hidden at destinations: no inline display:none rides on the block
    // (visual hiding of the live `<pre>` is app-stylesheet-only, keyed on
    // `data-code-visible`, and `display` is excluded from the walker's
    // STYLE_ALLOWLIST — so the emitted clone must render).
    expect(pre?.getAttribute('style') ?? '').not.toContain('display');
  });
});

describe('preview-active codeBlock clipboard emission — Activity-hidden (unmounted) path', () => {
  // When the block lives inside an `<Activity mode="hidden">` subtree its live
  // DOM is unmounted, so `view.nodeDOM(pos)` is null and the walker defers to
  // the static `paletteFor` fallback. The palette must emit the SAME clean
  // fenced source the mounted path does — otherwise a preview-active code block
  // is silently dropped from the payload (the block Math / Mermaid palette
  // entries already guarantee this symmetry for their non-portable renders).
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
    // The authored info-string rides along so a markdown-aware destination
    // re-parses back to a preview-active code block, not a plain fence.
    expect(pre?.textContent ?? '').toContain('html preview');
  });

  test('emits no iframe / srcdoc render internals via the palette path', () => {
    const { holder, html } = emitFromUnmounted();
    expect(holder.querySelector('iframe')).toBeNull();
    expect(html).not.toContain('srcdoc');
  });
});
