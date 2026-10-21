import {
  GitNotAvailableError,
  GitProbeTimeoutError,
  GitTooOldError,
  type InstallGuidance,
} from '@inkeep/open-knowledge-server';
import { describe, expect, test, vi } from 'vitest';
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
  const fn = vi.fn(async (opts: MessageBoxOptions) => {
    calls.push(opts);
    const next = remaining.shift();
    if (next === undefined) {
      throw new Error(`showMessageBox called more times than queued (call #${calls.length})`);
    }
    return { response: next };
  });
  return { fn, calls };
}

const WINDOWS_GUIDANCE: InstallGuidance = {
  product: 'Git for Windows',
  url: 'https://gitforwindows.org/',
  options: [],
};

function probeTimeout(): GitProbeTimeoutError {
  return new GitProbeTimeoutError('win32', WINDOWS_GUIDANCE, {
    path: 'timeout',
    fallback: 'timeout',
  });
}

function showMessageBoxChoosing(chooseLabel: (opts: MessageBoxOptions, call: number) => string) {
  const calls: MessageBoxOptions[] = [];
  const fn = vi.fn(async (opts: MessageBoxOptions) => {
    calls.push(opts);
    const label = chooseLabel(opts, calls.length);
    expect(opts.buttons, `buttons of dialog #${calls.length}`).toContain(label);
    return { response: opts.buttons.indexOf(label) };
  });
  return { fn, calls };
}

