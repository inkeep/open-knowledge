import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import {
  createSubscribeCardStore,
  type SubscribeCardStorage,
  type SubscribeCardStore,
} from '@/lib/subscribe-card-store';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const submitSubscribe = mock(
  async (_email: string) =>
    ({ ok: true }) as Awaited<ReturnType<typeof import('@/lib/subscribe').submitSubscribe>>,
);
mock.module('@/lib/subscribe', () => ({ submitSubscribe }));

function memoryStorage(): SubscribeCardStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function makeStore(): SubscribeCardStore {
  return createSubscribeCardStore(memoryStorage());
}

async function renderCard(
  overrides: Partial<{
    store: SubscribeCardStore;
    onOpenReleaseNotes: () => void;
    onClose: () => void;
    autoDismissMs: number;
  }> = {},
) {
  const { SubscribeCard } = await import('./SubscribeCard');
  const props = {
    version: '1.4.0',
    onOpenReleaseNotes: mock(() => {}),
    onClose: mock(() => {}),
    store: makeStore(),
    autoDismissMs: 5,
    ...overrides,
  };
  render(
    <SubscribeCard
      version={props.version}
      onOpenReleaseNotes={props.onOpenReleaseNotes}
      onClose={props.onClose}
      store={props.store}
      autoDismissMs={props.autoDismissMs}
    />,
  );
  return props;
}

afterEach(() => {
  cleanup();
  submitSubscribe.mockReset();
  submitSubscribe.mockResolvedValue({ ok: true });
});

describe('SubscribeCard (combined release-notes + subscribe)', () => {
  test('renders the form, social links, and the release-notes footer', async () => {
    await renderCard();

    expect(screen.getByTestId('subscribe-email')).toBeTruthy();
    expect(screen.getByText('Follow us on')).toBeTruthy();
    expect(screen.getByText(/Updated to Version/)).toBeTruthy();
    expect(screen.getByText('1.4.0', { exact: false })).toBeTruthy();

    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://x.com/OpenKnowledge');
    expect(hrefs).toContain('https://github.com/inkeep/open-knowledge');
    expect(hrefs).toContain('https://discord.com/invite/YujKpFN49');
  });

  test('clicking Release notes opens the release notes', async () => {
    const onOpenReleaseNotes = mock(() => {});
    await renderCard({ onOpenReleaseNotes });
    await userEvent.click(screen.getByRole('button', { name: 'Release notes' }));
    expect(onOpenReleaseNotes).toHaveBeenCalledTimes(1);
  });

  test('dismissing closes the card and stops the prompt for good', async () => {
    const onClose = mock(() => {});
    const store = makeStore();
    await renderCard({ store, onClose });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(store.getSnapshot().dismissed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a confirmed subscribe marks subscribed, collapses socials, then auto-dismisses', async () => {
    submitSubscribe.mockResolvedValue({ ok: true });
    const onClose = mock(() => {});
    const store = makeStore();
    await renderCard({ store, onClose, autoDismissMs: 5 });

    await userEvent.type(screen.getByTestId('subscribe-email'), 'someone@example.com');
    await userEvent.click(screen.getByTestId('subscribe-submit'));

    await waitFor(() => expect(submitSubscribe).toHaveBeenCalled());
    expect(store.getSnapshot().subscribed).toBe(true);
    // Social row collapses on success; the release-notes row stays.
    expect(screen.queryByText('Follow us on')).toBeNull();
    expect(screen.getByText(/Updated to Version/)).toBeTruthy();
    // Auto-dismiss fires after the linger.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
