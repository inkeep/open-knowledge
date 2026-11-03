import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, within } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { evictCmEditor } from '@/editor/editor-cache';
import { dynamicActivate } from '@/lib/activate-locale';
import { renderWithI18n } from '../../tests/foundation/render-with-i18n.test-helper';
import { EditorActivityPool } from './EditorActivityPool';

const pool = vi.hoisted(() => ({
  entries: [] as Array<{
    docName: string;
    provider: unknown;
    poolEventId: string;
    lastAccessedAt: number;
  }>,
}));

const appTheme = vi.hoisted(() => {
  let resolvedTheme: 'light' | 'dark' = 'light';
  const listeners = new Set<() => void>();
  return {
    current: () => resolvedTheme,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    switchTo(next: 'light' | 'dark') {
      resolvedTheme = next;
      for (const listener of listeners) listener();
    },
    reset() {
      resolvedTheme = 'light';
    },
  };
});

vi.mock('next-themes', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useTheme: () => ({
      resolvedTheme: useSyncExternalStore(appTheme.subscribe, appTheme.current),
    }),
  };
});
vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    poolEntries: pool.entries,
    serverRestartRecovery: { kind: 'idle' },
  }),
}));
vi.mock('./PageListContext', () => ({
  usePageList: () => ({ pages: new Map(), loading: false }),
}));
vi.mock('@/hooks/use-conflicts', () => ({
  useDocConflict: () => null,
}));
vi.mock('./DocumentBoundary', () => ({
  DocumentBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./DocumentErrorBoundary', () => ({
  DocumentErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/editor/TiptapEditor', () => ({ TiptapEditor: () => null }));

const DIAGRAM = 'flowchart.mmd';
const OTHER_DIAGRAM = 'other-flowchart.mmd';

const SOURCE = 'graph TD\n  A --> B';

const LONG_SOURCE = [
  'graph TD',
  ...Array.from({ length: 300 }, (_, index) => `  N${index} --> N${index + 1}`),
].join('\n');

const LINES_ADDED_ABOVE = Array.from(
  { length: 40 },
  (_, index) => `  P${index} --> P${index + 1}\n`,
).join('');

const MOD = /Mac/.test(navigator.platform) ? 'Meta' : 'Control';

afterEach(async () => {
  await act(() => dynamicActivate('en'));
  appTheme.reset();
  evictCmEditor(DIAGRAM);
  evictCmEditor(OTHER_DIAGRAM);
  pool.entries.length = 0;
  await userEvent.cleanup();
});

function poolEntry(docName: string, source: string, lastAccessedAt: number) {
  const ydoc = new Y.Doc();
  ydoc.getText('source').insert(0, source);
  const awareness = new Awareness(ydoc);
  onTestFinished(() => {
    awareness.destroy();
    ydoc.destroy();
  });
  return {
    docName,
    provider: {
      document: ydoc,
      awareness,
      configuration: { name: docName },
      on() {},
      off() {},
      connect() {},
      disconnect() {},
      destroy() {},
    },
    poolEventId: `pool-${docName}`,
    lastAccessedAt,
  };
}

function entryHost(docName: string): string {
  return `[data-ok-activity-host="${docName}"]`;
}

function settled(view: EditorView): Promise<void> {
  return new Promise((resolve) => {
    view.requestMeasure({ read: () => undefined, write: () => resolve() });
  });
}

function lineAtTop(view: EditorView): number {
  return view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
}

async function mermaidSourceIn(paneMount: HTMLElement, docName: string): Promise<EditorView> {
  return vi.waitFor(
    () => {
      const editor = paneMount.querySelector<HTMLElement>(
        `${entryHost(docName)} [data-mermaid-doc-editor] .cm-editor`,
      );
      const view = editor ? EditorView.findFromDOM(editor) : null;
      if (!view) throw new Error(`${docName} has no Mermaid source pane in the visible pane yet`);
      return view;
    },
    { timeout: 10_000 },
  );
}

async function diagramWorkspace(source: string) {
  const entry = poolEntry(DIAGRAM, source, 2);
  pool.entries.push(entry, poolEntry(OTHER_DIAGRAM, SOURCE, 1));
  const paneMount = document.createElement('div');
  paneMount.style.height = '240px';
  const parkingHost = document.createElement('div');
  parkingHost.style.display = 'none';
  parkingHost.inert = true;
  document.body.append(paneMount, parkingHost);
  onTestFinished(() => {
    paneMount.remove();
    parkingHost.remove();
  });
  const workspace = (activeDocName: string) => (
    <StrictMode>
      <EditorActivityPool
        activeDocName={activeDocName}
        activityHosts={new Map([[activeDocName, paneMount]])}
        parkingHost={parkingHost}
        isSourceMode
        onRecycle={() => {}}
      />
    </StrictMode>
  );
  await document.fonts.ready;

  const { rerender } = renderWithI18n(workspace(DIAGRAM));
  const view = await mermaidSourceIn(paneMount, DIAGRAM);
  await settled(view);

  return {
    view,
    ytext: entry.provider.document.getText('source'),
    paneMount,
    parkingHost,
    show: (docName: string) => rerender(workspace(docName)),
  };
}

async function scrolledLongDiagramWorkspace() {
  const workspace = await diagramWorkspace(LONG_SOURCE);
  const { view } = workspace;
  expect(view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight).toBeGreaterThan(2000);

  let lastReportedScrollTop: number | null = null;
  view.scrollDOM.addEventListener('scroll', () => {
    lastReportedScrollTop = view.scrollDOM.scrollTop;
  });
  await userEvent.wheel(view.scrollDOM, { delta: { y: 1500 } });
  await vi.waitFor(
    () => {
      expect(view.scrollDOM.scrollTop).toBeGreaterThan(1000);
      expect(lastReportedScrollTop).toBe(view.scrollDOM.scrollTop);
    },
    { timeout: 5_000 },
  );
  await settled(view);
  const topLine = lineAtTop(view);
  expect(topLine).toBeGreaterThan(20);

  return { ...workspace, topLine };
}

test('a source-mode Mermaid document keeps its scroll position when its tab is hidden and shown again', async () => {
  const { topLine, paneMount, parkingHost, show } = await scrolledLongDiagramWorkspace();

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  expect(parkingHost.querySelector(entryHost(DIAGRAM))).not.toBeNull();
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  await settled(after);
  expect(lineAtTop(after)).toBe(topLine);
});

test('a scroll the browser reports after the tab was hidden does not move the restored position', async () => {
  const { view, topLine, paneMount, show } = await scrolledLongDiagramWorkspace();
  let scrollerHeightWhenReported: number | null = null;
  view.scrollDOM.addEventListener(
    'scroll',
    () => {
      scrollerHeightWhenReported = view.scrollDOM.clientHeight;
    },
    { once: true },
  );

  await act(async () => {
    view.scrollDOM.scrollTop += 1;
    show(OTHER_DIAGRAM);
  });
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await vi.waitFor(() => expect(scrollerHeightWhenReported).toBe(0));
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  await settled(after);
  expect(lineAtTop(after)).toBe(topLine);
});

test('the restored scroll position follows lines added above it while the tab was hidden', async () => {
  const { view, ytext, topLine, paneMount, show } = await scrolledLongDiagramWorkspace();
  const topLineText = view.state.doc.line(topLine).text;

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(async () => {
    ytext.insert(ytext.toString().indexOf('\n') + 1, LINES_ADDED_ABOVE);
  });
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  await settled(after);
  expect(after.state.doc.line(topLine).text).not.toBe(topLineText);
  expect(after.state.doc.line(lineAtTop(after)).text).toBe(topLineText);
});

test('a source-mode Mermaid document that had focus gets it back when its tab is shown again', async () => {
  const { view, paneMount, show } = await diagramWorkspace(LONG_SOURCE);
  view.focus();
  expect(document.activeElement).toBe(view.contentDOM);

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  expect(document.activeElement).not.toBe(view.contentDOM);
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  expect(document.activeElement).toBe(after.contentDOM);
});

test('a source-mode Mermaid document hidden without focus leaves focus where it was when its tab is shown again', async () => {
  const { paneMount, show } = await diagramWorkspace(LONG_SOURCE);
  const elsewhere = document.createElement('button');
  document.body.append(elsewhere);
  onTestFinished(() => elsewhere.remove());
  elsewhere.focus();
  expect(document.activeElement).toBe(elsewhere);

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(async () => show(DIAGRAM));

  await mermaidSourceIn(paneMount, DIAGRAM);
  expect(document.activeElement).toBe(elsewhere);
});

test('a source-mode Mermaid document keeps the selection the user left in it when its tab is hidden and shown again', async () => {
  const { view, paneMount, show } = await diagramWorkspace(SOURCE);
  view.focus();
  view.dispatch({ selection: EditorSelection.range(2, 7) });

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  await settled(after);
  expect(after.state.selection.main.anchor).toBe(2);
  expect(after.state.selection.main.head).toBe(7);
});

test('the undo shortcut in a source-mode Mermaid document undoes the edit typed before its tab was hidden', async () => {
  const { view, ytext, paneMount, show } = await diagramWorkspace(SOURCE);
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  view.focus();
  await userEvent.keyboard(';');
  await vi.waitFor(() => expect(ytext.toString()).toBe(`${SOURCE};`));

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  after.focus();
  await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
  await vi.waitFor(() => expect(ytext.toString()).toBe(SOURCE));
});

test('a source-mode Mermaid document shows edits that arrived while its tab was hidden', async () => {
  const { ytext, paneMount, show } = await diagramWorkspace(SOURCE);

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(async () => {
    ytext.insert(ytext.length, '\n  B --> C');
  });
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  expect(after.state.doc.toString()).toBe(`${SOURCE}\n  B --> C`);
});

test('a source-mode Mermaid document follows the app theme, including a switch made while its tab was hidden', async () => {
  const { view, paneMount, show } = await diagramWorkspace(SOURCE);
  expect(view.state.facet(EditorView.darkTheme)).toBe(false);

  await act(async () => appTheme.switchTo('dark'));
  const dark = await mermaidSourceIn(paneMount, DIAGRAM);
  expect(dark.state.facet(EditorView.darkTheme)).toBe(true);

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(async () => appTheme.switchTo('light'));
  await act(async () => show(DIAGRAM));

  const after = await mermaidSourceIn(paneMount, DIAGRAM);
  expect(after.state.facet(EditorView.darkTheme)).toBe(false);
});

test('a source-mode Mermaid document follows the app language, including a switch made while its tab was hidden', async () => {
  const { view, paneMount, show } = await diagramWorkspace(SOURCE);
  expect(within(paneMount).getByRole('textbox', { name: 'Mermaid diagram' })).toBe(view.contentDOM);

  await act(() => dynamicActivate('es'));
  expect(within(paneMount).getByRole('textbox', { name: 'Diagrama de Mermaid' })).toBe(
    view.contentDOM,
  );

  await act(async () => show(OTHER_DIAGRAM));
  await mermaidSourceIn(paneMount, OTHER_DIAGRAM);
  await act(() => dynamicActivate('en'));
  await act(async () => show(DIAGRAM));

  await mermaidSourceIn(paneMount, DIAGRAM);
  expect(within(paneMount).getByRole('textbox', { name: 'Mermaid diagram' })).toBe(view.contentDOM);
});
