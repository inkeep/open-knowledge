import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

let collabTerminal = true;
let collabLastError: unknown = null;

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    collabUrl: null,
    collabTerminal,
    collabLastError,
    retryCollab: () => {},
  }),
  useOpenBlobRunner: () => null,
}));

const { ConnectingBanner } = await import('./ConnectingBanner');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  collabTerminal = true;
  collabLastError = null;
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
});

describe('ConnectingBanner placement', () => {
  test('the terminal variant starts below the application header rather than over it', () => {
    render(<ConnectingBanner />);

    expectVisualClassTokens(screen.getByRole('alert').className, [
      'fixed',
      'top-[var(--ok-app-header-height,0px)]',
      'inset-x-0',
    ]);
  });

  test('the retrying variant starts below the application header rather than over it', async () => {
    collabTerminal = false;
    vi.useFakeTimers();
    render(<ConnectingBanner />);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expectVisualClassTokens(screen.getByRole('status').className, [
      'fixed',
      'top-[var(--ok-app-header-height,0px)]',
      'inset-x-0',
    ]);
  });
});

describe('ConnectingBanner terminal copy names the running channel CLI', () => {
  test.each([
    [undefined, 'ok'],
    ['ok-beta', 'ok-beta'],
  ])('no collab server names %s start', (cliCommandName, command) => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = { cliCommandName };
    collabLastError = { kind: 'null-collab' };
    render(<ConnectingBanner />);
    expect(screen.getByRole('alert').textContent).toContain(
      `No collab server for this worktree — run ${command} start here, or reopen the project.`,
    );
  });

  test.each([
    [undefined, 'ok'],
    ['ok-beta', 'ok-beta'],
  ])('an unreachable server names %s status and start', (cliCommandName, command) => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = { cliCommandName };
    collabLastError = { kind: 'error', code: 'network' };
    render(<ConnectingBanner />);
    expect(screen.getByRole('alert').textContent).toContain(
      `Couldn't reach collab server — network error (is \`${command} start\` running?). Try ${command} status or check .ok/local/last-spawn-error.log.`,
    );
  });
});
