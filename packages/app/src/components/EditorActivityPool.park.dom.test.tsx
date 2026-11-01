// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { type ReactNode, StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { createActivityParks, useActivityPark } from '@/lib/activity-park';

interface FakePoolEntry {
  docName: string;
  provider: { document: Y.Doc; configuration: { name: string } };
  poolEventId: string;
  lastAccessedAt: number;
}

interface Body {
  docName: string;
}

interface ParkEvent {
  docName: string;
  kind: 'park' | 'reclaim';
}

const poolEntries: FakePoolEntry[] = [];
const shownBodies = new Map<string, Body>();
const parkEvents: ParkEvent[] = [];
const bodies = createActivityParks<string, Body>({ capacity: 4, dispose: () => {} });

function ParkedBody({ provider }: { provider: FakePoolEntry['provider'] }) {
  const docName = provider.configuration.name;
  const park = useActivityPark(bodies);
  useEffect(() => {
    const reclaimed = park?.reclaim(docName);
    if (reclaimed) parkEvents.push({ docName, kind: 'reclaim' });
    const body = reclaimed ?? { docName };
    shownBodies.set(docName, body);
    return () => {
      if (!park) return;
      park.park(docName, body);
      parkEvents.push({ docName, kind: 'park' });
    };
  }, [park, docName]);
  return <div data-testid="tiptap-editor" />;
}

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ poolEntries, serverRestartRecovery: { kind: 'idle' } }),
}));
vi.doMock('@/hooks/use-conflicts', () => ({
  useDocConflict: () => null,
  useConflicts: () => ({ conflicts: [], loading: false, error: null, refresh: () => {} }),
}));
vi.doMock('@/editor/TiptapEditor', () => ({ TiptapEditor: ParkedBody }));
vi.doMock('@/editor/SourceEditor', () => ({
  SourceEditor: () => <div data-testid="source-editor" />,
}));
vi.doMock('./DocumentBoundary', () => ({
  DocumentBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./DocumentErrorBoundary', () => ({
  DocumentErrorBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./DiffViewBoundary', () => ({ DiffViewBoundary: () => <div /> }));
vi.doMock('./EditorSkeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }));
vi.doMock('./PageHeader', () => ({ PageHeader: () => <div /> }));
vi.doMock('./PropertyPanel', () => ({ PropertyPanel: () => <div /> }));

const { EditorActivityPool } = await import('./EditorActivityPool');

function makeEntry(docName: string, lastAccessedAt: number): FakePoolEntry {
  const document = new Y.Doc();
  document.getText('source').insert(0, 'A short body.');
  return {
    docName,
    provider: { document, configuration: { name: docName } },
    poolEventId: `pool-${docName}`,
    lastAccessedAt,
  };
}

function Pool({ activeDocName }: { activeDocName: string }) {
  return (
    <StrictMode>
      <EditorActivityPool activeDocName={activeDocName} isSourceMode={false} onRecycle={() => {}} />
    </StrictMode>
  );
}

async function nextUserEvent(): Promise<void> {
  await act(async () => {});
}

function takeParkEvents(docName: string): ParkEvent['kind'][] {
  const kinds = parkEvents.filter((event) => event.docName === docName).map((event) => event.kind);
  parkEvents.length = 0;
  return kinds;
}

describe('EditorActivityPool parks for each entry', () => {
  beforeEach(() => {
    poolEntries.push(makeEntry('doc-a', 2), makeEntry('doc-b', 1));
  });

  afterEach(() => {
    cleanup();
    for (const entry of poolEntries) entry.provider.document.destroy();
    poolEntries.length = 0;
    shownBodies.clear();
    parkEvents.length = 0;
  });

  test('an entry shown again gets back what it parked when it was hidden', async () => {
    const { rerender } = render(<Pool activeDocName="doc-a" />);
    const shownFirst = shownBodies.get('doc-a');
    expect(shownFirst).toBeDefined();
    await nextUserEvent();
    takeParkEvents('doc-a');

    rerender(<Pool activeDocName="doc-b" />);
    await nextUserEvent();
    expect(takeParkEvents('doc-a')).toEqual(['park']);
    rerender(<Pool activeDocName="doc-a" />);

    expect(takeParkEvents('doc-a')[0]).toBe('reclaim');
    expect(shownBodies.get('doc-a')).toBe(shownFirst);
  });
});
