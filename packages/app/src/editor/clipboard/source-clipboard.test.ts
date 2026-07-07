/**
 * Co-located unit tests for the source-mode `text/html` wrapper and the
 * `handleCopyOrCut` empty-selection branch.
 *
 * Coverage:
 *   - `buildSourceModeHtml` produces a single
 *     `<pre class="mdx-component"><code>{markdown}</code></pre>` wrapper.
 *   - `code.textContent = markdown` produces a textNode child rather than
 *     parsed HTML, so HTML-significant bytes (`<`, `>`, `&`) auto-escape on
 *     serialization while quote characters (`"`, `'`) survive verbatim
 *     because they're not special inside textNode content. The markdown
 *     source lands in the destination clipboard without HTML-injection
 *     risk. Multiline markdown with backticks survives.
 *   - `handleCopyOrCut` empty-selection branch sets neither `text/plain`
 *     nor `text/html` on the DataTransfer (clipboard unchanged).
 *   - `handleCopyOrCut` non-empty branch writes both MIMEs.
 *
 * bun-test has no DOM, so we inject a minimal `globalThis.document` fake
 * that replicates the textContent escape semantics needed by the wrapper
 * (escapes `&`, `<`, `>` to entity references on assignment). The fake is
 * sufficient for the wrapper-shape and escape-survival assertions; full
 * cross-browser DOM behavior is exercised by Playwright in the
 * sanitizer-proxy fixture tests and the e2e copy tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildSourceModeHtml, handleCopyOrCut, handlePaste } from './source-clipboard.ts';

interface FakeElement {
  tagName: string;
  className: string;
  children: FakeElement[];
  textContentRaw: string;
  appendChild: (child: FakeElement) => void;
  readonly outerHTML: string;
}

/**
 * Minimal document polyfill for the wrapper helper. Replicates the
 * essential surface `buildSourceModeHtml` touches:
 *   - `createElement(tag)` returns a fresh element with empty class +
 *     children.
 *   - `element.className = '...'` stores the value verbatim.
 *   - `element.textContent = '...'` setter HTML-escapes `&`, `<`, `>` per
 *     CommonMark / HTML5 (the WHATWG DOM spec for textContent assignment).
 *   - `element.outerHTML` getter serializes recursively, applying the
 *     escape on textContent and inlining child elements.
 *
 * Quotes in attribute values are NOT escaped because the wrapper only
 * sets `className = 'mdx-component'` (a fixed literal with no quotes).
 */
function makeFakeDocument(): { document: { createElement: (tag: string) => FakeElement } } {
  const escapeText = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function createElement(tag: string): FakeElement {
    const node: FakeElement = {
      tagName: tag,
      className: '',
      children: [],
      textContentRaw: '',
      appendChild(child: FakeElement) {
        this.children.push(child);
      },
      get outerHTML(): string {
        const classAttr = this.className ? ` class="${this.className}"` : '';
        const inner = this.textContentRaw
          ? escapeText(this.textContentRaw)
          : this.children.map((c) => c.outerHTML).join('');
        return `<${this.tagName}${classAttr}>${inner}</${this.tagName}>`;
      },
    };
    // textContent must be a real setter so production code's `code.textContent
    // = markdown` assigns through it. Defining via Object.defineProperty
    // avoids the TypeScript-incompatibility-with-readonly-getter issue.
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      enumerable: true,
      get(): string {
        return node.textContentRaw;
      },
      set(v: string) {
        node.textContentRaw = v;
      },
    });
    return node;
  }
  return { document: { createElement } };
}

let restoreDocument: PropertyDescriptor | undefined;

beforeEach(() => {
  // Capture any pre-existing `document` (none in bun-test) and overwrite
  // with the fake. We restore in afterEach so the global is left as it was.
  restoreDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const fake = makeFakeDocument();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    enumerable: true,
    value: fake.document,
    writable: true,
  });
});

