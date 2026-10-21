import type { DocNoticeWire } from '@inkeep/open-knowledge-core/schemas/api';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { emitBranchChanged, emitDocumentsChanged } from '@/lib/documents-events';
import { DocNoticesProvider, useDocNotices } from './use-doc-notices';

function notice(id: string, docName: string): DocNoticeWire {
  return {
    id,
    docName,
    file: `${docName}.md`,
    kind: 'both-kept',
    kept: { duplicated: 1, restoredDeletedHere: 0, restoredDeletedOutside: 0 },
    firstAt: '2026-10-20T12:00:00.000Z',
    lastAt: '2026-10-20T12:00:00.000Z',
    events: 1,
    entries: [],
  };
}

let serverNotices: DocNoticeWire[] = [];
let dismissStatus = 200;
let listCalls = 0;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  serverNotices = [];
  dismissStatus = 200;
  listCalls = 0;
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/doc-notices/dismiss') {
      return Promise.resolve(Response.json({ dismissed: true }, { status: dismissStatus }));
    }
    listCalls++;
    return Promise.resolve(Response.json({ notices: serverNotices }));
  }) as never;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function held(id: string, docName: string): DocNoticeWire {
  return {
    id,
    docName,
    file: `${docName}.md`,
    kind: 'save-held',
    cause: 'keeps-changing',
    firstAt: '2026-10-20T12:00:00.000Z',
    lastAt: '2026-10-20T12:00:00.000Z',
    events: 1,
    entries: [],
  };
}

function Probe({ docName }: { docName: string }) {
  const { notices, dismiss } = useDocNotices(docName);
  const ids = notices.map((shown) => shown.id).join(',');
  return (
    <>
      <span data-testid={`notice-${docName}`}>{ids === '' ? 'none' : ids}</span>
      {notices.map((shown) => (
        <button key={shown.id} type="button" onClick={() => dismiss(shown)}>
          dismiss {shown.id}
        </button>
      ))}
    </>
  );
}

function renderProbes() {
  return render(
    <DocNoticesProvider>
      <Probe docName="notes" />
      <Probe docName="plan" />
    </DocNoticesProvider>,
  );
}

describe('DocNoticesProvider', () => {
  test('reads the notices on mount and gives each document its own', async () => {
    serverNotices = [notice('n-notes', 'notes'), notice('n-plan', 'plan')];
    renderProbes();

    await waitFor(() => expect(screen.getByTestId('notice-notes').textContent).toBe('n-notes'));
    expect(screen.getByTestId('notice-plan').textContent).toBe('n-plan');
  });

  test('reads them again on a sync-status signal and on a branch change, not on other signals', async () => {
    renderProbes();
    await waitFor(() => expect(listCalls).toBe(1));

    serverNotices = [notice('n-notes', 'notes')];
    act(() => emitDocumentsChanged(['files']));
    expect(listCalls).toBe(1);

    act(() => emitDocumentsChanged(['sync-status']));
    await waitFor(() => expect(screen.getByTestId('notice-notes').textContent).toBe('n-notes'));

    serverNotices = [];
    act(() => emitBranchChanged('feature'));
    await waitFor(() => expect(screen.getByTestId('notice-notes').textContent).toBe('none'));
  });

  test('a document with a held save and a kept version gets both, the held one first', async () => {
    serverNotices = [notice('n-kept', 'notes'), held('n-held', 'notes')];
    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId('notice-notes').textContent).toBe('n-held,n-kept'),
    );

    fireEvent.click(screen.getByText('dismiss n-held'));

    expect(screen.getByTestId('notice-notes').textContent).toBe('n-kept');
  });

  test('a dismissal hides only that document’s notice, and one the server refuses comes back', async () => {
    serverNotices = [notice('n-notes', 'notes'), notice('n-plan', 'plan')];
    renderProbes();
    await waitFor(() => expect(screen.getByTestId('notice-notes').textContent).toBe('n-notes'));

    dismissStatus = 500;
    fireEvent.click(screen.getByText('dismiss n-notes'));

    expect(screen.getByTestId('notice-notes').textContent).toBe('none');
    expect(screen.getByTestId('notice-plan').textContent).toBe('n-plan');
    await waitFor(() => expect(screen.getByTestId('notice-notes').textContent).toBe('n-notes'));
  });

  test('outside the provider a document simply has no notice', () => {
    render(<Probe docName="notes" />);
    expect(screen.getByTestId('notice-notes').textContent).toBe('none');
  });
});
