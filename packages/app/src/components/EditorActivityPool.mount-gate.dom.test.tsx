// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { getCollector } from '@/lib/perf/collector';

window.__okPerfOverrides = { LARGE_DOC_CHAR_THRESHOLD: 4 };

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
vi.doMock('@/hooks/use-lifecycle-status', () => ({ useLifecycleStatus: () => 'ready' }));
vi.doMock('@/editor/TiptapEditor', () => ({
  TiptapEditor: () => <div data-testid="tiptap-editor" />,
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
vi.doMock('./DiffViewBoundary', () => ({ DiffViewBoundary: () => <div /> }));
vi.doMock('./EditorSkeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }));
vi.doMock('./PageHeader', () => ({ PageHeader: () => <div /> }));
vi.doMock('./PropertyPanel', () => ({ PropertyPanel: () => <div /> }));

const { EditorActivityPool } = await import('./EditorActivityPool');

function makeEntry(docName: string, lastAccessedAt: number): FakePoolEntry {
  const document = new Y.Doc();
  document.getText('source').insert(0, 'a body long enough to pass the threshold');
  return {
    docName,
    provider: { document, configuration: { name: docName } },
    poolEventId: `pool-${docName}`,
    lastAccessedAt,
  };
}

function deferMountMark(docName: string): Record<string, unknown> | undefined {
  const marks = getCollector()
    ?.marks.toArray()
    .filter((m) => m.name === 'ok/activity/defer-mount' && m.properties?.docName === docName);
  return marks?.[marks.length - 1]?.properties;
}

function Pool({ isSourceMode, activeDocName }: { isSourceMode: boolean; activeDocName: string }) {
  return (
    <EditorActivityPool
      activeDocName={activeDocName}
      isSourceMode={isSourceMode}
      onRecycle={() => {}}
    />
  );
}

describe('ActivityEntry — mount gate reads the effective mode', () => {
  beforeEach(() => {
    poolEntries.length = 0;
    poolEntries.push(makeEntry('doc-active', 2), makeEntry('doc-hidden', 1));
    getCollector()?.reset();
  });

  afterEach(() => {
    cleanup();
    for (const entry of poolEntries) entry.provider.document.destroy();
    poolEntries.length = 0;
  });

  test('a global flip to source does not mount the source editor in a hidden entry', () => {
    const { rerender } = render(<Pool isSourceMode={false} activeDocName="doc-active" />);
    expect(deferMountMark('doc-hidden')?.renderSource).toBe(false);

    rerender(<Pool isSourceMode activeDocName="doc-active" />);

    expect(deferMountMark('doc-active')?.renderSource).toBe(true);
    expect(deferMountMark('doc-hidden')?.renderSource).toBe(false);
    expect(deferMountMark('doc-hidden')?.isSourceMode).toBe(false);
  });

  test('a global flip to visual does not mount the visual editor in a hidden source entry', () => {
    const { rerender } = render(<Pool isSourceMode activeDocName="doc-active" />);
    expect(deferMountMark('doc-hidden')?.renderVisual).toBe(false);

    rerender(<Pool isSourceMode={false} activeDocName="doc-active" />);

    expect(deferMountMark('doc-active')?.renderVisual).toBe(true);
    expect(deferMountMark('doc-hidden')?.renderVisual).toBe(false);
  });

  test('re-activating the hidden entry adopts the current global mode', () => {
    const { rerender } = render(<Pool isSourceMode={false} activeDocName="doc-active" />);
    rerender(<Pool isSourceMode activeDocName="doc-active" />);
    expect(deferMountMark('doc-hidden')?.renderSource).toBe(false);

    rerender(<Pool isSourceMode activeDocName="doc-hidden" />);
    expect(deferMountMark('doc-hidden')?.renderSource).toBe(true);
  });

  test('renders document toolbar chrome in every visible split-pane host', () => {
    poolEntries.push(makeEntry('doc-third', 0));
    const activityHosts = new Map(
      poolEntries.map(({ docName }) => [docName, document.createElement('div')]),
    );

    render(
      <EditorActivityPool
        activeDocName="doc-active"
        visibleDocNames={new Set(['doc-active', 'doc-hidden', 'doc-third'])}
        activityHosts={activityHosts}
        isSourceMode={false}
        onRecycle={() => {}}
        renderToolbar={(docName) => <div data-testid={`toolbar-${docName}`} />}
      />,
    );

    for (const [docName, host] of activityHosts) {
      expect(host.querySelector(`[data-testid="toolbar-${docName}"]`)).not.toBeNull();
    }
  });
});