afterEach(() => {
  if (restoreDocument) {
    Object.defineProperty(globalThis, 'document', restoreDocument);
    return;
  }
  // No prior `document` (the bun-test default) — overwrite with `undefined`
  // rather than `delete`, which Biome's noDelete rule rejects on perf
  // grounds. `globalThis.document = undefined` is functionally equivalent
  // for the next test's beforeEach (it overwrites unconditionally) and
  // does not retain a stale fake reachable across files.
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    enumerable: true,
    value: undefined,
    writable: true,
  });
});

describe('buildSourceModeHtml — source-mode text/html wrapper', () => {
  test('produces the canonical pre.mdx-component / code wrapper', () => {
    const out = buildSourceModeHtml('hello world');
    expect(out).toBe('<pre class="mdx-component"><code>hello world</code></pre>');
  });

  test('escapes < and > via textContent setter (no raw <script> in output)', () => {
    const md = '<script>alert(1)</script>';
    const out = buildSourceModeHtml(md);
    // textContent escape ensures the script tag becomes inert text, not an
    // executable element. The outer `<pre>` and `<code>` are still present
    // verbatim; only the markdown payload is escaped.
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out.startsWith('<pre class="mdx-component"><code>')).toBe(true);
    expect(out.endsWith('</code></pre>')).toBe(true);
  });

  test('escapes ampersand to &amp;', () => {
    const out = buildSourceModeHtml('a & b & c');
    expect(out).toContain('a &amp; b &amp; c');
  });

  test('preserves quote characters as-is (textContent does not escape quotes)', () => {
    // HTML5 textContent assignment does NOT escape `"` or `'` because they
    // are not significant inside element text content (only inside
    // attribute values). The browsers and the WHATWG DOM serialize
    // quotes verbatim in textNode contexts.
    const md = `single ' quote and double " quote`;
    const out = buildSourceModeHtml(md);
    expect(out).toContain(`single ' quote and double " quote`);
  });

  test('preserves multiline markdown including backticks and fenced code', () => {
    const md = [
      '# Heading',
      '',
      'Some prose with `inline code`.',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const out = buildSourceModeHtml(md);
    expect(out).toContain('# Heading');
    expect(out).toContain('Some prose with `inline code`.');
    expect(out).toContain('```ts');
    expect(out).toContain('const x = 1;');
    // Newlines survive verbatim in <code> textContent.
    expect(out).toContain('\n');
  });

  test('escapes the dangerous combination of ampersand-and-lt that round-trip naively', () => {
    // The order of escapes matters: escape `&` first, then `<` and `>`.
    // Otherwise `&lt;` written by the user would become `&amp;lt;` after
    // a second `&` pass. The fake mirrors the production order.
    const md = '&lt;already-escaped&gt;';
    const out = buildSourceModeHtml(md);
    expect(out).toContain('&amp;lt;already-escaped&amp;gt;');
  });
});

interface FakeDataTransfer {
  setData: (mime: string, data: string) => void;
  data: Record<string, string>;
}

function makeFakeDt(): FakeDataTransfer {
  const data: Record<string, string> = {};
  return {
    setData(mime: string, value: string) {
      data[mime] = value;
    },
    data,
  };
}

interface FakeView {
  state: {
    selection: { main: { from: number; to: number } };
    sliceDoc?: (from: number, to: number) => string;
  };
  dispatch: (arg: unknown) => void;
  /** Captured dispatch calls — populated by `makeFakeView`. */
  dispatchCalls: unknown[];
}

function makeFakeView(opts: { from: number; to: number; text?: string }): FakeView {
  const dispatchCalls: unknown[] = [];
  return {
    state: {
      selection: { main: { from: opts.from, to: opts.to } },
      sliceDoc: () => opts.text ?? '',
    },
    dispatch: (arg: unknown) => {
      dispatchCalls.push(arg);
    },
    dispatchCalls,
  };
}

