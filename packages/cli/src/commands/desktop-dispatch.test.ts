import type { SpawnOptions } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import {
  DESKTOP_BUNDLE_ID,
  type DetectDeps,
  detectDesktop,
  launchDesktop,
  notFoundMessage,
} from './desktop-dispatch.ts';

/** Construct a baseline deps object for darwin + interactive + no overrides. */
function baseDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    platform: 'darwin',
    env: {},
    execPath: '/usr/local/bin/node',
    isTTY: true,
    statSync: () => null,
    homeDir: '/Users/andrew',
    ...overrides,
  };
}

/** Stat impl that returns "is a file" for an exact path, null otherwise. */
function statForFile(path: string): DetectDeps['statSync'] {
  return (p) => (p === path ? { isFile: () => true, isDirectory: () => false } : null);
}

const APP_EXEC = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
const HOME_EXEC = '/Users/andrew/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

describe('detectDesktop — platform gate (FR10)', () => {
  test('unknown platform → unsupported-platform', () => {
    const result = detectDesktop(
      baseDeps({ platform: 'freebsd' as NodeJS.Platform, statSync: statForFile(APP_EXEC) }),
    );
    expect(result).toEqual({ available: false, reason: 'unsupported-platform' });
  });

  test('linux with no install → no-bundle (falls back to browser mode)', () => {
    const result = detectDesktop(baseDeps({ platform: 'linux', statSync: statForFile(APP_EXEC) }));
    expect(result).toEqual({ available: false, reason: 'no-bundle' });
  });

  test('win32 with no install → no-bundle (falls back to browser mode)', () => {
    const result = detectDesktop(baseDeps({ platform: 'win32', statSync: statForFile(APP_EXEC) }));
    expect(result).toEqual({ available: false, reason: 'no-bundle' });
  });
});

describe('detectDesktop — Windows/Linux install resolution', () => {
  // The one-click per-user NSIS install dir is the sanitized package name,
  // not productName — see WIN_INSTALL_DIR_NAMES in desktop-dispatch.ts.
  const WIN_EXE =
    'C:\\Users\\u\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\OpenKnowledge.exe';
  const DEB_EXE = '/opt/OpenKnowledge/openknowledge';

  test('win32: %LOCALAPPDATA% per-user install → available', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        statSync: statForFile(WIN_EXE),
      }),
    );
    expect(result).toEqual({ available: true, reason: 'available', bundlePath: WIN_EXE });
  });

  test('win32: bundled-CLI introspection (ok.cmd wrapper) → the running exe', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'win32',
        env: { ELECTRON_RUN_AS_NODE: '1' },
        execPath: WIN_EXE,
        statSync: () => null,
      }),
    );
    expect(result).toEqual({ available: true, reason: 'available', bundlePath: WIN_EXE });
  });

  test('linux: deb install at /opt → available (with a display)', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'linux',
        env: { DISPLAY: ':0' },
        statSync: statForFile(DEB_EXE),
      }),
    );
    expect(result).toEqual({ available: true, reason: 'available', bundlePath: DEB_EXE });
  });

  test('linux: no DISPLAY/WAYLAND_DISPLAY → headless even on a TTY', () => {
    const result = detectDesktop(
      baseDeps({ platform: 'linux', env: {}, statSync: statForFile(DEB_EXE) }),
    );
    expect(result).toEqual({ available: false, reason: 'headless', bundlePath: DEB_EXE });
  });
});

