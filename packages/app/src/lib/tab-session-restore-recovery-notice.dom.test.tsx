import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, test } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { showTabSessionRestoreRecoveryNotice } from './tab-session-restore-recovery-notice';

const NOTICE_TEXT = /last open document couldn't be restored/i;

afterEach(() => {
  toast.dismiss();
});

describe('showTabSessionRestoreRecoveryNotice', () => {
  test('tells the user the last document could not be restored', async () => {
    render(<Toaster closeButton />);

    showTabSessionRestoreRecoveryNotice();

    await screen.findByText(NOTICE_TEXT);
  });

  test('does not veil the app it just recovered', async () => {
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
