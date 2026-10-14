import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

let collabLastError: unknown = null;

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    collabUrl: null,
    collabTerminal: true,
    collabLastError,
    retryCollab: () => {},
  }),
  useOpenBlobRunner: () => null,
}));

const { ConnectingBanner } = await import('./ConnectingBanner');

describe('ConnectingBanner terminal copy names the running channel CLI', () => {
  afterEach(() => {
    cleanup();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

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
