/**
 * Composition guard for the preview NodeView → iframe `srcdoc` wiring.
 *
 * `code-block-preview-csp.test.ts` pins `buildPreviewIframeHeader` in
 * isolation; this test pins that its output actually reaches the rendered
 * iframe — a dropped header or a hardcoded string would ship the wrong CSP to
 * the live preview. The CSP is no longer configurable (the iframe runs a fixed
 * open network policy), so this asserts the open directives land in the
 * `srcdoc`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Config } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/core';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { CodeBlockView } from './CodeBlockView';
import { setEditorDocName } from './doc-context';

function makeConfigValue(merged: Config | null): ConfigContextValue {
  return {
    userBinding: null,
    userSynced: false,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: null,
    projectLocalConfig: null,
    projectSynced: false,
    projectLocalSynced: false,
    merged,
  };
}

function makeEditor(): NodeViewProps['editor'] {
  return {
    isEditable: true,
    isDestroyed: false,
    state: {
      doc: { nodeAt: () => ({ nodeSize: 10 }) },
      selection: { from: 0, to: 0 },
    },
    on: () => {},
    off: () => {},
  } as unknown as NodeViewProps['editor'];
}

// `language: 'html'` + `meta: 'preview'` makes `shouldShowPreview` true, so
// the preview iframe (the surface under test) actually renders.
function makeProps(): NodeViewProps {
  return {
    editor: makeEditor(),
    node: {
      attrs: { language: 'html', meta: 'preview' },
      textContent: '<div id="probe">hello</div>',
    },
    getPos: () => 0,
    selected: false,
    updateAttributes: () => {},
  } as unknown as NodeViewProps;
}

function renderSrcdoc(): string {
  const { container } = render(
    <ConfigContext value={makeConfigValue(null)}>
      <CodeBlockView {...makeProps()} />
    </ConfigContext>,
  );
  const iframe = container.querySelector('iframe');
  expect(iframe).toBeTruthy();
  return iframe?.getAttribute('srcdoc') ?? '';
}

describe('CodeBlockView preview-CSP wiring', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders the fixed open-network CSP in the iframe srcdoc', () => {
    const srcdoc = renderSrcdoc();
    // The builder's open directives flow through the NodeView into the iframe.
    expect(srcdoc).toContain("script-src 'unsafe-inline' https:");
    expect(srcdoc).toContain('connect-src https:');
    expect(srcdoc).toContain('img-src https:');
    expect(srcdoc).not.toContain("connect-src 'none'");
    expect(srcdoc).not.toContain("'unsafe-eval'");
    // The body still rides after the header — guards the `+ node.textContent`.
    expect(srcdoc).toContain('<div id="probe">hello</div>');
  });
});

describe('CodeBlockView edit-source modal language wiring', () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * Regression for the silent-degrade bug:
   * `normalizeCodeLanguage('html')` returns `'xml'` (the canonical lowlight
   * key), so a stale `normalized === 'html'` guard at the modal call site
   * always evaluated false and the modal opened with `language="plain"` —
   * no Lezer tree → no token spans → blank-coloring source pane. Pinning
   * the rendered `data-language` attribute on the modal source host
   * catches a regression of that exact shape: any future alias-tree
   * rework that re-introduces the bug would fail this test.
   */
  test('html-preview fence opens edit-source modal with language="html"', () => {
    const { container } = render(
      <ConfigContext value={makeConfigValue(null)}>
        <CodeBlockView {...makeProps()} />
      </ConfigContext>,
    );
    const editBtn = container.querySelector(
      'button[aria-label="Edit source"]',
    ) as HTMLButtonElement | null;
    expect(editBtn).toBeTruthy();
    fireEvent.click(editBtn as HTMLButtonElement);
    // Radix portals dialog content to document.body — query off the document.
    const sourceHost = document.querySelector('[data-testid="ok-code-preview-edit-modal-source"]');
    expect(sourceHost).toBeTruthy();
    expect(sourceHost?.getAttribute('data-language')).toBe('html');
  });
});

/**
 * Pins the parent-side CSP-violation seam that the unit tests cannot reach:
 * the bootstrap test stops at the iframe's `postMessage`, and
 * `PreviewBlockedNotice.dom.test.tsx` starts at the component's props. This is
 * the wire between them — `onMessage` parses a report from THIS iframe into
 * state and renders the notice, `onLoad` clears it, and a report from a foreign
 * window is dropped by the `e.source` filter.
 */
