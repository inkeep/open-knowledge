import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  closeTerminalWindowsForProject,
  getTerminalWindowContext,
  hasLocalProjectAuthority,
  isPtyWindowAuthorityCurrent,
  registerTerminalWindow,
  resolvePtyProjectRoot,
  resolveWindowProjectAuthority,
  unregisterTerminalWindow,
} from './terminal-window-registry.ts';

// Unique windowIds per test + explicit cleanup so the module-global Map does not
// leak across cases.
const WIN_A = 90_001;
const WIN_B = 90_002;
const WIN_C = 90_003;
const NOOP_LIFECYCLE = { window: {}, reapPtys: () => {} };

const REMOTE = {
  kind: 'ssh' as const,
  machineId: 'machine-1',
  machineName: 'Build host',
  path: '/srv/project',
  platform: 'linux',
  pathSeparator: '/' as const,
};

afterEach(() => {
  unregisterTerminalWindow(WIN_A);
  unregisterTerminalWindow(WIN_B);
  unregisterTerminalWindow(WIN_C);
});

describe('terminal-window registry', () => {
  test('round-trips a registered window context by windowId', () => {
    registerTerminalWindow(
      WIN_A,
      {
        projectRoot: '/Users/me/project',
        collabUrl: 'ws://localhost:5200/collab',
        apiOrigin: 'http://localhost:5200',
      },
      NOOP_LIFECYCLE,
    );
    expect(getTerminalWindowContext(WIN_A)).toEqual({
      projectRoot: '/Users/me/project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('returns undefined for an unregistered window', () => {
    expect(getTerminalWindowContext(WIN_B)).toBeUndefined();
  });

  test('unregister removes the entry', () => {
    registerTerminalWindow(WIN_A, { projectRoot: '/Users/me/project' }, NOOP_LIFECYCLE);
    unregisterTerminalWindow(WIN_A);
    expect(getTerminalWindowContext(WIN_A)).toBeUndefined();
  });

  test('closing a remote project closes only matching remote terminal windows', () => {
    let matchingCloses = 0;
    let localCloses = 0;
    let otherRemoteCloses = 0;
    registerTerminalWindow(
      WIN_A,
      { projectRoot: 'ssh://machine-1/srv/project', remote: REMOTE },
      { window: { close: () => matchingCloses++ }, reapPtys: () => {} },
    );
    registerTerminalWindow(
      WIN_B,
      { projectRoot: 'ssh://machine-1/srv/project' },
      { window: { close: () => localCloses++ }, reapPtys: () => {} },
    );
    registerTerminalWindow(
      WIN_C,
      {
        projectRoot: 'ssh://machine-1/srv/other',
        remote: { ...REMOTE, path: '/srv/other' },
      },
      { window: { close: () => otherRemoteCloses++ }, reapPtys: () => {} },
    );

    expect(closeTerminalWindowsForProject('ssh://machine-1/srv/project')).toBe(1);
    expect(matchingCloses).toBe(1);
    expect(localCloses).toBe(0);
    expect(otherRemoteCloses).toBe(0);
  });

  test('closing a remote project prunes an already-destroyed terminal window', () => {
    registerTerminalWindow(
      WIN_A,
      { projectRoot: 'ssh://machine-1/srv/project', remote: REMOTE },
      { window: { close: () => {}, isDestroyed: () => true }, reapPtys: () => {} },
    );

    expect(closeTerminalWindowsForProject('ssh://machine-1/srv/project')).toBe(0);
    expect(getTerminalWindowContext(WIN_A)).toBeUndefined();
  });

  test('reaps PTYs even when native destroy and close both fail', () => {
    let reaps = 0;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerTerminalWindow(
        WIN_A,
        { projectRoot: 'ssh://machine-1/srv/project', remote: REMOTE },
        {
          window: {
            destroy: () => {
              throw new Error('destroy failed');
            },
            close: () => {
              throw new Error('close failed');
            },
          },
          reapPtys: () => reaps++,
        },
      );

      expect(closeTerminalWindowsForProject('ssh://machine-1/srv/project')).toBe(0);
      expect(reaps).toBe(1);
      expect(getTerminalWindowContext(WIN_A)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain('remote-terminal-window-destroy-failed');
      expect(warn.mock.calls[1]?.[0]).toContain('remote-terminal-window-close-failed');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolvePtyProjectRoot', () => {
  test('an editor window keeps its windowsByPath-resolved project path', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: '/Users/me/editor-project',
      terminalWindow: { projectRoot: '/Users/me/other' },
      homedir: '/Users/me',
    });
    expect(root).toBe('/Users/me/editor-project');
  });

  test('a project-bound terminal window resolves to its registered project root', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: { projectRoot: '/Users/me/project' },
      homedir: '/Users/me',
    });
    expect(root).toBe('/Users/me/project');
  });

  test('a project-less terminal window resolves to the home directory (never null)', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: { projectRoot: null },
      homedir: '/Users/me',
    });
    expect(root).toBe('/Users/me');
  });

  test('a window in neither map (e.g. the Navigator) resolves to null so the handler refuses', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: undefined,
      homedir: '/Users/me',
    });
    expect(root).toBeNull();
  });
});

