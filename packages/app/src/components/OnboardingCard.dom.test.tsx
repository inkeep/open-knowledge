import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Stub the animated mascot — its rAF/SVG internals aren't under test here.
mock.module('@/components/OkBlob', () => ({
  OkBlob: () => <span data-testid="ok-blob" />,
}));

import { formatShortcut } from '@/lib/keyboard-shortcuts';
import {
  createOnboardingCardStore,
  type OnboardingCardStorage,
  type OnboardingCardStore,
} from '@/lib/onboarding-card-store';
import { OnboardingCard } from './OnboardingCard';

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

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
  ) as never;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('OnboardingCard', () => {
  test('renders the three steps with step 1 pre-checked and 1/3 progress', () => {
    render(<OnboardingCard store={freshStore()} />);
    expect(screen.getByText('Get set up')).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByText('Create your first project')).toBeTruthy();
    expect(screen.getByText('Create your first file')).toBeTruthy();
    expect(screen.getByText('Ask AI')).toBeTruthy();
    // The live region is pre-registered (mounted always) but must stay silent
    // during the checklist state — the other half of the WCAG 4.1.3 invariant.
    expect(screen.getByRole('status').textContent?.trim()).toBe('');
  });

  test('step rows are informational, not interactive buttons', () => {
    render(<OnboardingCard store={freshStore()} />);
    // The only button in the card is Dismiss; steps are static.
    expect(screen.queryByRole('button', { name: /Create your first file/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Create your first project/ })).toBeNull();
  });

  test('shows the registry shortcut glyphs for the active platform', () => {
    render(<OnboardingCard store={freshStore()} />);
    expect(screen.getByText(formatShortcut('new-item'))).toBeTruthy();
    expect(screen.getByText(formatShortcut('open-ask-ai'))).toBeTruthy();
  });

  test('Dismiss permanently dismisses via the store', () => {
    const store = freshStore();
    render(<OnboardingCard store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(store.getSnapshot().dismissed).toBe(true);
  });

  test('a completed step advances progress and stays non-interactive', async () => {
    const store = freshStore();
    render(<OnboardingCard store={store} />);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    act(() => {
      store.markStepComplete('file');
    });
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Create your first file/ })).toBeNull();
  });

  test('completing all steps celebrates in-card (blob) then auto-closes', async () => {
    const store = freshStore();
    store.markStepComplete('file');
    store.markStepComplete('askedAi');
    render(<OnboardingCard store={store} lingerMs={20} />);
    // In-card celebration: the mascot + "all set up" message, no checklist.
    expect(screen.getByTestId('ok-blob')).toBeTruthy();
    // Visible message + the sr-only live-region announcement both carry the text.
    expect(screen.getAllByText(/all set up/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Create your first file')).toBeNull();
    // Auto-closes for good after the celebration.
    await waitFor(() => expect(store.getSnapshot().completed).toBe(true));
  });
});
