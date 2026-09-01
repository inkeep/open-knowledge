import type { Config } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { subscribeStartComment } from '@/comments/store';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { CodeBlockView } from './CodeBlockView';

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
    expect(srcdoc).toContain("script-src 'unsafe-inline' https:");
    expect(srcdoc).toContain('connect-src https:');
    expect(srcdoc).toContain('img-src https:');
    expect(srcdoc).not.toContain("connect-src 'none'");
    expect(srcdoc).not.toContain("'unsafe-eval'");
    expect(srcdoc).toContain('<div id="probe">hello</div>');
  });
});

describe('CodeBlockView edit-source modal language wiring', () => {
  afterEach(() => {
    cleanup();
  });

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
    const sourceHost = document.querySelector('[data-testid="ok-code-preview-edit-modal-source"]');
    expect(sourceHost).toBeTruthy();
    expect(sourceHost?.getAttribute('data-language')).toBe('html');
  });
});

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

describe('CodeBlockView Ask AI composer', () => {
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
  }

  let starts = 0;
  let nodeSelections: number[] = [];
  let unsubscribeStart: (() => void) | null = null;

  afterEach(() => {
    unsubscribeStart?.();
    unsubscribeStart = null;
    starts = 0;
    nodeSelections = [];
    cleanup();
  });

  function subscribeStart() {
    unsubscribeStart = subscribeStartComment(() => {
      starts += 1;
    });
  }

  interface EditorMockOverrides {
    setNodeSelectionThrows?: 'range' | 'other';
    selection?: { from: number; to: number };
  }

  function makeEditorWithCommands(overrides: EditorMockOverrides = {}) {
    const setNodeSelection = (pos: number) => {
      if (overrides.setNodeSelectionThrows === 'range') {
        throw new RangeError('Position 5 out of range');
      }
      if (overrides.setNodeSelectionThrows === 'other') {
        throw new Error('unrelated failure');
      }
      nodeSelections.push(pos);
    };
    return {
      isEditable: true,
      isDestroyed: false,
      commands: { setNodeSelection },
      state: {
        doc: { nodeAt: () => ({ nodeSize: 10 }) },
        selection: overrides.selection ?? { from: 0, to: 0, empty: true },
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
        nodeSize: 10,
      },
      getPos: pos === undefined ? undefined : () => pos,
      selected: false,
      updateAttributes: () => {},
    } as unknown as NodeViewProps;
  }

  function clickAskAi(props: NodeViewProps): HTMLButtonElement {
    render(
      <ConfigContext value={makeConfigValue(null)}>
        <CodeBlockView {...props} />
      </ConfigContext>,
    );
    const askBtn = document.querySelector(
      '[data-testid="ok-codeblock-ask-ai-btn"]',
    ) as HTMLButtonElement | null;
    expect(askBtn).toBeTruthy();
    return askBtn as HTMLButtonElement;
  }

  test('with nothing picked, selects the whole block and opens the composer', async () => {
    subscribeStart();
    fireEvent.click(clickAskAi(makeAskAiProps()));

    await waitFor(() => expect(starts).toBe(1));
    expect(nodeSelections).toEqual([5]);
  });

  test('a pick inside this block stands — the comment is about those lines', async () => {
    subscribeStart();
    fireEvent.click(clickAskAi(makeAskAiProps({ selection: { from: 7, to: 11 } })));

    await waitFor(() => expect(starts).toBe(1));
    expect(nodeSelections).toEqual([]);
  });

  test('a pick in a DIFFERENT block does not stop this one selecting itself', async () => {
    subscribeStart();
    fireEvent.click(clickAskAi(makeAskAiProps({ selection: { from: 40, to: 46 } })));

    await waitFor(() => expect(starts).toBe(1));
    expect(nodeSelections).toEqual([5]);
  });

  test('a stale position (setNodeSelection throws RangeError) neither crashes nor composes', async () => {
    subscribeStart();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const btn = clickAskAi(makeAskAiProps({ setNodeSelectionThrows: 'range' }));
      expect(() => fireEvent.click(btn)).not.toThrow();
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));
      expect(starts).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('a non-RangeError from setNodeSelection is re-thrown (guard does not swallow real bugs)', async () => {
    subscribeStart();
    const btn = clickAskAi(makeAskAiProps({ setNodeSelectionThrows: 'other' }));
    const uncaught: string[] = [];
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      uncaught.push(event.message);
    };
    window.addEventListener('error', onError);
    try {
      fireEvent.click(btn);
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(uncaught.some((message) => /unrelated failure/.test(message))).toBe(true);
  });

  test('click with getPos absent (unrenderable NodeView) is a no-op', async () => {
    subscribeStart();
    const btn = clickAskAi(makeAskAiProps({}, undefined));
    expect(() => fireEvent.click(btn)).not.toThrow();
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    expect(starts).toBe(0);
  });
});
