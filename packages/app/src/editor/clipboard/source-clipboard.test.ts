
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
    expect(out).toContain('\n');
  });

  test('escapes the dangerous combination of ampersand-and-lt that round-trip naively', () => {
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
    expect(dt.data['text/html']).toBe(
      `<pre class="mdx-component"><code>&lt;script&gt;alert(1)&lt;/script&gt; &amp; co.</code></pre>`,
    );
    expect(dt.data['text/html']).not.toContain('<script>alert(1)</script>');
  });

  test('cut dispatches delete change to remove the selected text from doc', () => {
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
    expect(dt.data['text/plain']).toBe(markdown);
    expect(dt.data['text/html']).toBe(`<pre class="mdx-component"><code>${markdown}</code></pre>`);
  });

  test('copy does NOT dispatch any change (clipboard-only side effect)', () => {
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
