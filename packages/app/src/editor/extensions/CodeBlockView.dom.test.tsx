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

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Config } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/core';
import { subscribeToOpenAskAiComposer } from '@/components/ask-ai-composer-events';
import { subscribeToActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';

// The Ask AI click handler routes through `serializeWysiwygSelection`, which
// runs the full markdown pipeline against the selected slice. Testing that
// pipeline end-to-end is the fidelity suite's job; this file tests the
// click→dispatch contract, so stub the serializer to a fixed fenced body.
mock.module('../edit-with-ai-selection', () => ({
  serializeWysiwygSelection: () => '```json\n{ "name": "sample" }\n```',
}));

// Import the NodeView AFTER the mock registers so its `../edit-with-ai-selection`
// import binds to the stub serializer rather than the real markdown pipeline.
const { CodeBlockView } = await import('./CodeBlockView');
const { setEditorDocName } = await import('./doc-context');

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
 * Pins the click→dispatch contract for the code-block chrome's Ask AI button.
 * The button drives the block through `setNodeSelection` → serialize →
 * `composeSelectionPrompt` → `requestActiveTerminalInput`; `TerminalSessionsHost`
 * either pastes into a live PTY or launches a fresh Claude tab. This file
 * exercises the button's own decisions (guarded position lookup, doc-grounded
 * dispatch, composer fallback for the empty / no-doc branches); the serializer
 * is stubbed above and the pipeline is covered by the fidelity suite.
 */
