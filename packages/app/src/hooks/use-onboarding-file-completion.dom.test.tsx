import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  globalThis.fetch = vi.fn(() =>
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
    mockDocuments([aDocument]);
    emitDocumentsChanged(['files']);
    await waitFor(() => expect(store.getSnapshot().steps.file).toBe(true));
  });

  test('ignores non-files channels — no extra fetch on graph/backlinks updates', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = freshStore();
    store.activate();
    render(<Probe store={store} />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1));
    const afterMount = fetchMock.mock.calls.length;
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
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = freshStore();
    store.activate();
    render(<Probe store={store} />);
    emitDocumentsChanged(['files']);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    expect(store.getSnapshot().steps.file).toBe(false);
  });

  test('skips subscribing and fetching when the file step is already complete', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = freshStore();
    store.activate();
    store.markStepComplete('file');
    render(<Probe store={store} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    emitDocumentsChanged(['files']);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
