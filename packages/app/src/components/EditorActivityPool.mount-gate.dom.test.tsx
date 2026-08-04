// @vitest-environment jsdom
/**
 * Composition coverage for the defer-mount gate.
 *
 * `computeEffectiveSourceMode` and `computeEditorMountGate` are each unit-tested
 * on their own, but the defect they exist to fix only reappears in how
 * `ActivityEntry` wires them together: the gate must be fed the entry's
 * EFFECTIVE mode (frozen for a hidden entry) rather than the raw global mode,
 * or a global flip materialises the other mode's editor inside a hidden
 * `display:none` subtree. Feeding the raw mode back in keeps every pure-helper
 * test green, so this renders the real pool and reads the decision off the
 * `ok/activity/defer-mount` mark the entry emits.
 *
 * The heavy editor graph is stubbed the way the sibling `EditorArea.*` DOM
 * tests do it — everything except the gate itself is a marker, so the assertion
 * observes which editors the pool decided to render and nothing else.
 */

import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { getCollector } from '@/lib/perf/collector';

// Small enough that a one-line document counts as "large", so the gate takes
// its defer branch without building a half-megabyte Y.Text.
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

/** The most recent defer-mount decision the pool recorded for `docName`. */
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
    // Both entries open in visual mode: the deferred source editor is unmounted
    // on each of them.
    expect(deferMountMark('doc-hidden')?.renderSource).toBe(false);

    rerender(<Pool isSourceMode activeDocName="doc-active" />);

    // The active entry follows the flip and materialises its source editor …
    expect(deferMountMark('doc-active')?.renderSource).toBe(true);
    // … while the hidden entry stays frozen at the mode it last displayed, so
    // no editor is mounted into its display:none subtree.
    expect(deferMountMark('doc-hidden')?.renderSource).toBe(false);
    expect(deferMountMark('doc-hidden')?.isSourceMode).toBe(false);
  });

  test('a global flip to visual does not mount the visual editor in a hidden source entry', () => {
    // Mirror direction: both entries open in source mode, then the active one
    // flips back to visual.
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

    // The freeze is not permanent: becoming active again picks up the global
    // mode and mounts that editor.
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