describe('isPtyWindowAuthorityCurrent', () => {
  test('accepts the exact live editor authority captured before an await', () => {
    const editorContext = { projectPath: '/Users/me/project' };
    expect(
      isPtyWindowAuthorityCurrent({
        sameWindow: true,
        windowDestroyed: false,
        senderDestroyed: false,
        capturedEditorContext: editorContext,
        liveEditorContext: editorContext,
        capturedTerminalWindow: undefined,
        liveTerminalWindow: undefined,
      }),
    ).toBe(true);
  });

  test('refuses a replaced editor or revoked standalone terminal authority', () => {
    const capturedEditor = { projectPath: '/Users/me/project' };
    const terminal = { projectRoot: '/Users/me/project' };
    expect(
      isPtyWindowAuthorityCurrent({
        sameWindow: true,
        windowDestroyed: false,
        senderDestroyed: false,
        capturedEditorContext: capturedEditor,
        liveEditorContext: { projectPath: '/Users/me/project' },
        capturedTerminalWindow: undefined,
        liveTerminalWindow: undefined,
      }),
    ).toBe(false);
    expect(
      isPtyWindowAuthorityCurrent({
        sameWindow: true,
        windowDestroyed: false,
        senderDestroyed: false,
        capturedEditorContext: null,
        liveEditorContext: null,
        capturedTerminalWindow: terminal,
        liveTerminalWindow: undefined,
      }),
    ).toBe(false);
  });

  test('refuses a destroyed or no-longer-matching native window', () => {
    const editorContext = { projectPath: '/Users/me/project' };
    for (const state of [
      { sameWindow: false, windowDestroyed: false, senderDestroyed: false },
      { sameWindow: true, windowDestroyed: true, senderDestroyed: false },
      { sameWindow: true, windowDestroyed: false, senderDestroyed: true },
    ]) {
      expect(
        isPtyWindowAuthorityCurrent({
          ...state,
          capturedEditorContext: editorContext,
          liveEditorContext: editorContext,
          capturedTerminalWindow: undefined,
          liveTerminalWindow: undefined,
        }),
      ).toBe(false);
    }
  });
});

describe('resolveWindowProjectAuthority', () => {
  test('prefers the editor-owned local project', () => {
    expect(
      resolveWindowProjectAuthority({
        editorProjectPath: '/Users/me/editor-project',
        editorRemote: undefined,
        terminalWindow: { projectRoot: '/Users/me/terminal-project', remote: REMOTE },
      }),
    ).toEqual({ projectPath: '/Users/me/editor-project', remote: false });
  });

  test('classifies a standalone remote terminal without treating its opaque key as local', () => {
    expect(
      resolveWindowProjectAuthority({
        editorProjectPath: undefined,
        editorRemote: undefined,
        terminalWindow: { projectRoot: 'ssh:machine-1:%2Fsrv%2Fproject', remote: REMOTE },
      }),
    ).toEqual({ projectPath: 'ssh:machine-1:%2Fsrv%2Fproject', remote: true });
  });

  test('returns local authority for a project-bound standalone terminal', () => {
    expect(
      resolveWindowProjectAuthority({
        editorProjectPath: undefined,
        editorRemote: undefined,
        terminalWindow: { projectRoot: '/Users/me/project' },
      }),
    ).toEqual({ projectPath: '/Users/me/project', remote: false });
  });

  test('returns null for project-less and unregistered windows', () => {
    expect(
      resolveWindowProjectAuthority({
        editorProjectPath: undefined,
        editorRemote: undefined,
        terminalWindow: { projectRoot: null },
      }),
    ).toBeNull();
    expect(
      resolveWindowProjectAuthority({
        editorProjectPath: undefined,
        editorRemote: undefined,
        terminalWindow: undefined,
      }),
    ).toBeNull();
  });
});

describe('hasLocalProjectAuthority', () => {
  test('requires exact sender-owned path equality', () => {
    const authority = { projectPath: '/Users/me/project', remote: false } as const;
    expect(hasLocalProjectAuthority(authority, '/Users/me/project')).toBe(true);
    expect(hasLocalProjectAuthority(authority, '/Users/me/other')).toBe(false);
  });

  test('refuses remote, project-less, and malformed requests', () => {
    expect(
      hasLocalProjectAuthority(
        { projectPath: 'ssh:machine-1:%2Fsrv%2Fproject', remote: true },
        'ssh:machine-1:%2Fsrv%2Fproject',
      ),
    ).toBe(false);
    expect(hasLocalProjectAuthority(null, '/Users/me/project')).toBe(false);
    expect(
      hasLocalProjectAuthority({ projectPath: '/Users/me/project', remote: false }, undefined),
    ).toBe(false);
  });
});
