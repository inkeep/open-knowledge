import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
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

async function renderForm(onSuccess?: () => void) {
  const { SubscribeForm } = await import('./SubscribeForm');
  render(<SubscribeForm source="resources_menu" onSuccess={onSuccess} />);
}

describe('SubscribeForm', () => {
  afterEach(() => {
    cleanup();
    submitSubscribe.mockReset();
    submitSubscribe.mockResolvedValue({ ok: true });
  });

  test('rejects an invalid email before hitting the network', async () => {
    await renderForm();
    await userEvent.type(screen.getByTestId('subscribe-email'), 'not-an-email');
    await userEvent.click(screen.getByTestId('subscribe-submit'));

    expect(await screen.findByRole('alert')).not.toBeNull();
    expect(submitSubscribe).not.toHaveBeenCalled();
  });

  test('submits a valid email and shows the success view', async () => {
    const onSuccess = mock(() => {});
    submitSubscribe.mockResolvedValue({ ok: true });
    await renderForm(onSuccess);

    await userEvent.type(screen.getByTestId('subscribe-email'), 'someone@example.com');
    await userEvent.click(screen.getByTestId('subscribe-submit'));

    await waitFor(() =>
      expect(submitSubscribe).toHaveBeenCalledWith('someone@example.com', 'resources_menu'),
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // Success view: confirmation copy renders and the form collapses away.
    expect(await screen.findByText(/Watch your inbox/i)).not.toBeNull();
    expect(screen.queryByTestId('subscribe-email')).toBeNull();
  });

  test('surfaces a server failure as a retryable alert, no success view', async () => {
    submitSubscribe.mockResolvedValue({ ok: false, reason: 'error' });
    await renderForm();

    await userEvent.type(screen.getByTestId('subscribe-email'), 'someone@example.com');
    await userEvent.click(screen.getByTestId('subscribe-submit'));

    expect(await screen.findByRole('alert')).not.toBeNull();
    // No success view: the form is still present and the success copy never rendered.
    expect(screen.getByTestId('subscribe-email')).not.toBeNull();
    expect(screen.queryByText(/Watch your inbox/i)).toBeNull();
  });

  test('maps reason "invalid" to the field-level email error, no success view', async () => {
    submitSubscribe.mockResolvedValue({ ok: false, reason: 'invalid' });
    await renderForm();

    await userEvent.type(screen.getByTestId('subscribe-email'), 'someone@example.com');
    await userEvent.click(screen.getByTestId('subscribe-submit'));

    expect(await screen.findByText(/Please enter a valid email address/i)).not.toBeNull();
    expect(screen.getByTestId('subscribe-email')).not.toBeNull();
    expect(screen.queryByText(/Watch your inbox/i)).toBeNull();
  });

  test('maps reason "unavailable" to its distinct message, no success view', async () => {
    submitSubscribe.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await renderForm();

    await userEvent.type(screen.getByTestId('subscribe-email'), 'someone@example.com');
    await userEvent.click(screen.getByTestId('subscribe-submit'));

    expect(await screen.findByText(/Subscriptions aren't available right now/i)).not.toBeNull();
    expect(screen.getByTestId('subscribe-email')).not.toBeNull();
    expect(screen.queryByText(/Watch your inbox/i)).toBeNull();
  });
});
