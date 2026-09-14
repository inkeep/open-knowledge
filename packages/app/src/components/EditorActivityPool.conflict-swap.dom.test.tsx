// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

interface FakePoolEntry {
  docName: string;
  provider: { document: Y.Doc; configuration: { name: string } };
  poolEventId: string;
  lastAccessedAt: number;
}

const poolEntries: FakePoolEntry[] = [];

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ poolEntries, serverRestartRecovery: { kind: 'idle' } }),
}));
vi.doMock('./PageListContext', () => ({
  usePageList: () => ({ pages: new Map(), loading: false }),
}));
let tiptapMounts = 0;

vi.doMock('@/editor/TiptapEditor', () => ({
  TiptapEditor: () => {
    useEffect(() => {
      tiptapMounts += 1;
    }, []);
    return <div data-testid="tiptap-editor" />;
  },
}));
vi.doMock('@/editor/SourceEditor', () => ({
  SourceEditor: () => <div data-testid="source-editor" />,
}));
vi.doMock('./DocumentBoundary', () => ({
  DocumentBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./DocumentErrorBoundary', () => ({
  DocumentErrorBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./DiffViewBoundary', () => ({
  DiffViewBoundary: ({ conflict }: { conflict: { file: string } }) => (
    <div data-testid="diff-view">{conflict.file}</div>
  ),
}));
vi.doMock('./EditorSkeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }));
vi.doMock('./PageHeader', () => ({ PageHeader: () => <div /> }));
vi.doMock('./PropertyPanel', () => ({ PropertyPanel: () => <div /> }));

const { EditorActivityPool } = await import('./EditorActivityPool');
const { ConflictsProvider } = await import('@/hooks/use-conflicts');
const { __resetRenameSnapshotStore } = await import('@/editor/editor-cache');

const DOC = 'docs/notes';

let conflictsPayload: { conflicts: Array<Record<string, unknown>> } = { conflicts: [] };
let conflictsResponder: () => Response = () =>
  new Response(JSON.stringify(conflictsPayload), { status: 200 });
let conflictsFetches = 0;

function installFetchStub() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/sync/conflicts') {
      conflictsFetches += 1;
      return Promise.resolve(conflictsResponder());
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
}

function makeEntry(docName: string): FakePoolEntry {
  const document = new Y.Doc();
  document.getText('source').insert(0, '# Notes\n\nbody\n');
  return {
    docName,
    provider: { document, configuration: { name: docName } },
    poolEventId: `pool-${docName}`,
    lastAccessedAt: 1,
  };
}

function signalSyncStatus() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('open-knowledge:documents-changed', {
        detail: { channels: ['sync-status'] },
      }),
    );
  });
}

function lifecycleStatusOf(entry: FakePoolEntry): unknown {
  return entry.provider.document.getMap('lifecycle').get('status');
}

describe('ActivityEntry — the conflict swap reads the conflicts provider', () => {
  beforeEach(() => {
    tiptapMounts = 0;
    conflictsPayload = { conflicts: [] };
    conflictsFetches = 0;
    conflictsResponder = () => new Response(JSON.stringify(conflictsPayload), { status: 200 });
    installFetchStub();
    __resetRenameSnapshotStore();
    poolEntries.length = 0;
    poolEntries.push(makeEntry(DOC));
  });

  afterEach(() => {
    cleanup();
    __resetRenameSnapshotStore();
    for (const entry of poolEntries) entry.provider.document.destroy();
    poolEntries.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('swaps to the DiffView from a provider entry, with no lifecycle map write anywhere', async () => {
    conflictsPayload = {
      conflicts: [
        {
          file: `${DOC}.md`,
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: DOC,
        },
      ],
    };

    render(
      <ConflictsProvider>
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
      </ConflictsProvider>,
    );

    const diff = await screen.findByTestId('diff-view');
    expect(diff.textContent).toBe(`${DOC}.md`);
    expect(screen.queryByTestId('tiptap-editor')).toBeNull();
    expect(lifecycleStatusOf(poolEntries[0])).toBeUndefined();
  });

  test('mounts the editor while the conflicts lookup is still in flight', async () => {
    conflictsPayload = {
      conflicts: [
        {
          file: `${DOC}.md`,
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: DOC,
        },
      ],
    };

    render(
      <ConflictsProvider>
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
      </ConflictsProvider>,
    );

    expect(screen.getByTestId('tiptap-editor')).toBeTruthy();
    expect(screen.queryByTestId('diff-view')).toBeNull();

    const diff = await screen.findByTestId('diff-view');
    expect(diff.textContent).toBe(`${DOC}.md`);
  });

  test('remounts the editor on the SAME provider instance when the entry vanishes after a signal', async () => {
    conflictsPayload = {
      conflicts: [
        {
          file: `${DOC}.md`,
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: DOC,
        },
      ],
    };

    render(
      <ConflictsProvider>
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
      </ConflictsProvider>,
    );
    await screen.findByTestId('diff-view');

    conflictsPayload = { conflicts: [] };
    signalSyncStatus();

    await waitFor(() => {
      expect(screen.queryByTestId('diff-view')).toBeNull();
    });
    await screen.findByTestId('tiptap-editor');
    expect(lifecycleStatusOf(poolEntries[0])).toBeUndefined();
  });

  test('a failed conflicts fetch leaves the editor open rather than blocking it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    conflictsResponder = () => new Response('internal', { status: 500 });

    render(
      <ConflictsProvider>
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(conflictsFetches).toBeGreaterThan(0);
    });
    await act(async () => {});

    expect(screen.getByTestId('tiptap-editor')).toBeTruthy();
    expect(screen.queryByTestId('diff-view')).toBeNull();
    expect(tiptapMounts).toBe(1);
    warn.mockRestore();
  });

  test('a sync-status refetch after a failed lookup swaps to the DiffView', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    conflictsPayload = {
      conflicts: [
        {
          file: `${DOC}.md`,
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: DOC,
        },
      ],
    };
    conflictsResponder = () => new Response('internal', { status: 500 });

    render(
      <ConflictsProvider>
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
      </ConflictsProvider>,
    );

    await act(async () => {});
    expect(conflictsFetches).toBe(1);
    expect(screen.getByTestId('tiptap-editor')).toBeTruthy();

    conflictsResponder = () => new Response(JSON.stringify(conflictsPayload), { status: 200 });
    signalSyncStatus();

    const diff = await screen.findByTestId('diff-view');
    expect(diff.textContent).toBe(`${DOC}.md`);
    expect(lifecycleStatusOf(poolEntries[0])).toBeUndefined();
    warn.mockRestore();
  });

  test('a conflict on another doc leaves this entry on the editor branch', async () => {
    conflictsPayload = {
      conflicts: [
        {
          file: 'other/doc.md',
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: 'other/doc',
        },
      ],
    };

    render(
      <ConflictsProvider>
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
      </ConflictsProvider>,
    );

    await screen.findByTestId('tiptap-editor');
    expect(screen.queryByTestId('diff-view')).toBeNull();
  });
});
