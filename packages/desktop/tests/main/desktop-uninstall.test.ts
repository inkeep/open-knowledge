import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildDesktopUninstallCleanupScript,
  collectDesktopUninstallProjectCandidates,
  defaultDesktopUninstallLogPath,
  desktopUninstallConfirmNotice,
  desktopUninstallFailureNotice,
  isSupportedApplicationsBundle,
  readDesktopUninstallLogForDisplay,
  resolveAppBundleFromExecPath,
  resolveDesktopUninstallUiPreviewMode,
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
  });
});

describe('resolveDesktopUninstallUiPreviewMode', () => {
  test('always returns null in a packaged build, even for a valid mode', () => {
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
