
import { describe, expect, mock, test } from 'bun:test';
import {
  GitNotAvailableError,
  GitTooOldError,
  type InstallGuidance,
} from '@inkeep/open-knowledge-server';
import { ensureGitAvailable, type MessageBoxOptions } from './git-preflight-handler.ts';

const LINUX_GUIDANCE: InstallGuidance = {
  product: 'Git',
  platform: 'linux',
  url: 'https://git-scm.com/download/linux',
  options: [
    {
      label: 'Install with apt',
      command: 'sudo apt install git',
      requiresAdmin: true,
    },
  ],
};

const MAC_GUIDANCE: InstallGuidance = {
  product: 'Git',
  platform: 'darwin',
  url: 'https://git-scm.com/download/mac',
  options: [
    {
      label: 'Install with Homebrew (recommended; no admin needed)',
      command: 'brew install git',
      requiresAdmin: false,
    },
  ],
};

function showMessageBoxSequence(responses: readonly number[]) {
  const remaining = [...responses];
  const calls: MessageBoxOptions[] = [];
  const fn = mock(async (opts: MessageBoxOptions) => {
    calls.push(opts);
    const next = remaining.shift();
    if (next === undefined) {
      throw new Error(`showMessageBox called more times than queued (call #${calls.length})`);
    }
    return { response: next };
  });
  return { fn, calls };
}

