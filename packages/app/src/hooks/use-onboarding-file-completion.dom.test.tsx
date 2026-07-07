import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { emitDocumentsChanged } from '@/lib/documents-events';
import {
  createOnboardingCardStore,
  type OnboardingCardStorage,
  type OnboardingCardStore,
} from '@/lib/onboarding-card-store';
import { useOnboardingFileCompletion } from './use-onboarding-file-completion';

function freshStore(): OnboardingCardStore {
  const map = new Map<string, string>();
  const storage: OnboardingCardStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
  return createOnboardingCardStore(storage);
}

function mockDocuments(documents: unknown[]): void {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ documents }), { status: 200 })),
  ) as never;
}

const aDocument = { kind: 'document', docName: 'welcome', size: 0, modified: '2026-06-30' };

function Probe({ store }: { store: OnboardingCardStore }) {
  useOnboardingFileCompletion(store);
  return null;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('useOnboardingFileCompletion', () => {
  test('marks the file step when a files change reveals content', async () => {
    mockDocuments([]);
    const store = freshStore();
    store.activate();
    render(<Probe store={store} />);
    // Initial mount saw an empty project; now the first file lands.
    mockDocuments([aDocument]);
    emitDocumentsChanged(['files']);
    await waitFor(() => expect(store.getSnapshot().steps.file).toBe(true));
  });

  test('ignores non-files channels — no extra fetch on graph/backlinks updates', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = freshStore();
    store.activate();
    render(<Probe store={store} />);
    // Let the mount-time probe settle, then baseline the call count.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1));
    const afterMount = fetchMock.mock.calls.length;
    // Non-files channels must be filtered out — no additional /api/documents read.
    emitDocumentsChanged(['graph']);
    emitDocumentsChanged(['backlinks']);
    await act(async () => {});
    expect(fetchMock.mock.calls.length).toBe(afterMount);
  });

  test('marks the file step at mount when content already exists', async () => {
    mockDocuments([aDocument]);
    const store = freshStore();
    store.activate();
    render(<Probe store={store} />);
    await waitFor(() => expect(store.getSnapshot().steps.file).toBe(true));
  });

  test('does not mark the step while the project stays empty', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = freshStore();
    store.activate();
    render(<Probe store={store} />);
    emitDocumentsChanged(['files']);
    // Wait for evidence both count reads ran (mount + the files event), flush the
    // resolution chain, then assert the empty project left the step incomplete —
    // a deterministic checkpoint instead of an arbitrary fixed delay.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    expect(store.getSnapshot().steps.file).toBe(false);
  });

  test('skips subscribing and fetching when the file step is already complete', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = freshStore();
    store.activate();
    store.markStepComplete('file'); // already complete before mount
    render(<Probe store={store} />);
    // The mount-time guard short-circuits: no /api/documents read at all...
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    // ...and no subscription was registered, so a later files event is ignored.
    emitDocumentsChanged(['files']);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
