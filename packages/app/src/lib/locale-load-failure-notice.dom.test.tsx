import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import {
  dismissLocaleLoadFailureNotice,
  showLocaleLoadFailureNotice,
} from './locale-load-failure-notice';

const SONNER_DEFAULT_LIFETIME_MS = 4_000;

function renderToaster() {
  return render(<Toaster closeButton />);
}

afterEach(async () => {
  await dynamicActivate('en');
});

describe('showLocaleLoadFailureNotice', () => {
  test('names the language that failed, in the language still on screen', async () => {
    await dynamicActivate('es');
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'zh-Hans', reload: () => {} });

    await screen.findByText(/chino simplificado/);
    expect(screen.queryByText(/简体中文/)).toBeNull();
  });

  test('offers an action that carries out the retry', async () => {
    const reload = vi.fn();
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'es', reload });

    fireEvent.click(await screen.findByRole('button', { name: /reload/i }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('can be sent away without acting on it', async () => {
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    fireEvent.click(await screen.findByRole('button', { name: /close toast/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    });
  });

  test('a second failure replaces the notice rather than stacking another', async () => {
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });
    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reload/i })).toHaveLength(1);
    });
  });

  test('the notice does not take the interface away from the user', async () => {
    render(
      <>
        <Toaster closeButton />
        <a href="/somewhere">Underneath</a>
      </>,
    );

    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });

    expect(screen.getByRole('link', { name: 'Underneath' })).toBeTruthy();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  test('outlives an ordinary message, so someone who looked away still finds out', async () => {
    renderToaster();
    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });

    await new Promise((resolve) => setTimeout(resolve, SONNER_DEFAULT_LIFETIME_MS + 1_000));

    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeNull();
  });

  test('dismissing on success clears a notice the user never acted on', async () => {
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });
    dismissLocaleLoadFailureNotice();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    });
  });

  test('dismissing the notice leaves everything else the app is saying alone', async () => {
    renderToaster();

    toast.success('Saved to disk', { duration: Number.POSITIVE_INFINITY });
    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });
    dismissLocaleLoadFailureNotice();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    });
    expect(screen.queryByText('Saved to disk')).not.toBeNull();
  });

  test('the language name resolves at call time, not at module load', async () => {
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'zh-Hans', reload: () => {} });
    await screen.findByText(/Simplified Chinese/);

    await dynamicActivate('es');
    showLocaleLoadFailureNotice({ locale: 'zh-Hans', reload: () => {} });

    await waitFor(() => {
      expect(screen.queryByText(/chino simplificado/)).not.toBeNull();
    });
    expect(i18n.locale).toBe('es');
  });
});