describe('ensureGitAvailable', () => {
  test("returns 'ok' on first-try success without showing dialog", async () => {
    const assertGitAvailable = vi.fn(() => ({
      ok: true as const,
      version: '2.45.0',
      resolvedPath: '/usr/bin/git',
      source: 'PATH' as const,
    }));
    const { fn: showMessageBox, calls } = showMessageBoxSequence([]);
    const openExternal = vi.fn(async () => {});

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
    const assertGitAvailable = vi.fn(() => {
      calls += 1;
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([2]);
    const openExternal = vi.fn(async () => {});

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
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([0, 2]);
    const openExternal = vi.fn(async (_url: string) => {});

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
    const assertGitAvailable = vi.fn(() => {
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
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([1]);
    const openExternal = vi.fn(async () => {});

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
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([1, 1, 2]);
    const openExternal = vi.fn(async () => {});

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
    const assertGitAvailable = vi.fn(() => {
      throw new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([2]);
    const openExternal = vi.fn(async () => {});

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

  test('GitProbeTimeoutError uses timeout guidance instead of Git-not-found guidance', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitProbeTimeoutError(
        'win32',
        {
          product: 'Git for Windows',
          url: 'https://gitforwindows.org/',
          options: [],
        },
        { path: 'timeout', fallback: 'timeout' },
      );
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxChoosing(() => 'Quit');
    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal: vi.fn(async () => {}),
    });

    expect(outcome).toBe('aborted');
    expect(boxCalls[0]?.title).toBe('Git probe timed out');
    expect(boxCalls[0]?.message).toContain('could not verify Git for Windows');
    expect(boxCalls[0]?.message).not.toContain('Git not found');
    const buttons = boxCalls[0]?.buttons ?? [];
    expect(buttons).toEqual(['Retry', 'Quit']);
    expect(buttons[boxCalls[0]?.defaultId ?? -1]).toBe('Retry');
    expect(buttons[boxCalls[0]?.cancelId ?? -1]).toBe('Quit');
  });

  test('no button on a probe-timeout dialog opens the install page', async () => {
    const discovery = showMessageBoxChoosing(() => 'Quit');
    await ensureGitAvailable({
      assertGitAvailable: vi.fn(() => {
        throw probeTimeout();
      }),
      showMessageBox: discovery.fn,
      openExternal: vi.fn(async () => {}),
    });
    const timeoutButtons = discovery.calls[0]?.buttons ?? [];
    expect(timeoutButtons.length).toBeGreaterThan(0);

    for (const [index, label] of timeoutButtons.entries()) {
      const openExternal = vi.fn(async (_url: string) => {});
      const answers: number[] = [];
      const showMessageBox = vi.fn(async (opts: MessageBoxOptions) => {
        const response = answers.length === 0 ? index : opts.buttons.indexOf('Quit');
        answers.push(response);
        return { response };
      });

      const outcome = await ensureGitAvailable({
        assertGitAvailable: vi.fn(() => {
          throw probeTimeout();
        }),
        showMessageBox,
        openExternal,
      });

      expect(outcome, `pressing ${label}`).toBe('aborted');
      expect(openExternal, `pressing ${label}`).not.toHaveBeenCalled();
    }
  });

  test('Retry on a probe-timeout dialog re-runs the probe and logs a retry', async () => {
    let attempts = 0;
    const assertGitAvailable = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw probeTimeout();
      }
      return {
        ok: true as const,
        version: '2.56.0',
        resolvedPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
        source: 'PATH' as const,
      };
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxChoosing(() => 'Retry');
    const openExternal = vi.fn(async (_url: string) => {});
    const info = vi.fn((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn: vi.fn(), info },
    });

    expect(outcome).toBe('recovered');
    expect(attempts).toBe(2);
    expect(boxCalls).toHaveLength(1);
    expect(openExternal).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toEqual({ response: 'retry' });
  });

  test('a response outside the probe-timeout button set aborts as unexpected', async () => {
    const discovery = showMessageBoxChoosing(() => 'Quit');
    await ensureGitAvailable({
      assertGitAvailable: vi.fn(() => {
        throw probeTimeout();
      }),
      showMessageBox: discovery.fn,
      openExternal: vi.fn(async () => {}),
    });
    const outOfRange = discovery.calls[0]?.buttons.length ?? 0;
    expect(outOfRange).toBeGreaterThan(0);

    const assertGitAvailable = vi.fn(() => {
      throw probeTimeout();
    });
    const openExternal = vi.fn(async (_url: string) => {});
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox: vi.fn(async () => ({ response: outOfRange })),
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(assertGitAvailable).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
    expect(warn.mock.calls.at(-1)?.[0]).toContain('unexpected dialog response');
    expect(warn.mock.calls.at(-1)?.[1]).toEqual({ response: outOfRange });
  });

  test('a probe timeout after a failed install-page open omits the browser fallback note', async () => {
    let attempts = 0;
    const assertGitAvailable = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
      }
      throw probeTimeout();
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxChoosing((_opts, call) => {
      if (call === 1) return 'Open Install Page';
      if (call === 2) return "I've Installed Git — Retry";
      return 'Quit';
    });
    const openExternal = vi.fn(async (_url: string) => {
      throw new Error('no default browser configured');
    });

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn: vi.fn() },
    });

    expect(outcome).toBe('aborted');
    expect(boxCalls).toHaveLength(3);
    expect(boxCalls[1]?.title).toBe('Git not found');
    expect(boxCalls[1]?.detail).toContain('Could not open browser automatically');
    expect(boxCalls[2]?.title).toBe('Git probe timed out');
    expect(boxCalls[2]?.detail).not.toContain('Could not open browser');
    expect(boxCalls[2]?.detail).not.toContain(MAC_GUIDANCE.url);
  });

  test('a probe timeout logs its probe results without install wording', async () => {
    const { fn: showMessageBox } = showMessageBoxChoosing(() => 'Quit');
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    await ensureGitAvailable({
      assertGitAvailable: vi.fn(() => {
        throw probeTimeout();
      }),
      showMessageBox,
      openExternal: vi.fn(async () => {}),
      log: { warn },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] ?? [];
    expect(fields).toEqual({
      code: 'GIT_PROBE_TIMEOUT',
      platform: 'win32',
      pathProbe: 'timeout',
      fallbackProbe: 'timeout',
    });
    expect(message).not.toMatch(/git unavailable/i);
    expect(message).not.toMatch(/install dialog/i);
  });

  test('a too-old Git keeps the install-page, installed-retry and quit buttons', async () => {
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxChoosing(() => 'Quit');

    await ensureGitAvailable({
      assertGitAvailable: vi.fn(() => {
        throw new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', LINUX_GUIDANCE);
      }),
      showMessageBox,
      openExternal: vi.fn(async () => {}),
    });

    expect(boxCalls[0]?.buttons).toEqual([
      'Open Install Page',
      "I've Installed Git — Retry",
      'Quit',
    ]);
    expect(boxCalls[0]?.defaultId).toBe(1);
    expect(boxCalls[0]?.cancelId).toBe(2);
  });

  test("non-typed error from preflight shows error dialog before 'aborted'", async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new Error('something completely different');
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([0]);
    const openExternal = vi.fn(async () => {});
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

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
    const assertGitAvailable = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
      }
      throw new Error('git binary crashed unexpectedly');
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([1, 0]);
    const openExternal = vi.fn(async () => {});
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(attempts).toBe(2);
    expect(boxCalls).toHaveLength(2);
    expect(boxCalls[0]?.type).toBe('warning');
    expect(boxCalls[1]?.type).toBe('error');
    expect(boxCalls[1]?.buttons).toEqual(['Quit']);
    expect(boxCalls[1]?.detail).toContain('git binary crashed unexpectedly');
    expect(warn.mock.calls.map(([msg]) => msg)).toEqual([
      expect.stringContaining('waiting on the install dialog'),
      expect.stringContaining('unexpected retry error'),
    ]);
  });

  test('openExternal failure surfaces the URL in the next dialog detail', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([0, 2]);
    const openExternal = vi.fn(async (_url: string) => {
      throw new Error('no XDG default browser configured');
    });
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

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
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('darwin', MAC_GUIDANCE);
    });
    const { fn: showMessageBox, calls: boxCalls } = showMessageBoxSequence([0, 0, 2]);
    let attempts = 0;
    const openExternal = vi.fn(async (_url: string) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('browser unavailable');
      }
    });
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

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
    const assertGitAvailable = vi.fn(() => {
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
    const { fn: showMessageBox } = showMessageBoxSequence([0, 1]);
    const openExternal = vi.fn(async (_url: string) => {
      throw new Error('browser unavailable');
    });
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('recovered');
    expect(attempts).toBe(2);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map(([msg]) => msg)).toEqual([
      expect.stringContaining('waiting on the install dialog'),
      expect.stringContaining('openExternal failed'),
      expect.stringContaining('waiting on the install dialog'),
    ]);
  });

  test('out-of-range dialog response is treated as Quit (defensive)', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox } = showMessageBoxSequence([-1]);
    const openExternal = vi.fn(async () => {});
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(warn.mock.calls.map(([msg]) => msg)).toEqual([
      expect.stringContaining('waiting on the install dialog'),
      expect.stringContaining('unexpected dialog response'),
    ]);
  });

  test('logs the git failure before the install dialog settles, then the answer', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE, {
        probe: { path: 'unparseable', fallback: 'enoent' },
      });
    });
    let answer: (value: { response: number }) => void = () => {};
    const showMessageBox = vi.fn(
      () =>
        new Promise<{ response: number }>((resolve) => {
          answer = resolve;
        }),
    );
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});
    const info = vi.fn((_msg: string, _obj?: unknown) => {});

    const pending = ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal: vi.fn(async () => {}),
      log: { warn, info },
    });
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('waiting on the install dialog'), {
      code: 'GIT_NOT_AVAILABLE',
      platform: 'linux',
      pathProbe: 'unparseable',
      fallbackProbe: 'enoent',
    });
    expect(info).not.toHaveBeenCalled();

    answer({ response: 2 });

    await expect(pending).resolves.toBe('aborted');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('install dialog answered'), {
      response: 'quit',
    });
  });

  test('a too-old git logs the detected and required versions', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitTooOldError('darwin', '2.20.0', '2.31.0', '/usr/bin/git', MAC_GUIDANCE);
    });
    const { fn: showMessageBox } = showMessageBoxSequence([2]);
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal: vi.fn(async () => {}),
      log: { warn },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('waiting on the install dialog'), {
      code: 'GIT_TOO_OLD',
      platform: 'darwin',
      detected: '2.20.0',
      required: '2.31.0',
      resolvedPath: '/usr/bin/git',
    });
  });

  test('a git-missing error without probe detail logs null probe fields', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('win32', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox } = showMessageBoxSequence([2]);
    const warn = vi.fn((_msg: string, _obj?: unknown) => {});

    await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal: vi.fn(async () => {}),
      log: { warn },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('waiting on the install dialog'), {
      code: 'GIT_NOT_AVAILABLE',
      platform: 'win32',
      pathProbe: null,
      fallbackProbe: null,
    });
  });

  test('handler does NOT require a log dep (no-op default)', async () => {
    const assertGitAvailable = vi.fn(() => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    });
    const { fn: showMessageBox } = showMessageBoxSequence([2]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      showMessageBox,
      openExternal,
    });

    expect(outcome).toBe('aborted');
  });
});