describe('detectDesktop — bundle resolution (FR10 D2 a/b/c)', () => {
  test('darwin + bundle in /Applications → available', () => {
    const result = detectDesktop(baseDeps({ statSync: statForFile(APP_EXEC) }));
    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
    expect(result.bundlePath).toBe('/Applications/OpenKnowledge.app');
  });

  test('darwin + bundle only in ~/Applications → available, home path', () => {
    const result = detectDesktop(baseDeps({ statSync: statForFile(HOME_EXEC) }));
    expect(result.available).toBe(true);
    expect(result.bundlePath).toBe('/Users/andrew/Applications/OpenKnowledge.app');
  });

  test('darwin + no bundle → no-bundle', () => {
    const result = detectDesktop(baseDeps());
    expect(result).toEqual({ available: false, reason: 'no-bundle' });
  });

  test('bundled-CLI introspection (FR10 D2 path a) — ELECTRON_RUN_AS_NODE + execPath in .app', () => {
    const result = detectDesktop(
      baseDeps({
        env: { ELECTRON_RUN_AS_NODE: '1' },
        execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        // Even if statSync returns null, introspection branch wins.
        statSync: () => null,
      }),
    );
    expect(result.available).toBe(true);
    expect(result.bundlePath).toBe('/Applications/OpenKnowledge.app');
  });

  test('bundled-CLI introspection — execPath outside .app falls through to stat probes', () => {
    const result = detectDesktop(
      baseDeps({
        env: { ELECTRON_RUN_AS_NODE: '1' },
        execPath: '/usr/local/bin/electron',
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.available).toBe(true);
    expect(result.bundlePath).toBe('/Applications/OpenKnowledge.app');
  });

  test('stat throws unexpectedly → no-bundle (probeBundle catches before reason can bubble)', () => {
    const result = detectDesktop(
      baseDeps({
        statSync: () => {
          throw new Error('EACCES: synthetic');
        },
      }),
    );
    // Through the current DI surface a stat throw is caught inside
    // probeBundle, so detectDesktop sees both probes return false and
    // reports `no-bundle`. The outer `stat-error` catch in detectDesktop
    // is unreachable here — defense-in-depth for a future probe path
    // that bypasses probeBundle's catch.
    expect(result).toEqual({ available: false, reason: 'no-bundle' });
  });
});

describe('detectDesktop — env overrides (FR8)', () => {
  test('OK_FORCE_BROWSER=1 wins over everything', () => {
    const result = detectDesktop(
      baseDeps({
        env: { OK_FORCE_BROWSER: '1', OK_FORCE_DESKTOP: '1' },
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result).toEqual({ available: false, reason: 'force-browser' });
  });

  test('OK_FORCE_BROWSER=1 with darwin + bundle still returns false', () => {
    const result = detectDesktop(
      baseDeps({
        env: { OK_FORCE_BROWSER: '1' },
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('force-browser');
  });

  test('OK_FORCE_DESKTOP=1 skips headless gate when bundle present (FR10 ordering)', () => {
    const result = detectDesktop(
      baseDeps({
        env: { OK_FORCE_DESKTOP: '1', SSH_CONNECTION: '10.0.0.1 22' },
        isTTY: false,
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
  });

  test('OK_FORCE_DESKTOP=1 still requires a bundle to exist', () => {
    const result = detectDesktop(
      baseDeps({
        env: { OK_FORCE_DESKTOP: '1' },
        statSync: () => null,
      }),
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no-bundle');
  });
});

describe('detectDesktop — headless gate (FR9 — CI is intentionally NOT a trigger)', () => {
  const WIN_EXE =
    'C:\\Users\\u\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\OpenKnowledge.exe';

  test('isTTY=false → headless', () => {
    const result = detectDesktop(baseDeps({ isTTY: false, statSync: statForFile(APP_EXEC) }));
    expect(result.available).toBe(false);
    expect(result.reason).toBe('headless');
    expect(result.bundlePath).toBe('/Applications/OpenKnowledge.app');
  });

  test('isTTY=undefined → headless (treated as false)', () => {
    const result = detectDesktop(baseDeps({ isTTY: undefined, statSync: statForFile(APP_EXEC) }));
    expect(result.reason).toBe('headless');
  });

  // win32 carve-out: Electron-as-Node stdio are pipes on Windows, so an
  // interactive console run of ok.cmd probes isTTY=undefined — never true.
  // VM-verified against a live NSIS install.
  test('win32: isTTY=undefined → available (console-wrapper signature)', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'win32',
        isTTY: undefined,
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        statSync: statForFile(WIN_EXE),
      }),
    );
    expect(result).toEqual({ available: true, reason: 'available', bundlePath: WIN_EXE });
  });

  test('win32: isTTY=undefined + CI env → headless', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'win32',
        isTTY: undefined,
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', CI: 'true' },
        statSync: statForFile(WIN_EXE),
      }),
    );
    expect(result.reason).toBe('headless');
  });

  test('win32: isTTY=undefined + SSH_CONNECTION → headless', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'win32',
        isTTY: undefined,
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', SSH_CONNECTION: '10.0.0.1 22' },
        statSync: statForFile(WIN_EXE),
      }),
    );
    expect(result.reason).toBe('headless');
  });

  test('win32: isTTY=false stays headless (explicit non-TTY signal)', () => {
    const result = detectDesktop(
      baseDeps({
        platform: 'win32',
        isTTY: false,
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        statSync: statForFile(WIN_EXE),
      }),
    );
    expect(result.reason).toBe('headless');
  });

  test('SSH_CONNECTION set → headless', () => {
    const result = detectDesktop(
      baseDeps({
        env: { SSH_CONNECTION: '10.0.0.1 22 192.168.1.1 22' },
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.reason).toBe('headless');
  });

  test('SSH_TTY set → headless', () => {
    const result = detectDesktop(
      baseDeps({
        env: { SSH_TTY: '/dev/pts/0' },
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.reason).toBe('headless');
  });

  test('CI=1 with isTTY=true → still available (CI not a trigger per design challenge 4)', () => {
    const result = detectDesktop(
      baseDeps({
        env: { CI: '1' },
        isTTY: true,
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
  });

  test('CI=true with isTTY=false → headless via isTTY (CI redundant)', () => {
    const result = detectDesktop(
      baseDeps({
        env: { CI: 'true' },
        isTTY: false,
        statSync: statForFile(APP_EXEC),
      }),
    );
    expect(result.reason).toBe('headless');
  });
});

describe('launchDesktop — spawn shape (FR11)', () => {
  test('spawns open with -b <bundle-id>, detached, stdio:ignore, unref()', () => {
    let captured: { command?: string; args?: readonly string[]; opts?: SpawnOptions } = {};
    let unrefCalled = false;

    const fakeChild = {
      unref: () => {
        unrefCalled = true;
      },
    };
    const fakeSpawn = ((command: string, args: readonly string[], opts: SpawnOptions) => {
      captured = { command, args, opts };
      return fakeChild;
    }) as unknown as Parameters<typeof launchDesktop>[0]['spawn'];

    let logged = '';
    // Platform pinned: launchDesktop defaults to process.platform (the CI
    // test host is Linux); the darwin branch is the `open -b` shape.
    launchDesktop({ spawn: fakeSpawn, log: (m) => (logged = m), platform: 'darwin' });

    expect(captured.command).toBe('open');
    expect(captured.args).toEqual(['-b', DESKTOP_BUNDLE_ID]);
    expect(captured.opts?.detached).toBe(true);
    expect(captured.opts?.stdio).toBe('ignore');
    expect(unrefCalled).toBe(true);
    expect(logged).toContain('Launching OpenKnowledge desktop');
    expect(logged).toContain('OK_FORCE_BROWSER=1');
    expect(logged).toContain('ok start');
  });

  for (const platform of ['win32', 'linux'] as const) {
    test(`${platform}: spawns the detected desktop executable directly, detached + unref`, () => {
      let captured: { command?: string; args?: readonly string[]; opts?: SpawnOptions } = {};
      let unrefCalled = false;
      const fakeSpawn = ((command: string, args: readonly string[], opts: SpawnOptions) => {
        captured = { command, args, opts };
        return {
          unref: () => {
            unrefCalled = true;
          },
        };
      }) as unknown as Parameters<typeof launchDesktop>[0]['spawn'];

      const exe =
        platform === 'win32'
          ? 'C:\\Users\\u\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\OpenKnowledge.exe'
          : '/opt/OpenKnowledge/openknowledge';
      launchDesktop(
        { spawn: fakeSpawn, log: () => {}, platform },
        { available: true, reason: 'available', bundlePath: exe },
      );

      expect(captured.command).toBe(exe);
      expect(captured.args).toEqual([]);
      expect(captured.opts?.detached).toBe(true);
      expect(captured.opts?.stdio).toBe('ignore');
      expect(unrefCalled).toBe(true);
    });
  }

  test('spawn env omits ELECTRON_RUN_AS_NODE so the launched GUI does not boot as a Node host', () => {
    // The CLI wrapper sets ELECTRON_RUN_AS_NODE=1 to use the bundled Electron
    // as Node. LaunchServices propagates env into the launched desktop
    // process — without scrubbing this var, the desktop Electron main process
    // sees it, becomes a headless Node host, and exits silently. Regression
    // guard for the "Launching..." line prints but no GUI appears symptom.
    const prevValue = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      let captured: { opts?: SpawnOptions } = {};
      const fakeSpawn = ((_command: string, _args: readonly string[], opts: SpawnOptions) => {
        captured = { opts };
        return { unref: () => {} };
      }) as unknown as Parameters<typeof launchDesktop>[0]['spawn'];

      launchDesktop({ spawn: fakeSpawn, log: () => {}, platform: 'darwin' });

      expect(captured.opts?.env).toBeDefined();
      expect(captured.opts?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    } finally {
      if (prevValue === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prevValue;
    }
  });

  test('uses bundle ID com.inkeep.open-knowledge (matches electron-builder appId)', () => {
    expect(DESKTOP_BUNDLE_ID).toBe('com.inkeep.open-knowledge');
  });
});

describe('UX message helpers — FR5 contextual notFoundMessage(reason)', () => {
  test('default (no-bundle) explains the miss + omit-mode hint', () => {
    const msg = notFoundMessage();
    expect(msg).toContain('not found');
    expect(msg).toContain('--mode');
  });

  test('headless reason explains the gate + names OK_FORCE_DESKTOP override', () => {
    const msg = notFoundMessage('headless');
    expect(msg).toContain('headless');
    expect(msg).toContain('OK_FORCE_DESKTOP');
    // Crucially: does NOT say "not found" — the bundle IS found here, the
    // user's context is what gated it.
    expect(msg).not.toContain('not found');
  });

  test('unsupported-platform (and legacy darwin-only) name the platform constraint', () => {
    for (const reason of ['darwin-only', 'unsupported-platform'] as const) {
      const msg = notFoundMessage(reason);
      expect(msg).toContain('platform');
      expect(msg).toContain('--mode=browser');
    }
  });

  test('force-browser reason names the env override', () => {
    const msg = notFoundMessage('force-browser');
    expect(msg).toContain('OK_FORCE_BROWSER');
  });

  test('stat-error reason names the filesystem failure, platform-agnostically', () => {
    const msg = notFoundMessage('stat-error');
    // No hardcoded install path: the message renders on all three platforms.
    expect(msg).not.toContain('/Applications');
    expect(msg).toMatch(/filesystem|permission/i);
  });

  test("'available' is a defensive case — caller bug surfaced in the message", () => {
    const msg = notFoundMessage('available');
    expect(msg).toContain('caller bug');
  });
});