describe('handleCopyOrCut — empty-selection no-op + wrapper integration', () => {
  test('empty selection sets neither text/plain nor text/html, calls preventDefault, returns true', () => {
    const dt = makeFakeDt();
    let prevented = false;
    const event = {
      clipboardData: dt,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ClipboardEvent;
    const view = makeFakeView({ from: 5, to: 5 });
    const result = handleCopyOrCut(event, view as unknown as never, 'copy');
    expect(result).toBe(true);
    expect(prevented).toBe(true);
    expect(dt.data).toEqual({});
  });

  test('non-empty selection writes both text/plain (raw markdown) and text/html (wrapper)', () => {
    const dt = makeFakeDt();
    const event = {
      clipboardData: dt,
      preventDefault: () => {},
    } as unknown as ClipboardEvent;
    const markdown = '# Header\n\n![chart](./Q3-sales.png)';
    const view = makeFakeView({ from: 0, to: markdown.length, text: markdown });
    const result = handleCopyOrCut(event, view as unknown as never, 'copy');
    expect(result).toBe(true);
    expect(dt.data['text/plain']).toBe(markdown);
    expect(dt.data['text/html']).toBe(`<pre class="mdx-component"><code>${markdown}</code></pre>`);
  });

  test('non-empty selection with HTML-special characters escapes via textContent', () => {
    const dt = makeFakeDt();
    const event = {
      clipboardData: dt,
      preventDefault: () => {},
    } as unknown as ClipboardEvent;
    const markdown = '<script>alert(1)</script> & co.';
    const view = makeFakeView({ from: 0, to: markdown.length, text: markdown });
    handleCopyOrCut(event, view as unknown as never, 'copy');
    expect(dt.data['text/plain']).toBe(markdown);
    // Wrapper escapes — never carries an executable script tag in text/html.
    expect(dt.data['text/html']).toBe(
      `<pre class="mdx-component"><code>&lt;script&gt;alert(1)&lt;/script&gt; &amp; co.</code></pre>`,
    );
    expect(dt.data['text/html']).not.toContain('<script>alert(1)</script>');
  });

  test('cut dispatches delete change to remove the selected text from doc', () => {
    // The cut branch must mutate the document — empty-string insert over
    // the selection range deletes the text. Without this dispatch the
    // user would see "cut" leaving the source text in place, which would
    // make cut indistinguishable from copy.
    const dt = makeFakeDt();
    const event = {
      clipboardData: dt,
      preventDefault: () => {},
    } as unknown as ClipboardEvent;
    const markdown = 'selected text';
    const view = makeFakeView({ from: 3, to: 3 + markdown.length, text: markdown });
    const result = handleCopyOrCut(event, view as unknown as never, 'cut');
    expect(result).toBe(true);
    expect(view.dispatchCalls).toHaveLength(1);
    expect(view.dispatchCalls[0]).toEqual({
      changes: { from: 3, to: 3 + markdown.length, insert: '' },
    });
    // Clipboard payloads still written, same as copy.
    expect(dt.data['text/plain']).toBe(markdown);
    expect(dt.data['text/html']).toBe(`<pre class="mdx-component"><code>${markdown}</code></pre>`);
  });

  test('copy does NOT dispatch any change (clipboard-only side effect)', () => {
    // Copy reads from the doc and writes to the clipboard; the doc is
    // untouched. No `view.dispatch` call should fire on the copy branch
    // — a regression that adds one would silently mutate the user's
    // document on every copy gesture.
    const dt = makeFakeDt();
    const event = {
      clipboardData: dt,
      preventDefault: () => {},
    } as unknown as ClipboardEvent;
    const markdown = 'selected text';
    const view = makeFakeView({ from: 3, to: 3 + markdown.length, text: markdown });
    const result = handleCopyOrCut(event, view as unknown as never, 'copy');
    expect(result).toBe(true);
    expect(view.dispatchCalls).toHaveLength(0);
    expect(dt.data['text/plain']).toBe(markdown);
  });
});

function makePasteEvent(data: Record<string, string>): ClipboardEvent & { prevented: boolean } {
  const event = {
    prevented: false,
    clipboardData: {
      types: Object.keys(data),
      getData: (mime: string) => data[mime] ?? '',
    },
    preventDefault() {
      this.prevented = true;
    },
  };
  return event as unknown as ClipboardEvent & { prevented: boolean };
}

describe('handlePaste — source mode paste dispatch', () => {
  test('source-mode HTML wrapper with plain text delegates to CM6 verbatim paste', () => {
    const event = makePasteEvent({
      'text/plain': 'test',
      'text/html': '<pre class="mdx-component"><code>test</code></pre>',
    });
    const view = makeFakeView({ from: 0, to: 0, text: '' });

    const handled = handlePaste(event, view as unknown as never, {
      ydoc: {} as never,
      ytext: {} as never,
    });

    expect(handled).toBe(false);
    expect(event.prevented).toBe(false);
    expect(view.dispatchCalls).toHaveLength(0);
  });

  test('source-mode HTML wrapper variants with extra attributes still delegate to CM6', () => {
    const htmlVariants = [
      '<pre class="mdx-component" data-ok="1"><code>test</code></pre>',
      '<pre id="wrapper" class="mdx-component"><code>test</code></pre>',
    ];

    for (const html of htmlVariants) {
      const event = makePasteEvent({
        'text/plain': 'test',
        'text/html': html,
      });
      const view = makeFakeView({ from: 0, to: 0, text: '' });

      const handled = handlePaste(event, view as unknown as never, {
        ydoc: {} as never,
        ytext: {} as never,
      });

      expect(handled).toBe(false);
      expect(event.prevented).toBe(false);
      expect(view.dispatchCalls).toHaveLength(0);
    }
  });

  test('non-source pre/code HTML still routes through Branch D', () => {
    const event = makePasteEvent({
      'text/plain': 'test',
      'text/html': '<pre class="other"><code>test</code></pre>',
    });
    const view = makeFakeView({ from: 0, to: 0, text: '' });

    const handled = handlePaste(event, view as unknown as never, {
      ydoc: {} as never,
      ytext: {} as never,
    });

    expect(handled).toBe(true);
    expect(event.prevented).toBe(true);
    expect(view.dispatchCalls).toHaveLength(1);
  });

  test('source-mode wrapper with no text/plain routes through Branch D', () => {
    const event = makePasteEvent({
      'text/html': '<pre class="mdx-component"><code>test</code></pre>',
    });
    const view = makeFakeView({ from: 0, to: 0, text: '' });

    const handled = handlePaste(event, view as unknown as never, {
      ydoc: {} as never,
      ytext: {} as never,
    });

    expect(handled).toBe(true);
    expect(event.prevented).toBe(true);
    expect(view.dispatchCalls).toHaveLength(1);
  });

  test('VS Code clipboard metadata does not wrap text/plain in a fenced code block', () => {
    const event = makePasteEvent({
      'vscode-editor-data': '{"mode":"markdown"}',
      'text/plain': '# Pasted markdown\n\nPlain paragraph.',
    });
    const view = makeFakeView({ from: 0, to: 0, text: '' });

    const handled = handlePaste(event, view as unknown as never, {
      ydoc: {} as never,
      ytext: {} as never,
    });

    expect(handled).toBe(false);
    expect(event.prevented).toBe(false);
    expect(view.dispatchCalls).toHaveLength(0);
  });

  test('VS Code TypeScript payload does not insert a fenced code block', () => {
    const event = makePasteEvent({
      'vscode-editor-data': '{"mode":"typescript"}',
      'text/plain': 'const x = 1;',
    });
    const view = makeFakeView({ from: 0, to: 0, text: '' });

    const handled = handlePaste(event, view as unknown as never, {
      ydoc: {} as never,
      ytext: {} as never,
    });

    expect(handled).toBe(false);
    expect(event.prevented).toBe(false);
    expect(view.dispatchCalls).toHaveLength(0);
  });

  test('VS Code paste with text/html still delegates to CM6 default (Branch A wins over Branch D)', () => {
    const event = makePasteEvent({
      'vscode-editor-data': '{"mode":"typescript"}',
      'text/plain': 'const x = 1;',
      'text/html': '<div style="color:#d4d4d4"><span>const x = 1;</span></div>',
    });
    const view = makeFakeView({ from: 0, to: 0, text: '' });
    const handled = handlePaste(event, view as unknown as never, {
      ydoc: {} as never,
      ytext: {} as never,
    });
    expect(handled).toBe(false);
    expect(event.prevented).toBe(false);
    expect(view.dispatchCalls).toHaveLength(0);
  });
});