describe('ensureGitAvailable', () => {
  test("returns 'ok' on first-try success without showing dialog", async () => {
    const assertGitAvailable = mock(() => ({
      ok: true as const,
      version: '2.45.0',
      resolvedPath: '/usr/bin/git',
      source: 'PATH' as const,
    }));
    const { fn: showMessageBox, calls } = showMessageBoxSequence([]);
    const openExternal = mock(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('ok');
    expect(assertGitAvailable).toHaveBeenCalledTimes(1);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  test("Quit on first dialog returns 'aborted' without further preflight", async () => {
    let calls = 0;
    const assertGitAvailable = mock(() => {
      calls += 1;
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      2, // BUTTON_QUIT
    ]);
    const openExternal = mock(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(calls).toBe(1);
    expect(boxCalls).toHaveLength(1);
    expect(boxCalls[0]?.type).toBe('warning');
    expect(boxCalls[0]?.title).toBe('Git not found');
    expect(boxCalls[0]?.buttons).toEqual([
      'Open Install Page',
      "I've Installed Git — Retry",
      'Quit',
    ]);
    expect(boxCalls[0]?.defaultId).toBe(1);
    expect(boxCalls[0]?.cancelId).toBe(2);
    expect(boxCalls[0]?.detail).toContain('sudo apt install git');
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('Open Install Page opens URL and re-shows dialog; Quit ends loop', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      0, // BUTTON_OPEN_INSTALL_PAGE
      2, // BUTTON_QUIT
    ]);
    const openExternal = mock(async (_url: string) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://git-scm.com/download/mac');
    expect(boxCalls).toHaveLength(2);
    expect(assertGitAvailable).toHaveBeenCalledTimes(1);
  });

  test("Retry → success returns 'recovered'", async () => {
    let attempts = 0;
    const assertGitAvailable = mock(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
      }
      return {
        ok: true as const,
        version: '2.45.0',
        resolvedPath: '/usr/bin/git',
        source: 'PATH' as const,
      };
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      1, // BUTTON_RETRY
    ]);
    const openExternal = mock(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('recovered');
    expect(attempts).toBe(2);
    expect(boxCalls).toHaveLength(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('Retry → still-missing re-shows dialog; user can Quit to end', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      1, // BUTTON_RETRY
      1, // BUTTON_RETRY
      2, // BUTTON_QUIT
    ]);
    const openExternal = mock(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(assertGitAvailable).toHaveBeenCalledTimes(3);
    expect(boxCalls).toHaveLength(3);
  });

  test('GitTooOldError variant: dialog title + message reflect the too-old shape', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      2, // BUTTON_QUIT
    ]);
    const openExternal = mock(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(boxCalls[0]?.title).toBe('Git too old');
    expect(boxCalls[0]?.message).toBe('OpenKnowledge requires Git 2.31.0 or newer.');
    expect(boxCalls[0]?.detail).toContain('detected 2.20.0 at /usr/bin/git');
  });

  test("non-typed error from preflight shows error dialog before 'aborted'", async () => {
    const assertGitAvailable = mock(() => {
      throw new Error('something completely different');
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      0, // The unknown-error dialog has a single 'Quit' button at index 0.
    ]);
    const openExternal = mock(async () => {});
    const warn = mock((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(boxCalls).toHaveLength(1);
    expect(boxCalls[0]?.type).toBe('error');
    expect(boxCalls[0]?.buttons).toEqual(['Quit']);
    expect(boxCalls[0]?.title).toBe('OpenKnowledge could not start');
    expect(boxCalls[0]?.detail).toContain('something completely different');
    expect(openExternal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const warnCall = warn.mock.calls[0];
    expect(warnCall?.[0]).toContain('unexpected error');
  });

  test('retry that throws non-typed error shows error dialog before aborted', async () => {
    let attempts = 0;
    const assertGitAvailable = mock(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
      }
      throw new Error('git binary crashed unexpectedly');
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      1, // BUTTON_RETRY on the typed-error dialog
      0, // Quit on the unknown-error dialog that follows the failed retry
    ]);
    const openExternal = mock(async () => {});
    const warn = mock((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(attempts).toBe(2);
    expect(boxCalls).toHaveLength(2);
    expect(boxCalls[0]?.type).toBe('warning'); // typed-error dialog
    expect(boxCalls[1]?.type).toBe('error'); // unknown-error dialog
    expect(boxCalls[1]?.buttons).toEqual(['Quit']);
    expect(boxCalls[1]?.detail).toContain('git binary crashed unexpectedly');
    expect(warn).toHaveBeenCalled();
    const warnCall = warn.mock.calls[0];
    expect(warnCall?.[0]).toContain('unexpected retry error');
  });

  test('openExternal failure surfaces the URL in the next dialog detail', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      0, // BUTTON_OPEN_INSTALL_PAGE (openExternal throws)
      2, // BUTTON_QUIT
    ]);
    const openExternal = mock(async (_url: string) => {
      throw new Error('no XDG default browser configured');
    });
    const warn = mock((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(boxCalls).toHaveLength(2);
    expect(boxCalls[0]?.detail).not.toContain('Could not open browser');
    expect(boxCalls[1]?.detail).toContain('Could not open browser automatically');
    expect(boxCalls[1]?.detail).toContain('https://git-scm.com/download/mac');
  });

  test('openExternal success after prior failure clears the URL hint', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([
      0, // BUTTON_OPEN_INSTALL_PAGE — openExternal throws
      0, // BUTTON_OPEN_INSTALL_PAGE — openExternal succeeds
      2, // BUTTON_QUIT
    ]);
    let attempts = 0;
    const openExternal = mock(async (_url: string) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('browser unavailable');
      }
    });
    const warn = mock((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(boxCalls).toHaveLength(3);
    expect(boxCalls[1]?.detail).toContain('Could not open browser automatically');
    expect(boxCalls[2]?.detail).not.toContain('Could not open browser');
  });

  test('openExternal failure does not abort the loop; user can still Retry', async () => {
    let attempts = 0;
    const assertGitAvailable = mock(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
      }
      return {
        ok: true as const,
        version: '2.45.0',
        resolvedPath: '/opt/homebrew/bin/git',
        source: 'fallback' as const,
      };
    });
    const { fn: showMessageBox } = showMessageBoxSequence([
      0, // BUTTON_OPEN_INSTALL_PAGE (openExternal throws)
      1, // BUTTON_RETRY (preflight succeeds)
    ]);
    const openExternal = mock(async (_url: string) => {
      throw new Error('browser unavailable');
    });
    const warn = mock((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('recovered');
    expect(attempts).toBe(2);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    const warnCall = warn.mock.calls[0];
    expect(warnCall?.[0]).toContain('openExternal failed');
  });

  test('out-of-range dialog response is treated as Quit (defensive)', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox } = showMessageBoxSequence([
      -1,
    ]);
    const openExternal = mock(async () => {});
    const warn = mock((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(warn).toHaveBeenCalled();
    const warnCall = warn.mock.calls[0];
    expect(warnCall?.[0]).toContain('unexpected dialog response');
  });

  test('handler does NOT require a log dep (no-op default)', async () => {
    const assertGitAvailable = mock(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox } = showMessageBoxSequence([
      2, // BUTTON_QUIT
    ]);
    const openExternal = mock(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('aborted');
  });
});
