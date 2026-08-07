/**
 * What ⇧⌘Enter sends, now that it reads the visible scope.
 *
 * The chord is global — it fires while you type, with the panel behind you — so
 * the property that matters is that its blast radius follows what is ON SCREEN:
 * the doc scope sends that file's ticked comments, the project scope the whole
 * checked queue, and a CLOSED panel sends nothing at all. That last one is the
 * load-bearing case: falling back to the project queue there gave the chord its
 * widest reach exactly where the user could see least.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const captured = {
  sent: [] as (readonly string[] | undefined)[],
};

vi.doMock('./use-send-queue', () => ({
  useSendQueue: () => (threadIds?: readonly string[]) => captured.sent.push(threadIds),
}));

// The whole checked queue spans two files; `t1`/`t2` are on the doc the panel
// is showing.
vi.doMock('./store', () => ({
  getSelectedQueue: () => ['t1', 't2', 't3'],
  getSelectedQueueForDoc: (docName: string) => (docName === 'recipes/stir-fry' ? ['t1', 't2'] : []),
}));

// Mutable so the modal case is reachable: the guard is the only thing standing
// between an open dialog and an irreversible batch send.
const overlay = { open: false };
vi.doMock('@/lib/overlay-layers', () => ({ isOverlayLayerOpen: () => overlay.open }));

function press(): KeyboardEvent {
  // Ctrl, not Cmd: the matcher resolves the binding against the running
  // platform, and jsdom reports a non-mac one — so the windowsLinux half of
  // ⇧⌘Enter / Ctrl+Shift+Enter is the live binding in here.
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
    bubbles: true,
  });
  fireEvent(window, event);
  return event;
}

afterEach(() => {
  cleanup();
  captured.sent.length = 0;
  overlay.open = false;
});

async function mount() {
  const { CommentQueueShortcut } = await import('./CommentQueueShortcut');
  const { setVisibleCommentScope } = await import('./visible-scope');
  render(<CommentQueueShortcut />);
  return { setVisibleCommentScope };
}

describe('the queue chord', () => {
  test('sends NOTHING with no panel on screen', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope(null);
    press();

    // Deliberately not the project queue: a send is irreversible, and with the
    // panel closed nothing on screen says what would go.
    expect(captured.sent).toEqual([]);
  });

  test('leaves the key to the browser when it will not act', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope(null);
    // Not swallowed for a no-op — the chord claims the event only when it sends.
    expect(press().defaultPrevented).toBe(false);
  });

  test('stands down behind an open dialog, however much is ticked', async () => {
    const { setVisibleCommentScope } = await mount();
    // A scope that WOULD send, so the only thing declining is the overlay guard.
    setVisibleCommentScope({ scope: 'project', docName: 'recipes/stir-fry' });
    overlay.open = true;
    const event = press();

    // The panel is behind the dialog, so the batch it describes is not what the
    // user is looking at — and a send cannot be taken back.
    expect(captured.sent).toEqual([]);
    // Unclaimed too: a layer that owns the keyboard gets its own key back.
    expect(event.defaultPrevented).toBe(false);
  });

  test('scopes to the open document when This doc is showing', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope({ scope: 'doc', docName: 'recipes/stir-fry' });
    press();

    // A subset, never a superset: the file the reader is not looking at cannot
    // ride along on a keypress aimed at the one they are.
    expect(captured.sent).toEqual([['t1', 't2']]);
  });

  test('widens again on This project', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope({ scope: 'project', docName: 'recipes/stir-fry' });
    press();

    expect(captured.sent).toEqual([['t1', 't2', 't3']]);
  });

  test('follows a scope change without re-mounting', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope({ scope: 'project', docName: 'recipes/stir-fry' });
    press();
    // The listener installs once and never re-runs, so the scope has to be read
    // at press time — a value closed over at mount would still say "project".
    setVisibleCommentScope({ scope: 'doc', docName: 'recipes/stir-fry' });
    press();

    expect(captured.sent).toEqual([
      ['t1', 't2', 't3'],
      ['t1', 't2'],
    ]);
  });

  test('leaves the chord unclaimed when the visible scope has nothing ticked', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope({ scope: 'doc', docName: 'recipes/soup' });
    press();

    // Deliberately NOT "send the project queue instead": a press aimed at a doc
    // with nothing ticked must not quietly ship the other file's comments.
    expect(captured.sent).toEqual([]);
  });
});
