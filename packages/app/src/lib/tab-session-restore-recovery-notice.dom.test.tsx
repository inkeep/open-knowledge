/**
 * The notice a user sees after a repeat app-shell crash recovers without the
 * document that caused it.
 *
 * Rendered through the real sonner toaster rather than a captured mock: the
 * claims worth making are user-visible — the notice appears, it says the last
 * document could not be restored, it does not veil the app it just recovered,
 * and it can be dismissed. A call-count assertion would restate the
 * implementation instead of testing what the user gets.
 *
 * The vitest config aliases the Lingui macros to an English passthrough, so this
 * tier cannot prove the sentence came out translated; that is the i18n catalogs'
 * and the drift gate's job.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, test } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { showTabSessionRestoreRecoveryNotice } from './tab-session-restore-recovery-notice';

const NOTICE_TEXT = /last open document couldn't be restored/i;

afterEach(() => {
  // The notice lives until dismissed; clear it so it cannot bleed into the next
  // test's toaster.
  toast.dismiss();
});

describe('showTabSessionRestoreRecoveryNotice', () => {
  test('tells the user the last document could not be restored', async () => {
    render(<Toaster closeButton />);

    showTabSessionRestoreRecoveryNotice();

    await screen.findByText(NOTICE_TEXT);
  });

  test('does not veil the app it just recovered', async () => {
    // The recovered workspace behind the notice is fully usable, so nothing here
    // may trap focus or cover what is underneath.
    render(
      <>
        <Toaster closeButton />
        <a href="/somewhere">Underneath</a>
      </>,
    );

    showTabSessionRestoreRecoveryNotice();
    await screen.findByText(NOTICE_TEXT);

    expect(screen.getByRole('link', { name: 'Underneath' })).toBeTruthy();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  test('can be dismissed', async () => {
    render(<Toaster closeButton />);

    showTabSessionRestoreRecoveryNotice();
    fireEvent.click(await screen.findByRole('button', { name: /close toast/i }));

    await waitFor(() => {
      expect(screen.queryByText(NOTICE_TEXT)).toBeNull();
    });
  });

  test('a second recovery replaces the notice rather than stacking another', async () => {
    render(<Toaster closeButton />);

    showTabSessionRestoreRecoveryNotice();
    await screen.findByText(NOTICE_TEXT);
    showTabSessionRestoreRecoveryNotice();

    await waitFor(() => {
      expect(screen.getAllByText(NOTICE_TEXT)).toHaveLength(1);
    });
  });
});
