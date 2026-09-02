import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const captured = {
  sent: [] as (readonly string[] | undefined)[],
};

vi.doMock('./use-send-queue', () => ({
  useSendQueue: () => (threadIds?: readonly string[]) => captured.sent.push(threadIds),
}));

vi.doMock('./store', () => ({
  getSelectedQueue: () => ['t1', 't2', 't3'],
  getSelectedQueueForDoc: (docName: string) => (docName === 'recipes/stir-fry' ? ['t1', 't2'] : []),
}));

const overlay = { open: false };
vi.doMock('@/lib/overlay-layers', () => ({ isOverlayLayerOpen: () => overlay.open }));

function press(): KeyboardEvent {
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

    expect(captured.sent).toEqual([]);
  });

  test('leaves the key to the browser when it will not act', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope(null);
    expect(press().defaultPrevented).toBe(false);
  });

  test('stands down behind an open dialog, however much is ticked', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope({ scope: 'project', docName: 'recipes/stir-fry' });
    overlay.open = true;
    const event = press();

    expect(captured.sent).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test('scopes to the open document when This doc is showing', async () => {
    const { setVisibleCommentScope } = await mount();
    setVisibleCommentScope({ scope: 'doc', docName: 'recipes/stir-fry' });
    press();

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

    expect(captured.sent).toEqual([]);
  });
});
