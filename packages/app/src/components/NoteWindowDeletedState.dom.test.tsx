import { act, cleanup, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __resetNoteWindowDeletedForTests,
  getNoteWindowDeletedDoc,
  markNoteWindowDocDeleted,
  subscribeNoteWindowDeleted,
} from '@/lib/note-window-deleted-store';
import { NoteWindowDeletedState } from './NoteWindowDeletedState';

afterEach(() => {
  cleanup();
  __resetNoteWindowDeletedForTests();
  vi.restoreAllMocks();
});

describe('NoteWindowDeletedState', () => {
  test('names the deleted document and offers a way out', () => {
    render(<NoteWindowDeletedState docName="notes/alpha" />);

    expect(screen.getByTestId('note-window-deleted-state')).not.toBeNull();
    expect(screen.getByText('notes/alpha')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Close window' })).not.toBeNull();
  });

  test('the close affordance is a real button, so it is keyboard reachable', () => {
    render(<NoteWindowDeletedState docName="notes/alpha" />);
    const button = screen.getByRole('button', { name: 'Close window' });

    expect(button.tagName).toBe('BUTTON');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('tabindex')).not.toBe('-1');
  });

  test('moves focus to the close button on mount, so a keyboard user is not stranded', () => {
    render(<NoteWindowDeletedState docName="notes/alpha" />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close window' }));
  });

  test('closes the window when activated, rather than navigating anywhere', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<NoteWindowDeletedState docName="notes/alpha" />);

    screen.getByRole('button', { name: 'Close window' }).click();

    expect(close).toHaveBeenCalledOnce();
  });
});

describe('note-window deleted store', () => {
  test('starts healthy', () => {
    expect(getNoteWindowDeletedDoc()).toBeNull();
  });

  test('records the deleted document and reports it handled', () => {
    expect(markNoteWindowDocDeleted('notes/alpha')).toBe(true);
    expect(getNoteWindowDeletedDoc()).toBe('notes/alpha');
  });

  test('a repeat mark for the same document stays handled', () => {
    markNoteWindowDocDeleted('notes/alpha');
    expect(markNoteWindowDocDeleted('notes/alpha')).toBe(true);
    expect(getNoteWindowDeletedDoc()).toBe('notes/alpha');
  });

  test('notifies a subscriber on mark, and its cleanup stops further notifications', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNoteWindowDeleted(listener);

    markNoteWindowDocDeleted('notes/alpha');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    markNoteWindowDocDeleted('notes/beta');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('note-window deleted store — subscriber re-render', () => {
  function DeletedProbe() {
    const deletedDocName = useSyncExternalStore(
      subscribeNoteWindowDeleted,
      getNoteWindowDeletedDoc,
    );
    return deletedDocName ? (
      <NoteWindowDeletedState docName={deletedDocName} />
    ) : (
      <div data-testid="healthy-editor" />
    );
  }

  test('a mark after mount re-renders the subscriber into the deleted state', () => {
    render(<DeletedProbe />);
    expect(screen.queryByTestId('note-window-deleted-state')).toBeNull();
    expect(screen.getByTestId('healthy-editor')).not.toBeNull();

    act(() => {
      markNoteWindowDocDeleted('notes/alpha');
    });

    expect(screen.getByTestId('note-window-deleted-state')).not.toBeNull();
    expect(screen.getByText('notes/alpha')).not.toBeNull();
    expect(screen.queryByTestId('healthy-editor')).toBeNull();
  });
});
