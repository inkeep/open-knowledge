/**
 * The notice a user gets when the catalog for the language they picked does not
 * arrive.
 *
 * Rendered through the real sonner toaster rather than a captured mock, because
 * the claims worth making here are user-visible ones: the notice appears, it
 * says which language failed, it offers a way to retry, and it can be sent
 * away. A call-count assertion would restate the implementation instead.
 *
 * The vitest config aliases the Lingui macros to an English passthrough, so no
 * test in this tier can prove a sentence came out translated. The language
 * NAME is a different matter — it comes from `Intl.DisplayNames`, which is the
 * platform rather than Lingui, so it is genuinely rendered in whichever locale
 * the notice resolves against. That is what makes the "still in the language
 * you were reading" claim checkable here.
 */

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

/** How long an ordinary sonner toast lives when it names no duration of its own. */
const SONNER_DEFAULT_LIFETIME_MS = 4_000;

function renderToaster() {
  return render(<Toaster closeButton />);
}

afterEach(async () => {
  await dynamicActivate('en');
});

describe('showLocaleLoadFailureNotice', () => {
  test('names the language that failed, in the language still on screen', async () => {
    // Reading Spanish, asked for Simplified Chinese, and the catalog never
    // came. Naming it "简体中文" would tell the user in a script they may not
    // read that a script they may not read is unavailable.
    await dynamicActivate('es');
    renderToaster();

    showLocaleLoadFailureNotice({ locale: 'zh-Hans', reload: () => {} });

    await screen.findByText(/chino simplificado/);
    expect(screen.queryByText(/简体中文/)).toBeNull();
  });

  test('offers an action that carries out the retry', async () => {
    // What the real action does is reload, which no runner can survive; the
    // e2e drives that end. What is checkable here is that the button is wired
    // to it at all.
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
    // Non-blocking is the whole point: a failed language switch leaves a
    // perfectly usable app behind it, so nothing here may trap focus or veil
    // what is underneath.
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
    // Clicking a language and turning back to a UI that never changed, with
    // nothing on screen saying why, is indistinguishable from the setting
    // having silently failed to stick.
    renderToaster();
    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });

    // Real time rather than a fake clock: sonner starts the dismissal timer
    // when the toast mounts, so a fake clock installed afterwards has nothing
    // left to advance and the wait would pass for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, SONNER_DEFAULT_LIFETIME_MS + 1_000));

    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeNull();
  });

  test('dismissing on success clears a notice the user never acted on', async () => {
    // Otherwise picking a second language that works leaves a red complaint
    // about the first one sitting over an interface that already switched.
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
    // The active locale is whatever the user is reading when the failure
    // happens, which is not knowable when this module is first imported.
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
