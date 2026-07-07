import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  createOnboardingCardStore,
  type OnboardingCardStorage,
  type OnboardingCardStore,
} from '@/lib/onboarding-card-store';
import { useOnboardingCardVisible } from './use-onboarding-card-visible';

const CURRENT_PATH = '/Users/me/project';

function memoryStorage(): OnboardingCardStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function setDesktopHost(recents: Array<{ path: string }>): void {
  (window as unknown as { okDesktop: unknown }).okDesktop = {
    project: { listRecent: () => Promise.resolve(recents) },
    config: { projectPath: CURRENT_PATH },
  };
}

function clearDesktopHost(): void {
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
}

function mockDocuments(documents: unknown[]): void {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ documents }), { status: 200 })),
  ) as never;
}

function Probe({ store }: { store: OnboardingCardStore }) {
  const visible = useOnboardingCardVisible(store);
  return <div data-testid="visible">{String(visible)}</div>;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  clearDesktopHost();
});

describe('useOnboardingCardVisible', () => {
  test('no desktop host → never visible, never activates', async () => {
    clearDesktopHost();
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    const store = createOnboardingCardStore(memoryStorage());
    render(<Probe store={store} />);
    // No host → the probe never runs; nothing can flip activation. Assert it
    // stayed un-fired (no /api/documents read) rather than waiting a fixed delay.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('visible').textContent).toBe('false');
    expect(store.getSnapshot().initialized).toBe(false);
  });

  test('fresh single-project desktop session → activates and becomes visible', async () => {
    setDesktopHost([{ path: CURRENT_PATH }]);
    mockDocuments([]);
    const store = createOnboardingCardStore(memoryStorage());
    render(<Probe store={store} />);
    await waitFor(() => expect(screen.getByTestId('visible').textContent).toBe('true'));
    expect(store.getSnapshot().initialized).toBe(true);
  });

  test('established session (other project present) → stays hidden', async () => {
    const listRecent = mock(() => Promise.resolve([{ path: CURRENT_PATH }, { path: '/other' }]));
    (window as unknown as { okDesktop: unknown }).okDesktop = {
      project: { listRecent },
      config: { projectPath: CURRENT_PATH },
    };
    mockDocuments([]);
    const store = createOnboardingCardStore(memoryStorage());
    render(<Probe store={store} />);
    // Wait until the probe actually queried recents, flush its decision, then
    // assert it declined to activate — a deterministic checkpoint, not a delay.
    await waitFor(() => expect(listRecent).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId('visible').textContent).toBe('false');
    expect(store.getSnapshot().initialized).toBe(false);
  });

  test('dismissed store → hidden and skips evaluation', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    setDesktopHost([{ path: CURRENT_PATH }]);
    const store = createOnboardingCardStore(memoryStorage());
    store.dismiss();
    render(<Probe store={store} />);
    // Suppressed stores skip the probe entirely — assert no /api/documents read
    // (the "skips evaluation" claim) instead of waiting a fixed delay.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('visible').textContent).toBe('false');
  });

  test('latch: stays visible after a step completes (entry count no longer 0)', async () => {
    setDesktopHost([{ path: CURRENT_PATH }]);
    mockDocuments([]);
    const store = createOnboardingCardStore(memoryStorage());
    render(<Probe store={store} />);
    await waitFor(() => expect(screen.getByTestId('visible').textContent).toBe('true'));
    // First file created → step completes; the store re-renders synchronously and
    // the card must remain visible (latched) — no arbitrary delay needed.
    act(() => {
      store.markStepComplete('file');
    });
    expect(screen.getByTestId('visible').textContent).toBe('true');
  });

  test('completed store → hidden forever', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as never;
    setDesktopHost([{ path: CURRENT_PATH }]);
    const store = createOnboardingCardStore(memoryStorage());
    store.markCompleted();
    render(<Probe store={store} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('visible').textContent).toBe('false');
  });

  test('cancels a pending activation when the probe unmounts mid-flight', async () => {
    // Stall the recents probe so it is still pending at unmount. The effect
    // cleanup sets `cancelled`, so a resolution after unmount must NOT activate —
    // otherwise it would latch a card for a project the user already left.
    let resolveRecents!: (r: Array<{ path: string }>) => void;
    const listRecent = mock(
      () =>
        new Promise<Array<{ path: string }>>((res) => {
          resolveRecents = res;
        }),
    );
    (window as unknown as { okDesktop: unknown }).okDesktop = {
      project: { listRecent },
      config: { projectPath: CURRENT_PATH },
    };
    mockDocuments([]);
    const store = createOnboardingCardStore(memoryStorage());
    const view = render(<Probe store={store} />);
    await waitFor(() => expect(listRecent).toHaveBeenCalled());
    view.unmount();
    // Resolve after unmount with a fresh single project that WOULD have activated
    // had the component stayed mounted.
    await act(async () => {
      resolveRecents([{ path: CURRENT_PATH }]);
    });
    expect(store.getSnapshot().initialized).toBe(false);
  });
});
