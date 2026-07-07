import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Config } from '@inkeep/open-knowledge-core';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/core';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { RawMdxFallbackView } from './RawMdxFallbackCMView';

const originalFetch = globalThis.fetch;

// CodeMirror checks the bare `Window` constructor during async layout
// measurement. The shared jsdom preload installs `window` but not this
// constructor alias, so provide it for the mounted EditorView path here.
(globalThis as { Window?: typeof window.Window }).Window = window.Window;

function makeConfigValue(wordWrap: boolean): ConfigContextValue {
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
    merged: { editor: { wordWrap } } as Config,
  };
}

function makeEditor(): NodeViewProps['editor'] {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    isDestroyed: false,
    extensionManager: { extensions: [] },
    commands: {
      undo: () => true,
      redo: () => true,
    },
    chain: () => ({
      focus: () => ({
        setNodeSelection: () => ({
          deleteSelection: () => ({
            run: () => true,
          }),
        }),
      }),
    }),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
    },
  } as unknown as NodeViewProps['editor'];
}

function makeProps(editor = makeEditor()): NodeViewProps {
  return {
    editor,
    node: {
      attrs: { reason: 'Parse failed' },
      textContent: '# heading\n\nbody',
    },
    getPos: () => 0,
  } as unknown as NodeViewProps;
}

function Harness({ props, wordWrap }: { props: NodeViewProps; wordWrap: boolean }) {
  return (
    <ConfigContext value={makeConfigValue(wordWrap)}>
      <RawMdxFallbackView {...props} />
    </ConfigContext>
  );
}

async function findCmContent(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector('.cm-content')).toBeTruthy();
  });
  return container.querySelector<HTMLElement>('.cm-content');
}

describe('RawMdxFallbackView word-wrap preference wiring', () => {
  beforeEach(() => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/pages') {
        return Response.json({ pages: [] });
      }
      if (url === '/api/documents') {
        return Response.json({ documents: [] });
      }
      if (url === '/api/tags') {
        return Response.json({ tags: [] });
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test('applies editor.wordWrap to the nested CodeMirror instance', async () => {
    const props = makeProps();
    const { container } = render(<Harness props={props} wordWrap={false} />);

    const content = await findCmContent(container);

    expect(content.classList.contains('cm-lineWrapping')).toBe(false);
  });

  test('hot-swaps nested CodeMirror line wrapping without remounting', async () => {
    const props = makeProps();
    const { container, rerender } = render(<Harness props={props} wordWrap={true} />);

    const content = await findCmContent(container);
    const cmEditor = container.querySelector('.cm-editor');
    expect(content.classList.contains('cm-lineWrapping')).toBe(true);

    rerender(<Harness props={props} wordWrap={false} />);

    await waitFor(() => {
      expect(content.classList.contains('cm-lineWrapping')).toBe(false);
    });
    expect(container.querySelector('.cm-editor')).toBe(cmEditor);
  });
});
