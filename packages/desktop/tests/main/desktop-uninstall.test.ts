import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  buildDesktopUninstallCleanupScript,
  collectDesktopUninstallProjectCandidates,
  defaultDesktopUninstallLogPath,
  desktopUninstallCompletionNotice,
  desktopUninstallConfirmNotice,
  desktopUninstallFailureNotice,
  desktopUninstallFinalStepNotice,
  isSupportedApplicationsBundle,
  readDesktopUninstallLogForDisplay,
  resolveAppBundleFromExecPath,
  resolveDesktopUninstallUiPreviewMode,
  runDesktopUninstallCleanup,
  selectDesktopUninstallProjectsByIndex,
} from '../../src/main/desktop-uninstall.ts';

describe('desktop self-uninstall helpers', () => {
  test('resolves only packaged macOS .app exec paths', () => {
    expect(
      resolveAppBundleFromExecPath(
        '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        'darwin',
      ),
    ).toBe('/Applications/OpenKnowledge.app');
    expect(
      resolveAppBundleFromExecPath(
        '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        'linux',
      ),
    ).toBeNull();
    expect(resolveAppBundleFromExecPath('/usr/bin/node', 'darwin')).toBeNull();
  });

  test('allows only the canonical Applications install locations', () => {
    expect(isSupportedApplicationsBundle('/Applications/OpenKnowledge.app', '/Users/alice')).toBe(
      true,
    );
    expect(
      isSupportedApplicationsBundle('/Users/alice/Applications/OpenKnowledge.app', '/Users/alice'),
    ).toBe(true);
    expect(
      isSupportedApplicationsBundle('/Volumes/OpenKnowledge/OpenKnowledge.app', '/Users/alice'),
    ).toBe(false);
    expect(
      isSupportedApplicationsBundle('/Applications/OpenKnowledge Beta.app', '/Users/alice'),
    ).toBe(false);
  });

  test('collects open, recent, and running project candidates with .ok markers only', () => {
    const candidates = collectDesktopUninstallProjectCandidates({
      openProjectPaths: ['/work/open', '/work/dupe'],
      recentProjects: [{ path: '/work/recent' }, { path: '/work/dupe' }, { path: '/work/missing' }],
      lockDirs: ['/work/running/.ok/local', '/work/dupe/.ok/local'],
      exists: (path) => !path.includes('missing') && path.endsWith(join('.ok')),
    });

    expect(candidates).toEqual([
      { path: '/work/open', open: true, recent: false, running: false },
      { path: '/work/dupe', open: true, recent: true, running: true },
      { path: '/work/recent', open: false, recent: true, running: false },
      { path: '/work/running', open: false, recent: false, running: true },
    ]);
  });

  test('resolves a picker intent to candidates the renderer could not have widened', () => {
    const candidates = [
      { path: '/work/a', open: true, recent: false, running: false },
      { path: '/work/b', open: false, recent: true, running: false },
      { path: '/work/c', open: false, recent: false, running: true },
    ];

    expect(selectDesktopUninstallProjectsByIndex(candidates, [1])).toEqual([candidates[1]]);
    expect(selectDesktopUninstallProjectsByIndex(candidates, [])).toEqual([]);

    // Everything a hostile renderer could try in place of an index: values that
    // reach past the list, values that are not indexes at all, and paths the
    // renderer would like to have deleted. None of it survives.
    expect(
      selectDesktopUninstallProjectsByIndex(candidates, [
        3,
        99,
        -1,
        1.5,
        Number.NaN,
        '0',
        '/etc/passwd',
        { path: '/etc/passwd' },
        null,
      ]),
    ).toEqual([]);
    expect(selectDesktopUninstallProjectsByIndex(candidates, '/etc/passwd')).toEqual([]);
    expect(selectDesktopUninstallProjectsByIndex(candidates, undefined)).toEqual([]);

    // Duplicates collapse and order follows main's list, not the renderer's.
    expect(selectDesktopUninstallProjectsByIndex(candidates, [2, 0, 2])).toEqual([
      candidates[0],
      candidates[2],
    ]);
  });

  test('builds a cleanup script that deinitializes selected projects before global uninstall', () => {
    const script = buildDesktopUninstallCleanupScript({
      cliPath: "/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok's.sh",
      projectPaths: ['/work/a', "/work/quote's"],
      logPath: '/Users/alice/Library/Logs/OpenKnowledge/uninstall.log',
    });

    expect(script).toContain("set -- '/work/a' '/work/quote'\\''s'");
    expect(script).toContain('"$OK_CLI" deinit --yes "$project"');
    expect(script).toContain('"$OK_CLI" uninstall --yes');
    expect(script).not.toContain('osascript');
    expect(script).not.toContain('Finder');
    expect(script).toContain(
      "OK_CLI='/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok'\\''s.sh'",
    );
  });

  test('a zero-project cleanup script skips deinit but still uninstalls globally', () => {
    const script = buildDesktopUninstallCleanupScript({
      cliPath: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
      projectPaths: [],
      logPath: '/Users/alice/Library/Logs/OpenKnowledge/uninstall.log',
    });

    expect(script).toContain('No project deinit paths selected.');
    expect(script).not.toContain('deinit --yes');
    expect(script).toContain('"$OK_CLI" uninstall --yes');
  });

  test('default log path lives outside app data and is timestamped safely', () => {
    expect(
      defaultDesktopUninstallLogPath('/Users/alice', new Date('2026-07-08T01:02:03.004Z')),
    ).toBe('/Users/alice/Library/Logs/OpenKnowledge/uninstall-2026-07-08T01-02-03-004Z.log');
  });

  test('reads the cleanup log for display, tail-truncating oversized logs', () => {
    expect(readDesktopUninstallLogForDisplay('/log', { readFile: () => 'cleanup output\n' })).toBe(
      'cleanup output',
    );
    expect(readDesktopUninstallLogForDisplay('/log', { readFile: () => '  \n' })).toBeNull();
    expect(
      readDesktopUninstallLogForDisplay('/log', {
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();

    const truncated = readDesktopUninstallLogForDisplay('/log', {
      readFile: () => `start-marker${'x'.repeat(8000)}end-marker`,
    });
    const elision = '… (earlier lines omitted — full log on disk)\n';
    expect(truncated?.slice(0, elision.length)).toBe(elision);
    expect(truncated?.slice(-'end-marker'.length)).toBe('end-marker');
    expect(truncated).not.toContain('start-marker');
  });

  test('failure notice embeds the log and still names the saved file', () => {
    const notice = desktopUninstallFailureNotice({
      error: 'cleanup process exited with code 1',
      logPath: '/Users/alice/Library/Logs/OpenKnowledge/uninstall.log',
      logText: 'Could not remove:\n  ✗ Remove .claude/skills/pack/',
    });
    expect(notice.log).toContain('✗ Remove .claude/skills/pack/');
    expect(notice.footnote).toContain('/Users/alice/Library/Logs/OpenKnowledge/uninstall.log');

    // Unreadable log → the raw error + a path-only hint, no log block.
    const noLog = desktopUninstallFailureNotice({
      error: 'cleanup process exited with code 1',
      logPath: '/log',
      logText: null,
    });
    expect(noLog.log).toBeUndefined();
    expect(noLog.paragraphs).toContain('cleanup process exited with code 1');
    expect(noLog.footnote).toContain('/log');
  });

  test('notice copy stays terse and routes trash guidance post-cleanup', () => {
    const confirm = desktopUninstallConfirmNotice();
    expect(confirm.cancelLabel).toBe('Cancel');
    expect(confirm.danger).toBe(true);
    expect(confirm.paragraphs.join(' ')).not.toContain('Trash');

    const done = desktopUninstallCompletionNotice({ projectCount: 0 });
    // A scannable checklist — two done items plus the one remaining action.
    expect((done.checklist ?? []).map((item) => item.label)).toEqual([
      'Kept your content',
      'Removed OpenKnowledge files',
      'Move OpenKnowledge.app to the Trash',
    ]);
    expect(done.checklist?.[0]?.done).toBe(true);
    expect(done.checklist?.[1]?.done).toBe(true);
    expect(done.checklist?.[2]?.done).toBe(false); // the one pending action
    expect(done.confirmLabel).toBe('Reveal in Finder');
    // The log is a link, not a raw path; the path never enters the spec/HTML.
    expect(done.logRevealLabel).toBe('Cleanup log');
    expect(done.footnote).toBeUndefined();
    expect(done.paragraphs).toEqual([]);
    // Projects were off by default — no project count in the removed-item detail.
    expect(done.checklist?.[1]?.detail).not.toContain('project');
    expect(desktopUninstallCompletionNotice({ projectCount: 2 }).checklist?.[1]?.detail).toContain(
      '2 projects',
    );

    expect(desktopUninstallFinalStepNotice().paragraphs.join(' ')).toContain('Trash');
  });

  test('runDesktopUninstallCleanup spawns an attached shell and resolves on close', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const child = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
    };
    const spawn = vi.fn(() => child);
    const resultPromise = runDesktopUninstallCleanup(
      {
        cliPath: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
        projectPaths: [],
        logPath: '/tmp/ok-uninstall.log',
      },
      { spawn },
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe('/bin/sh');
    expect(spawn.mock.calls[0]?.[1]).toEqual(['-c', expect.any(String)]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: '/', detached: false, stdio: 'ignore' });
    listeners.get('close')?.(0, null);
    await expect(resultPromise).resolves.toEqual({ ok: true });
  });

  test('runDesktopUninstallCleanup surfaces spawn errors, exit codes, and signals', async () => {
    const input = {
      cliPath: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
      projectPaths: [],
      logPath: '/tmp/ok-uninstall.log',
    };
    const run = (fire: (listeners: Map<string, (...args: unknown[]) => void>) => void) => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const child = {
        once: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
        },
      };
      const result = runDesktopUninstallCleanup(input, { spawn: () => child });
      fire(listeners);
      return result;
    };

    await expect(run((l) => l.get('error')?.(new Error('spawn EACCES')))).resolves.toEqual({
      ok: false,
      error: 'spawn EACCES',
    });
    await expect(run((l) => l.get('close')?.(1, null))).resolves.toEqual({
      ok: false,
      error: 'cleanup process exited with code 1',
      exitCode: 1,
    });
    await expect(run((l) => l.get('close')?.(null, 'SIGKILL'))).resolves.toEqual({
      ok: false,
      error: 'cleanup process exited after signal SIGKILL',
      exitCode: null,
    });
    // A synchronous spawn throw settles too (no hung uninstall flow).
    await expect(
      runDesktopUninstallCleanup(input, {
        spawn: () => {
          throw new Error('shell missing');
        },
      }),
    ).resolves.toEqual({ ok: false, error: 'shell missing' });
  });
});

