import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const calls: string[] = [];
let failNext = false;
vi.doMock('@/lib/resolve-blocking', () => ({
  resolveBlockingChanges: (action: string) => {
    calls.push(action);
    return failNext ? Promise.reject(new Error('409')) : Promise.resolve();
  },
}));

const terminalCommands: string[] = [];
vi.doMock('@/components/handoff/terminal-command-events', () => ({
  requestTerminalCommand: (id: string) => {
    terminalCommands.push(id);
  },
}));

const PATHS = ['.claude/launch.json', '.codex/config.toml'];

async function renderPanel(paths: readonly string[] = PATHS) {
  const { SyncBlockingChanges } = await import('./SyncBlockingChanges');
  render(<SyncBlockingChanges paths={paths} />);
}

describe('SyncBlockingChanges', () => {
  beforeEach(() => {
    calls.length = 0;
    terminalCommands.length = 0;
    failNext = false;
  });

  afterEach(() => {
    cleanup();
    // Back to the browser default: the next test asserts the button's absence.
    delete (window as { okDesktop?: unknown }).okDesktop;
  });

  test('lists every blocking path rather than naming a few in a sentence', async () => {
    await renderPanel();

    for (const path of PATHS) {
      expect(screen.getByText(path)).toBeTruthy();
    }
  });

  test('renders nothing when nothing is blocking', async () => {
    await renderPanel([]);

    expect(screen.queryByTestId('sync-blocking-commit')).toBeNull();
  });

  test('commit goes straight through — it only adds a commit', async () => {
    await renderPanel();

    await userEvent.click(screen.getByTestId('sync-blocking-commit'));

    expect(calls).toEqual(['commit']);
  });

  test('there is no Discard button — the destructive verb is withheld', async () => {
    // Uncommitted content has no reflog behind it, so a confirmation dialog is
    // not recoverability. The verb ships once a snapshot does; until then the
    // panel offers Commit and a terminal.
    await renderPanel();

    expect(screen.queryByTestId('sync-blocking-discard')).toBeNull();
    expect(screen.queryByRole('button', { name: /discard/i })).toBeNull();
  });

  test('a refused action says so instead of looking like it worked', async () => {
    // The server 409s when nothing is blocking any more — a stale panel, or a
    // second click. Swallowing that would leave the buttons reading as dead.
    failNext = true;
    await renderPanel();

    await userEvent.click(screen.getByTestId('sync-blocking-commit'));

    await waitFor(() => {
      expect(screen.getByTestId('sync-blocking-error')).toBeTruthy();
    });
  });

  test('the terminal action appears only where a terminal exists', async () => {
    // The docked PTY is behind the Electron bridge; in a browser the button
    // would open nothing at all.
    await renderPanel();
    expect(screen.queryByTestId('sync-blocking-terminal')).toBeNull();
    cleanup();

    (window as { okDesktop?: unknown }).okDesktop = {};
    await renderPanel();

    await userEvent.click(screen.getByTestId('sync-blocking-terminal'));
    expect(terminalCommands).toEqual(['git-status']);
  });
});
