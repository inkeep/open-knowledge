import { describe, expect, test } from 'vitest';
import {
  decideAllWindowsClosed,
  decideRelaunchReveal,
  type RelaunchWindowCandidate,
} from './last-window-policy.ts';

const flagCombinations = [
  { lastClosedWasNavigator: false, sessionEnding: false },
  { lastClosedWasNavigator: true, sessionEnding: false },
  { lastClosedWasNavigator: false, sessionEnding: true },
  { lastClosedWasNavigator: true, sessionEnding: true },
];

describe('decideAllWindowsClosed', () => {
  test.each(flagCombinations)(
    'macOS keeps the app running with no windows (Navigator last: $lastClosedWasNavigator, session ending: $sessionEnding)',
    (flags) => {
      expect(decideAllWindowsClosed({ platform: 'darwin', ...flags })).toBe('stay');
    },
  );

  describe.each<NodeJS.Platform>(['linux', 'win32'])('on %s', (platform) => {
    test('closing the last project or note window opens the Project Navigator', () => {
      expect(
        decideAllWindowsClosed({ platform, lastClosedWasNavigator: false, sessionEnding: false }),
      ).toBe('open-navigator');
    });

    test('closing the Navigator when it is the last window quits', () => {
      expect(
        decideAllWindowsClosed({ platform, lastClosedWasNavigator: true, sessionEnding: false }),
      ).toBe('quit');
    });

    test.each([false, true])(
      'quits while the OS session is ending (last closed was the Navigator: %s)',
      (lastClosedWasNavigator) => {
        expect(
          decideAllWindowsClosed({ platform, lastClosedWasNavigator, sessionEnding: true }),
        ).toBe('quit');
      },
    );
  });
});

interface FakeWindow extends RelaunchWindowCandidate {
  name: string;
}

function fakeWindow(
  name: string,
  state: { destroyed?: boolean; visible?: boolean; minimized?: boolean },
): FakeWindow {
  return {
    name,
    isDestroyed: () => state.destroyed ?? false,
    isVisible: () => state.visible ?? false,
    isMinimized: () => state.minimized ?? false,
  };
}

describe('decideRelaunchReveal', () => {
  test('reveals the most recently focused window ahead of other visible windows', () => {
    const editor = fakeWindow('editor', { visible: true });
    const note = fakeWindow('note', { visible: true });
    expect(
      decideRelaunchReveal({
        lastFocusedWindow: note,
        windows: [editor, note],
        firstWindowShown: true,
      }),
    ).toEqual({ action: 'reveal', window: note });
  });

  test('reveals a minimized most recently focused window', () => {
    const editor = fakeWindow('editor', { visible: true });
    const minimized = fakeWindow('minimized', { minimized: true });
    expect(
      decideRelaunchReveal({
        lastFocusedWindow: minimized,
        windows: [editor, minimized],
        firstWindowShown: true,
      }),
    ).toEqual({ action: 'reveal', window: minimized });
  });

  test('falls back to the first visible or minimized window when nothing was focused', () => {
    const loading = fakeWindow('loading', {});
    const minimized = fakeWindow('minimized', { minimized: true });
    const editor = fakeWindow('editor', { visible: true });
    expect(
      decideRelaunchReveal({
        lastFocusedWindow: null,
        windows: [loading, minimized, editor],
        firstWindowShown: true,
      }),
    ).toEqual({ action: 'reveal', window: minimized });
  });

  test('skips a destroyed or still-hidden focused window in favor of a visible one', () => {
    const editor = fakeWindow('editor', { visible: true });
    for (const stale of [
      fakeWindow('destroyed', { destroyed: true, visible: true }),
      fakeWindow('hidden', {}),
    ]) {
      expect(
        decideRelaunchReveal({
          lastFocusedWindow: stale,
          windows: [editor],
          firstWindowShown: true,
        }),
      ).toEqual({ action: 'reveal', window: editor });
    }
  });

  test('does nothing while every window is still hidden behind its show gate', () => {
    expect(
      decideRelaunchReveal({
        lastFocusedWindow: null,
        windows: [fakeWindow('loading', {})],
        firstWindowShown: true,
      }),
    ).toEqual({ action: 'none' });
  });

  test('opens the Project Navigator when no window exists after boot', () => {
    expect(
      decideRelaunchReveal({ lastFocusedWindow: null, windows: [], firstWindowShown: true }),
    ).toEqual({ action: 'open-navigator' });
  });

  test('does nothing when no window exists before the first window has shown', () => {
    expect(
      decideRelaunchReveal({ lastFocusedWindow: null, windows: [], firstWindowShown: false }),
    ).toEqual({ action: 'none' });
  });
});
