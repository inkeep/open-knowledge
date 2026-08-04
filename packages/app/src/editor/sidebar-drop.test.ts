import { describe, expect, test, vi } from 'vitest';
import { isManagedHashHistoryState } from '@/lib/doc-hash';
import { openSidebarDropPayload, type SidebarOpenTarget } from './sidebar-drop';

describe('openSidebarDropPayload', () => {
  test('opens sidebar payloads permanently, preserves blank intent, and pushes the hash directly', () => {
    const restoreWindow = installFakeWindow({
      hash: '#/old',
      pathname: '/app',
      search: '?workspace=ok',
    });
    const openTarget = vi.fn(
      (_target: Parameters<SidebarOpenTarget>[0], _options: Parameters<SidebarOpenTarget>[1]) => {},
    );
    try {
      openSidebarDropPayload(
        { v: 1, kind: 'doc', docName: 'notes/Intro', size: null },
        openTarget,
        true,
      );
    } finally {
      restoreWindow();
    }

    expect(openTarget).toHaveBeenCalledWith(
      { kind: 'doc', target: 'notes/Intro', docName: 'notes/Intro' },
      { disposition: 'permanent', consumeActiveNewTab: true },
    );
    expect(fakePushState).toHaveBeenCalledWith(
      expect.anything(),
      '',
      '/app?workspace=ok#/notes/Intro',
    );
    expect(isManagedHashHistoryState(fakePushState.mock.calls[0]?.[0])).toBe(true);
  });
});

let fakePushState = vi.fn((_state: unknown, _unused: string, _url: string) => {});

function installFakeWindow(location: {
  hash: string;
  pathname: string;
  search: string;
}): () => void {
  fakePushState = vi.fn((_state: unknown, _unused: string, _url: string) => {});
  const global = globalThis as { window?: unknown };
  const previous = global.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        pushState: fakePushState,
      },
    },
  });
  return () => {
    if (previous === undefined) {
      delete global.window;
      return;
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  };
}
