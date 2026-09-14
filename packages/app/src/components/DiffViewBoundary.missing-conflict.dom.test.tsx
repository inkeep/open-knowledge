import type { ConflictEntryWire } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

interface PoolEntry {
  docName: string;
  provider: { document: Y.Doc; configuration: { name: string }; synced: boolean };
  poolEventId: string;
  lastAccessedAt: number;
}

const poolEntries: PoolEntry[] = [];
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ poolEntries, serverRestartRecovery: { kind: 'idle' } }),
}));
vi.doMock('./PageListContext', () => ({
  usePageList: () => ({ pages: new Map(), loading: false }),
}));
vi.doMock('@/editor/TiptapEditor', () => ({
  TiptapEditor: () => <div data-testid="live-editor" />,
}));
vi.doMock('@/editor/SourceEditor', () => ({
  SourceEditor: () => <div data-testid="source-editor" />,
}));
vi.doMock('./DocumentErrorBoundary', () => ({
  DocumentErrorBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./PageHeader', () => ({ PageHeader: () => <div /> }));
vi.doMock('./PropertyPanel', () => ({ PropertyPanel: () => <div /> }));
vi.doMock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

const { EditorActivityPool } = await import('./EditorActivityPool');
const { ConflictsProvider, useConflicts } = await import('@/hooks/use-conflicts');
const { __resetRenameSnapshotStore } = await import('@/editor/editor-cache');
const { __resetSyncPromiseCache } = await import('@/editor/sync-promise');
const { Toaster, toast } = await import('sonner');

const FILE = 'notes/roadmap.md';
const DOC = 'notes/roadmap';
const MISSING_TYPE = 'urn:ok:error:no-conflict-tracked';
const MISSING_DETAIL =
  'This file has no tracked conflict — it may have been resolved by another session, or the path may be stale. Re-read conflicts({ kind: "list" }) before retrying.';
const FIRST_CONFLICT: ConflictEntryWire = {
  file: FILE,
  docName: DOC,
  detectedAt: '2026-05-20T00:00:00.000Z',
  conflict: 'merge-native',
};
const KEEP_MINE = { strategy: 'mine', label: 'Keep my version' } as const;
const APPLY_CONTENT = { strategy: 'content', label: 'Apply changes' } as const;
type Action = typeof KEEP_MINE | typeof APPLY_CONTENT;

let snapshot: ConflictEntryWire[];
let contentMode: boolean;
let requests: Array<{ file: string; strategy: string; content?: string }>;
let resolveResponse: () => Response | Promise<Response>;

function missingProblem(status = 404, type = MISSING_TYPE) {
  return new Response(
    JSON.stringify({
      file: FILE,
      type,
      title: 'No conflict is tracked for this path.',
      status: 404,
      detail: MISSING_DETAIL,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function Snapshot() {
  const { conflicts } = useConflicts();
  return <output data-testid="conflict-snapshot">{JSON.stringify(conflicts)}</output>;
}

beforeEach(() => {
  snapshot = [FIRST_CONFLICT];
  contentMode = false;
  requests = [];
  resolveResponse = missingProblem;
  const ydoc = new Y.Doc();
  ydoc.getText('source').insert(0, '# Roadmap\n');
  poolEntries.push({
    docName: DOC,
    provider: { document: ydoc, configuration: { name: DOC }, synced: true },
    poolEventId: 'missing-conflict',
    lastAccessedAt: 1,
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/sync/conflicts') {
      return new Response(JSON.stringify({ conflicts: snapshot }), { status: 200 });
    }
    if (url.startsWith('/api/sync/conflict-content')) {
      return new Response(
        JSON.stringify({
          file: FILE,
          kind: 'both-modified',
          conflict: 'merge-native',
          resolutionOptions: contentMode
            ? ['mine', 'theirs', 'content', 'delete']
            : ['mine', 'theirs', 'delete'],
          base: '# Roadmap\n\n- Ship date: October 14\n',
          ours: '# Roadmap\n\n- Ship date: October 21\n',
          theirs: '# Roadmap\n\n- Ship date: Q4\n',
        }),
        { status: 200 },
      );
    }
    if (url === '/api/sync/resolve-conflict') {
      requests.push(JSON.parse(String(init?.body)));
      snapshot = [];
      return resolveResponse();
    }
    return new Response('not found', { status: 404 });
  });
});

afterEach(async () => {
  await act(async () => {
    toast.dismiss();
  });
  cleanup();
  __resetSyncPromiseCache();
  __resetRenameSnapshotStore();
  for (const entry of poolEntries) entry.provider.document.destroy();
  poolEntries.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(action: Action) {
  contentMode = action.strategy === 'content';
  await act(async () => {
    render(
      <ConflictsProvider>
        <Snapshot />
        <EditorActivityPool activeDocName={DOC} isSourceMode={false} onRecycle={() => {}} />
        <Toaster />
      </ConflictsProvider>,
    );
  });
  if (contentMode) {
    const accept = await screen.findAllByRole('button', { name: /^Accept current/ });
    fireEvent.click(accept[0]);
  }
  return screen.findByRole<HTMLButtonElement>('button', { name: action.label });
}

async function submit(button: HTMLButtonElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

function expectInformationalFeedback(expectedType: 'info' | 'warning') {
  const otherType = expectedType === 'info' ? 'warning' : 'info';
  const notice = document.querySelector(`[data-sonner-toast][data-type="${expectedType}"]`);
  expect(notice).not.toBeNull();
  expect(notice?.textContent).toMatch(/no.*conflict|conflict.*(absent|no longer)/i);
  expect(notice?.textContent).not.toMatch(
    /(successfully (saved|applied)|your (resolution|changes) (were|have been) (saved|applied)|another session (has |already )?resolved|was resolved by another session)/i,
  );
  expect(document.querySelector(`[data-sonner-toast][data-type="${otherType}"]`)).toBeNull();
  expect(document.querySelector('[data-sonner-toast][data-type="error"]')).toBeNull();
  expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
}

test('a typed 404 refreshes the authoritative list and reports the absence', async () => {
  const button = await mount(KEEP_MINE);
  await submit(button);

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ file: FILE, strategy: 'mine' });
  await waitFor(() => expect(screen.queryByTestId('live-editor')).not.toBeNull());
  expect(screen.getByTestId('conflict-snapshot').textContent).toBe('[]');
  await waitFor(() => expectInformationalFeedback('info'));
});

test('a generic 500 reports a failure without claiming the conflict was resolved', async () => {
  resolveResponse = () =>
    new Response(JSON.stringify({ detail: 'Server exploded' }), {
      status: 500,
    });
  const button = await mount(KEEP_MINE);
  await submit(button);

  await screen.findByText(`Couldn't resolve the conflict for ${FILE}.`);
  const failure = document.querySelector('[data-sonner-toast][data-type="error"]');
  expect(failure?.textContent).toContain('Server exploded');
  expect(document.querySelector('[data-sonner-toast][data-type="info"]')).toBeNull();
  expect(document.querySelector('[data-sonner-toast][data-type="warning"]')).toBeNull();
  expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
  expect(screen.queryByTestId('live-editor')).toBeNull();
  expect(button.disabled).toBe(false);
});

test('the content path warns about the hand-merge risk instead of a plain notice', async () => {
  const button = await mount(APPLY_CONTENT);
  await submit(button);

  expect(requests[0]?.content).toContain('October 21');
  await waitFor(() => expectInformationalFeedback('warning'));
  const notice = document.querySelector('[data-sonner-toast][data-type="warning"]');
  expect(notice?.textContent).toContain(FILE);
  expect(notice?.textContent).toContain(
    "check the document's current content before redoing your edit",
  );
});
