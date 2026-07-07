/**
 * RTL behavioral test for `useLifecycleStatus`. Pins:
 *   - Initial value reflects whatever the doc's `lifecycle.status` Y.Map
 *     currently holds (mounted-fresh `'conflict'` → returns `'conflict'`).
 *   - The hook re-renders when the Y.Map fires a change event.
 *   - Returns `null` when the doc has no pool entry (e.g. it's not loaded).
 *
 * Substrate: jsdom via `bun run test:dom`. The DocumentContext is mocked at
 * its export surface — we don't need the full provider-pool machinery for
 * a hook that only reads `poolEntries`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as Y from 'yjs';

let mockPoolEntries: Array<{ docName: string; provider: { document: Y.Doc } }> = [];

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    poolEntries: mockPoolEntries,
  }),
}));

const { useLifecycleStatus } = await import('./use-lifecycle-status');

function Probe({ docName }: { docName: string | null }) {
  const status = useLifecycleStatus(docName);
  return <span data-testid="status">{status === null ? 'null' : status}</span>;
}

describe('useLifecycleStatus', () => {
  beforeEach(() => {
    mockPoolEntries = [];
  });

  afterEach(() => {
    cleanup();
  });

  test('returns null when no pool entry exists for the docName', () => {
    render(<Probe docName="missing" />);
    expect(screen.getByTestId('status').textContent).toBe('null');
  });

  test("returns 'conflict' when the doc's lifecycle Y.Map carries status='conflict'", () => {
    const doc = new Y.Doc();
    doc.getMap('lifecycle').set('status', 'conflict');
    mockPoolEntries = [{ docName: 'doc-a', provider: { document: doc } }];

    render(<Probe docName="doc-a" />);
    expect(screen.getByTestId('status').textContent).toBe('conflict');
  });

  test('re-renders to null when status is deleted from the lifecycle Y.Map', () => {
    const doc = new Y.Doc();
    const lifecycle = doc.getMap('lifecycle');
    lifecycle.set('status', 'conflict');
    mockPoolEntries = [{ docName: 'doc-b', provider: { document: doc } }];

    render(<Probe docName="doc-b" />);
    expect(screen.getByTestId('status').textContent).toBe('conflict');

    act(() => {
      lifecycle.delete('status');
    });

    expect(screen.getByTestId('status').textContent).toBe('null');
  });

  test("re-renders to 'conflict' when status flips from unset → conflict", () => {
    const doc = new Y.Doc();
    const lifecycle = doc.getMap('lifecycle');
    mockPoolEntries = [{ docName: 'doc-c', provider: { document: doc } }];

    render(<Probe docName="doc-c" />);
    expect(screen.getByTestId('status').textContent).toBe('null');

    act(() => {
      lifecycle.set('status', 'conflict');
    });

    expect(screen.getByTestId('status').textContent).toBe('conflict');
  });
});