describe('resolveDesktopUninstallUiPreviewMode', () => {
  test('always returns null in a packaged build, even for a valid mode', () => {
    // The isPackaged guard is the safety gate that keeps the non-destructive
    // preview scaffolding from ever short-circuiting the real cleanup path in a
    // shipped app. An inversion here would let a packaged build enter preview.
    for (const raw of ['success', 'failure', 'renderer', 'picker', 'survey', 'notice', '1']) {
      expect(resolveDesktopUninstallUiPreviewMode(raw, true)).toBeNull();
    }
  });

  test('maps each recognized env value to its mode in a dev build', () => {
    expect(resolveDesktopUninstallUiPreviewMode('success', false)).toBe('success');
    expect(resolveDesktopUninstallUiPreviewMode('1', false)).toBe('success');
    expect(resolveDesktopUninstallUiPreviewMode('true', false)).toBe('success');
    expect(resolveDesktopUninstallUiPreviewMode('failure', false)).toBe('failure');
    expect(resolveDesktopUninstallUiPreviewMode('fail', false)).toBe('failure');
    expect(resolveDesktopUninstallUiPreviewMode('renderer', false)).toBe('renderer');
    expect(resolveDesktopUninstallUiPreviewMode('picker', false)).toBe('picker');
    expect(resolveDesktopUninstallUiPreviewMode('survey', false)).toBe('survey');
    expect(resolveDesktopUninstallUiPreviewMode('notice', false)).toBe('notice');
  });

  test('returns null for an unset or unrecognized value in a dev build', () => {
    expect(resolveDesktopUninstallUiPreviewMode(undefined, false)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('', false)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('failed', false)).toBeNull();
  });
});