describe('CodeBlockView CSP-violation notice wiring', () => {
  afterEach(() => {
    cleanup();
  });

  function renderPreview() {
    const utils = render(
      <ConfigContext value={makeConfigValue(null)}>
        <CodeBlockView {...makeProps()} />
      </ConfigContext>,
    );
    const iframe = utils.container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    return { ...utils, iframe };
  }

  // jsdom's MessageEvent constructor rejects a Window as `source` (it requires a
  // MessagePort), so build a plain message Event and attach `source` + `data`
  // directly — the handler only reads those two fields.
  function cspReport(source: unknown) {
    const evt = new Event('message');
    Object.defineProperty(evt, 'source', { value: source, configurable: true });
    Object.defineProperty(evt, 'data', {
      value: {
        okPreviewCspViolation: {
          blocked: [{ directive: 'img-src', uri: 'http://insecure.example/tile.png' }],
          truncated: false,
        },
      },
      configurable: true,
    });
    return evt;
  }

  test('shows no notice before any CSP report arrives', () => {
    // `blockedRequests` initializes to null and the render gates on it; a
    // non-null default would paint a spurious notice on every preview mount.
    const { container } = renderPreview();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('a CSP report from this iframe surfaces the blocked-request notice', () => {
    const { iframe, container } = renderPreview();
    act(() => {
      window.dispatchEvent(cspReport(iframe.contentWindow));
    });
    const notice = container.querySelector('[role="status"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('http://insecure.example/tile.png');
  });

  test('reloading the iframe clears the notice (re-evaluated policy)', () => {
    const { iframe, container } = renderPreview();
    act(() => {
      window.dispatchEvent(cspReport(iframe.contentWindow));
    });
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    fireEvent.load(iframe);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('a report from a different window is ignored', () => {
    const { container } = renderPreview();
    act(() => {
      window.dispatchEvent(cspReport(window));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('dismissing the notice removes it', () => {
    const { iframe, container } = renderPreview();
    act(() => {
      window.dispatchEvent(cspReport(iframe.contentWindow));
    });
    const dismiss = container.querySelector(
      'button[aria-label="Dismiss notice"]',
    ) as HTMLButtonElement | null;
    expect(dismiss).toBeTruthy();
    fireEvent.click(dismiss as HTMLButtonElement);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

/**
 * Pins the Ask AI click handler on the code-block chrome — specifically the
 * hand-built triple-backtick fence around the block body. A body containing
 * literal ``` sequences would close a 3-backtick wrapper early and the
 * receiving agent would see truncated code + orphan closer text.
 */
describe('CodeBlockView Ask AI click handler', () => {
  afterEach(() => {
    cleanup();
  });

  function makePropsWithBody(body: string, language = 'html', meta = 'preview'): NodeViewProps {
    return {
      editor: makeEditor(),
      node: { attrs: { language, meta }, textContent: body },
      getPos: () => 0,
      selected: false,
      updateAttributes: () => {},
    } as unknown as NodeViewProps;
  }

  async function captureTerminalDispatch(
    props: NodeViewProps,
    docName: string,
  ): Promise<string | null> {
    setEditorDocName(props.editor, docName);
    const received: string[] = [];
    const handler = (e: Event) => {
      received.push((e as CustomEvent<string>).detail);
    };
    window.addEventListener('open-knowledge:active-terminal-input', handler);
    try {
      const { container } = render(
        <ConfigContext value={makeConfigValue(null)}>
          <CodeBlockView {...props} />
        </ConfigContext>,
      );
      const askBtn = container.querySelector(
        '[data-testid="ok-codeblock-ask-ai-btn"]',
      ) as HTMLButtonElement | null;
      expect(askBtn).toBeTruthy();
      fireEvent.click(askBtn as HTMLButtonElement);
      // Click handler defers to rAF; give one paint tick for the dispatch.
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      return received[0] ?? null;
    } finally {
      window.removeEventListener('open-knowledge:active-terminal-input', handler);
    }
  }

  // Read the run of backticks that opens the passage's inner fence, keyed off
  // the info-string sentinel that follows it. `composeSelectionPrompt` wraps
  // OUR selectionMarkdown inside its own OUTER fence (whose length is our
  // fence + 1), so we can't just count leading backticks in the dispatch —
  // we have to isolate the run immediately preceding the info string.
  function readInnerFenceLength(prompt: string, infoSentinel: string): number {
    const idx = prompt.indexOf(infoSentinel);
    if (idx <= 0) return 0;
    let n = 0;
    for (let i = idx - 1; i >= 0 && prompt[i] === '`'; i--) n++;
    return n;
  }

  test('body without triple-backticks wraps in a 3-backtick fence', async () => {
    const dispatched = await captureTerminalDispatch(
      makePropsWithBody('<div id="probe">hello</div>'),
      'notes/example',
    );
    expect(dispatched).not.toBeNull();
    const fenceLen = readInnerFenceLength(dispatched ?? '', 'html preview\n<div id=');
    // A body without any backtick run → CommonMark minimum fence (3).
    expect(fenceLen).toBe(3);
    // The body's exact content survives inside the wrapper.
    expect(dispatched).toContain('<div id="probe">hello</div>');
  });

  test('body containing ``` is wrapped in a fence long enough to outlast the inner run', async () => {
    // Nested markdown: the fenced example inside the outer body includes a
    // 3-backtick block. A hand-built 3-backtick wrapper would truncate here
    // after the first inner closer and the receiving agent would see mangled
    // markdown. The outer fence must be at least 4.
    const body = 'Nested:\n```js\nconsole.log(1);\n```\ntrailing';
    const dispatched = await captureTerminalDispatch(
      makePropsWithBody(body, 'markdown', ''),
      'notes/example',
    );
    expect(dispatched).not.toBeNull();
    const fenceLen = readInnerFenceLength(dispatched ?? '', 'markdown\nNested:');
    expect(fenceLen).toBe(4);
    // The inner 3-backtick example must survive verbatim (no truncation).
    expect(dispatched).toContain('```js\nconsole.log(1);\n```');
    expect(dispatched).toContain('\ntrailing\n');
  });

  test('body containing a 4-backtick run bumps the outer fence to 5', async () => {
    const body = 'longer:\n````\nunusual\n````';
    const dispatched = await captureTerminalDispatch(
      makePropsWithBody(body, 'markdown', ''),
      'notes/example',
    );
    expect(dispatched).not.toBeNull();
    const fenceLen = readInnerFenceLength(dispatched ?? '', 'markdown\nlonger:');
    expect(fenceLen).toBe(5);
    // The inner 4-backtick block survives verbatim (unusual, but round-trips).
    expect(dispatched).toContain('````\nunusual\n````');
  });
});