describe('CodeBlockView Ask AI dispatch', () => {
  // rAF is used to defer the dispatch a frame; polyfill for jsdom under bun.
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
  }

  let terminalInputs: string[] = [];
  let composerOpens = 0;
  let unsubscribeTerminal: (() => void) | null = null;
  let unsubscribeComposer: (() => void) | null = null;

  afterEach(() => {
    unsubscribeTerminal?.();
    unsubscribeTerminal = null;
    unsubscribeComposer?.();
    unsubscribeComposer = null;
    terminalInputs = [];
    composerOpens = 0;
    cleanup();
  });

  function subscribeAll() {
    unsubscribeTerminal = subscribeToActiveTerminalInput((text) => {
      terminalInputs.push(text);
    });
    unsubscribeComposer = subscribeToOpenAskAiComposer(() => {
      composerOpens += 1;
    });
  }

  interface EditorMockOverrides {
    setNodeSelectionThrows?: 'range' | 'other';
  }

  // Fake editor shaped enough for the click handler: `.commands.setNodeSelection`
  // is a spy that either records the pos or throws, and `state.selection.empty`
  // reads false (my code doesn't check it, but leaving a NodeSelection-ish
  // shape here matches production). `serializeWysiwygSelection` is stubbed at
  // module load so it never touches `state` directly.
  function makeEditorWithCommands(overrides: EditorMockOverrides = {}) {
    const setNodeSelection = (_pos: number) => {
      if (overrides.setNodeSelectionThrows === 'range') {
        throw new RangeError('Position 5 out of range');
      }
      if (overrides.setNodeSelectionThrows === 'other') {
        throw new Error('unrelated failure');
      }
    };
    return {
      isEditable: true,
      isDestroyed: false,
      commands: { setNodeSelection },
      state: {
        doc: { nodeAt: () => ({ nodeSize: 10 }) },
        selection: { from: 0, to: 0, empty: false },
      },
      on: () => {},
      off: () => {},
    } as unknown as NodeViewProps['editor'];
  }

  function makeAskAiProps(overrides: EditorMockOverrides = {}, pos: number | undefined = 5) {
    return {
      editor: makeEditorWithCommands(overrides),
      node: {
        attrs: { language: 'json', meta: null },
        textContent: '{ "name": "sample" }',
      },
      getPos: pos === undefined ? undefined : () => pos,
      selected: false,
      updateAttributes: () => {},
    } as unknown as NodeViewProps;
  }

  function renderAskAi(props: NodeViewProps) {
    return render(
      <ConfigContext value={makeConfigValue(null)}>
        <CodeBlockView {...props} />
      </ConfigContext>,
    );
  }

  test('click with a grounded doc dispatches a composed prompt to the terminal input channel', async () => {
    subscribeAll();
    const props = makeAskAiProps();
    setEditorDocName(props.editor, 'specs/foo/SPEC');
    const { container } = renderAskAi(props);

    const askBtn = container.querySelector(
      '[data-testid="ok-codeblock-ask-ai-btn"]',
    ) as HTMLButtonElement | null;
    expect(askBtn).toBeTruthy();
    fireEvent.click(askBtn as HTMLButtonElement);

    await waitFor(() => expect(terminalInputs).toHaveLength(1));
    const [prompt] = terminalInputs;
    // Doc named as an @-mention (grounding contract from composeSelectionPrompt).
    expect(prompt).toContain('@specs/foo/SPEC.md');
    // Stubbed fenced body survives verbatim into the composed prompt.
    expect(prompt).toContain('```json');
    expect(prompt).toContain('{ "name": "sample" }');
    // Terminal-input branch does NOT open the composer.
    expect(composerOpens).toBe(0);
  });

  test('click with no registered doc name opens the composer instead of dispatching', async () => {
    subscribeAll();
    const props = makeAskAiProps();
    // No setEditorDocName — getEditorDocName returns null.
    renderAskAi(props);
    const askBtn = document.querySelector(
      '[data-testid="ok-codeblock-ask-ai-btn"]',
    ) as HTMLButtonElement | null;
    expect(askBtn).toBeTruthy();
    fireEvent.click(askBtn as HTMLButtonElement);

    await waitFor(() => expect(composerOpens).toBe(1));
    expect(terminalInputs).toEqual([]);
  });

  test('click with a stale position (setNodeSelection throws RangeError) neither crashes nor dispatches', async () => {
    subscribeAll();
    const props = makeAskAiProps({ setNodeSelectionThrows: 'range' });
    setEditorDocName(props.editor, 'specs/foo/SPEC');
    // Silence the classified warn so the test log stays clean; the classification
    // itself is what we're asserting via the no-dispatch + no-throw combo.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      renderAskAi(props);
      const askBtn = document.querySelector(
        '[data-testid="ok-codeblock-ask-ai-btn"]',
      ) as HTMLButtonElement | null;
      expect(askBtn).toBeTruthy();
      expect(() => fireEvent.click(askBtn as HTMLButtonElement)).not.toThrow();
      // Give any deferred rAF a chance to fire before asserting nothing landed.
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));
      expect(terminalInputs).toEqual([]);
      expect(composerOpens).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('a non-RangeError from setNodeSelection is re-thrown (guard does not swallow real bugs)', async () => {
    subscribeAll();
    const props = makeAskAiProps({ setNodeSelectionThrows: 'other' });
    setEditorDocName(props.editor, 'specs/foo/SPEC');
    renderAskAi(props);
    const askBtn = document.querySelector(
      '[data-testid="ok-codeblock-ask-ai-btn"]',
    ) as HTMLButtonElement | null;
    expect(askBtn).toBeTruthy();
    // A throw from a React 19 event handler is not caught by RTL's fireEvent
    // under jsdom; the runtime reports the uncaught error to the window 'error'
    // event instead of rethrowing synchronously. Capture it (preventDefault so
    // the report does not fail the test) and assert the message, proving the
    // guard only class-catches RangeError and lets a real bug escape rather than
    // swallowing every throw.
    const uncaught: string[] = [];
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      uncaught.push(event.message);
    };
    window.addEventListener('error', onError);
    try {
      fireEvent.click(askBtn as HTMLButtonElement);
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(uncaught.some((message) => /unrelated failure/.test(message))).toBe(true);
  });

  test('click with getPos absent (unrenderable NodeView) is a no-op', async () => {
    subscribeAll();
    const props = makeAskAiProps({}, /* pos */ undefined);
    setEditorDocName(props.editor, 'specs/foo/SPEC');
    renderAskAi(props);
    const askBtn = document.querySelector(
      '[data-testid="ok-codeblock-ask-ai-btn"]',
    ) as HTMLButtonElement | null;
    expect(askBtn).toBeTruthy();
    expect(() => fireEvent.click(askBtn as HTMLButtonElement)).not.toThrow();
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(terminalInputs).toEqual([]);
    expect(composerOpens).toBe(0);
  });
});
