import { describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildDesktopUninstallCleanupScript,
  buildDesktopUninstallNoticeHtml,
  buildDesktopUninstallProgressHtml,
  buildDesktopUninstallProjectPickerHtml,
  collectDesktopUninstallProjectCandidates,
  defaultDesktopUninstallLogPath,
  desktopUninstallCompletionNotice,
  desktopUninstallConfirmNotice,
  desktopUninstallFailureNotice,
  desktopUninstallFinalStepNotice,
  formatDesktopUninstallProjectList,
  isSupportedApplicationsBundle,
  parseDesktopUninstallNoticeUrl,
  parseDesktopUninstallProjectPickerUrl,
  readDesktopUninstallLogForDisplay,
  resolveAppBundleFromExecPath,
  resolveDesktopUninstallProjectSelection,
  runDesktopUninstallCleanup,
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

  test('formats a bounded candidate list with source tags', () => {
    const formatted = formatDesktopUninstallProjectList(
      [
        { path: '/work/a', open: true, recent: false, running: true },
        { path: '/work/b', open: false, recent: true, running: false },
      ],
      1,
    );
    expect(formatted).toBe('• /work/a (open, running)\n• …and 1 more');
  });

  test('builds a scrollable project picker with every candidate and bulk controls', () => {
    const html = buildDesktopUninstallProjectPickerHtml([
      { path: '/work/a', open: true, recent: false, running: true },
      { path: '/work/<unsafe>&b', open: false, recent: true, running: false },
    ]);

    expect(html).toContain('Select all');
    expect(html).toContain('Select none');
    expect(html).toContain('ok-desktop-uninstall://');
    expect(html).toContain('overflow-y: scroll');
    expect(html).toContain('Scrollable list — review all 2 projects');
    expect(html).toContain('/work/a');
    expect(html).toContain('/work/&lt;unsafe&gt;&amp;b');
    expect(html).not.toContain('…and');
    // The drag-to-Trash instruction belongs to the post-cleanup dialog only.
    expect(html).not.toContain('Trash');
  });

  test('builds a progress page with a loading indicator', () => {
    const html = buildDesktopUninstallProgressHtml();
    expect(html).toContain('Removing OpenKnowledge files…');
    expect(html).toContain('class="spinner"');
    expect(html).toContain('role="status"');
  });

  test('parses the private picker navigation URL into selected indexes', () => {
    expect(
      parseDesktopUninstallProjectPickerUrl('ok-desktop-uninstall://confirm?indexes=2%2C0%2Cbad'),
    ).toEqual({ action: 'confirm', selectedIndexes: [2, 0] });
    // Empty selection — the default, most common confirm (global-only uninstall).
    expect(
      parseDesktopUninstallProjectPickerUrl('ok-desktop-uninstall://confirm?indexes='),
    ).toEqual({ action: 'confirm', selectedIndexes: [] });
    expect(parseDesktopUninstallProjectPickerUrl('ok-desktop-uninstall://cancel')).toEqual({
      action: 'cancel',
    });
    expect(
      parseDesktopUninstallProjectPickerUrl('https://example.test/confirm?indexes=0'),
    ).toBeNull();
  });

  test('resolves project picker output by candidate index only', () => {
    const candidates = [
      { path: '/work/a', open: true, recent: false, running: false },
      { path: '/work/b', open: false, recent: true, running: false },
      { path: '/work/c', open: false, recent: false, running: true },
    ];

    expect(
      resolveDesktopUninstallProjectSelection(candidates, {
        action: 'confirm',
        selectedIndexes: [2, 0, 2, 99, -1, '1'],
        selectedPaths: ['/work/b'],
      }),
    ).toEqual([candidates[0], candidates[2]]);
    expect(
      resolveDesktopUninstallProjectSelection(candidates, {
        action: 'confirm',
        selectedIndexes: [],
      }),
    ).toEqual([]);
    expect(resolveDesktopUninstallProjectSelection(candidates, { action: 'cancel' })).toBeNull();
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
    expect(truncated).toStartWith('… (earlier lines omitted — full log on disk)\n');
    expect(truncated).toEndWith('end-marker');
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

    const done = desktopUninstallCompletionNotice({ projectCount: 0, logPath: '/log' });
    expect(done.paragraphs.join(' ')).toContain('move OpenKnowledge.app to the Trash');
    // Projects were off by default — silence beats "No projects were deinitialized."
    expect(done.paragraphs.join(' ')).not.toContain('project');
    expect(done.footnote).toBe('Cleanup log: /log');
    expect(
      desktopUninstallCompletionNotice({ projectCount: 2, logPath: '/log' }).paragraphs.join(' '),
    ).toContain('removed from 2 projects');

    expect(desktopUninstallFinalStepNotice().paragraphs.join(' ')).toContain('Trash');
  });

  test('notice html escapes content and finishes through the private scheme', () => {
    const html = buildDesktopUninstallNoticeHtml({
      title: 'T<itle>',
      paragraphs: ['a&b'],
      footnote: 'saved <here>',
      log: 'line <1>',
      confirmLabel: 'Continue',
    });
    expect(html).toContain('T&lt;itle&gt;');
    expect(html).toContain('a&amp;b');
    expect(html).toContain('saved &lt;here&gt;');
    expect(html).toContain('line &lt;1&gt;');
    expect(html).toContain("'ok-desktop-uninstall://notice-' + action");
    expect(html).not.toContain('id="cancel"');

    const twoButton = buildDesktopUninstallNoticeHtml(desktopUninstallConfirmNotice());
    expect(twoButton).toContain('id="cancel"');
    expect(twoButton).toContain('class="danger"');
  });

  test('parses notice URLs, rejecting foreign schemes and hosts', () => {
    expect(parseDesktopUninstallNoticeUrl('ok-desktop-uninstall://notice-confirm')).toBe('confirm');
    expect(parseDesktopUninstallNoticeUrl('ok-desktop-uninstall://notice-cancel')).toBe('cancel');
    expect(parseDesktopUninstallNoticeUrl('ok-desktop-uninstall://confirm?indexes=0')).toBeNull();
    expect(parseDesktopUninstallNoticeUrl('https://example.test/notice-confirm')).toBeNull();
  });

  test('runDesktopUninstallCleanup spawns an attached shell and resolves on close', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const child = {
      once: mock((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
    };
    const spawn = mock(() => child);
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
