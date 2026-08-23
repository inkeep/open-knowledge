import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  addRecentFile,
  addRecentProject,
  annotateMissing,
  emptyState,
  getProjectSessionState,
  getTerminalDockState,
  type PersistedWindowBounds,
  parseAppState,
  removeRecentProject,
  restoreSurvivorPath,
  type SaveAppStateFs,
  saveAppStateToDir,
  setLastUsedProjectParent,
  setNoteWindowBounds,
  setProjectSessionState,
  setProjectWindowBounds,
  setSpellCheckEnabled,
  setTerminalDockState,
  windowRestoreKey,
} from '../../src/main/state-store.ts';

function persistedWorkspace(
  openTabs: string[],
  pinnedTabIds: string[],
  activeTabId: string | null,
) {
  return {
    panes: [
      {
        id: 'pane-main',
        openTabs,
        pinnedTabIds,
        activeTabId,
        size: 100,
      },
    ],
    focusedPaneId: 'pane-main',
  };
}

function projectSession(
  openTabs: string[],
  pinnedTabIds: string[],
  activeTabId: string | null,
  updatedAt: string | null = null,
) {
  return {
    updatedAt,
    ...persistedWorkspace(openTabs, pinnedTabIds, activeTabId),
  };
}

describe('state-store (recent projects + LRU)', () => {
  test('addRecentProject prepends to empty list', () => {
    const next = addRecentProject(emptyState(), '/tmp/p1', 'p1');
    expect(next.recentProjects.length).toBe(1);
    expect(next.recentProjects[0]?.path).toBe('/tmp/p1');
    expect(next.recentProjects[0]?.name).toBe('p1');
    expect(next.lastOpenedProject).toBe('/tmp/p1');
  });

  test('addRecentProject moves existing entry to front', () => {
    let s = addRecentProject(emptyState(), '/tmp/a', 'a');
    s = addRecentProject(s, '/tmp/b', 'b');
    s = addRecentProject(s, '/tmp/a', 'a'); // re-open a
    expect(s.recentProjects.map((p) => p.path)).toEqual(['/tmp/a', '/tmp/b']);
    expect(s.lastOpenedProject).toBe('/tmp/a');
  });

  test('LRU caps at 20 entries', () => {
    let s = emptyState();
    for (let i = 0; i < 25; i++) {
      s = addRecentProject(s, `/tmp/p${i}`, `p${i}`);
    }
    expect(s.recentProjects.length).toBe(20);
    // Newest first — p24 should be at the front
    expect(s.recentProjects[0]?.path).toBe('/tmp/p24');
    // Oldest 5 dropped
    expect(s.recentProjects.find((p) => p.path === '/tmp/p0')).toBeUndefined();
  });

  test('removeRecentProject drops the entry', () => {
    let s = addRecentProject(emptyState(), '/tmp/a', 'a');
    s = addRecentProject(s, '/tmp/b', 'b');
    const next = removeRecentProject(s, '/tmp/a');
    expect(next.recentProjects.map((p) => p.path)).toEqual(['/tmp/b']);
    // /tmp/b was the most-recent open, so removing /tmp/a leaves /tmp/b intact
    expect(next.lastOpenedProject).toBe('/tmp/b');
  });

  test('removeRecentProject clears lastOpenedProject when it matches', () => {
    let s = addRecentProject(emptyState(), '/tmp/a', 'a');
    s = addRecentProject(s, '/tmp/b', 'b');
    s = addRecentProject(s, '/tmp/a', 'a'); // /tmp/a is now last-opened
    const next = removeRecentProject(s, '/tmp/a');
    expect(next.recentProjects.map((p) => p.path)).toEqual(['/tmp/b']);
    expect(next.lastOpenedProject).toBe(null);
  });

  test('project session state persists by project path', () => {
    const session = projectSession(
      ['README', 'docs/guide'],
      ['README'],
      'docs/guide',
      '2026-05-06T00:00:00Z',
    );
    const state = setProjectSessionState(emptyState(), '/tmp/a', session);
    expect(getProjectSessionState(state, '/tmp/a')).toEqual(session);
    expect(getProjectSessionState(state, '/tmp/b')).toEqual(projectSession([], [], null));
  });

  test('project session state preserves active folder tabs', () => {
    const folderTabId = '\u0000folder:docs';
    const session = projectSession(
      ['README', folderTabId],
      [folderTabId],
      folderTabId,
      '2026-05-06T00:00:00Z',
    );
    const state = setProjectSessionState(emptyState(), '/tmp/a', session);
    expect(getProjectSessionState(state, '/tmp/a')).toEqual(session);
  });

  test('removeRecentProject drops matching session state', () => {
    const withSession = setProjectSessionState(
      emptyState(),
      '/tmp/a',
      projectSession(['README'], ['README'], 'README', '2026-05-06T00:00:00Z'),
    );
    const next = removeRecentProject(withSession, '/tmp/a');
    expect(getProjectSessionState(next, '/tmp/a')).toEqual(projectSession([], [], null));
  });

  test('annotateMissing flips missing for non-existent paths', () => {
    let s = addRecentProject(emptyState(), '/tmp/exists', 'exists');
    s = addRecentProject(s, '/tmp/missing', 'missing');
    const annotated = annotateMissing(s, (p) => p === '/tmp/exists');
    expect(annotated.find((p) => p.path === '/tmp/exists')?.missing).toBe(false);
    expect(annotated.find((p) => p.path === '/tmp/missing')?.missing).toBe(true);
  });

  test('parseAppState ignores flat legacy project sessions', () => {
    const raw = {
      recentProjects: [{ path: '/tmp/a', name: 'a', lastOpenedAt: '2026-04-20T00:00:00Z' }],
      lastOpenedProject: '/tmp/a',
      projectSessions: {
        '/tmp/a': {
          openTabs: ['README', 'README', '', 'docs/guide'],
          pinnedTabIds: ['README', 'missing', 'README'],
          activeDocName: 'docs/guide',
          activeTabId: 'docs/guide',
          updatedAt: '2026-05-06T00:00:00Z',
        },
      },
    };
    const parsed = parseAppState(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.recentProjects.length).toBe(1);
    expect(parsed?.lastOpenedProject).toBe('/tmp/a');
    expect(parsed?.projectSessions['/tmp/a']).toEqual(projectSession([], [], null));
  });

  test('parseAppState drops legacy occurrence ids without transforming them', () => {
    const parsed = parseAppState({
      recentProjects: [],
      projectSessions: {
        '/tmp/a': {
          panes: [
            {
              id: 'pane-a',
              openTabs: ['docs/a', 'docs/a\u0000doc-tab:1', 'docs/b'],
              pinnedTabIds: ['docs/a'],
              activeTabId: 'docs/a',
              size: 1,
            },
            {
              id: 'pane-b',
              openTabs: ['docs/d', 'docs/c\u0000doc-tab:1'],
              pinnedTabIds: ['docs/d', 'docs/c\u0000doc-tab:1'],
              activeTabId: 'docs/c\u0000doc-tab:1',
              size: 1,
            },
          ],
          focusedPaneId: 'pane-b',
          updatedAt: '2026-05-06T00:00:00Z',
        },
      },
    });

    expect(parsed?.projectSessions['/tmp/a']).toEqual({
      updatedAt: '2026-05-06T00:00:00Z',
      panes: [
        {
          id: 'pane-a',
          openTabs: ['docs/a', 'docs/b'],
          pinnedTabIds: ['docs/a'],
          activeTabId: 'docs/a',
          size: 50,
        },
        {
          id: 'pane-b',
          openTabs: ['docs/d'],
          pinnedTabIds: ['docs/d'],
          activeTabId: 'docs/d',
          size: 50,
        },
      ],
      focusedPaneId: 'pane-b',
    });
  });

  test('parseAppState filters malformed entries silently', () => {
    const raw = {
      recentProjects: [
        { path: '/tmp/good', name: 'good', lastOpenedAt: '2026-04-20T00:00:00Z' },
        { path: 123, name: 'bad', lastOpenedAt: 'now' }, // path not string
        { name: 'no-path', lastOpenedAt: 'now' }, // missing path
        'not-an-object',
      ],
      lastOpenedProject: '/tmp/good',
    };
    const parsed = parseAppState(raw);
    expect(parsed?.recentProjects.length).toBe(1);
    expect(parsed?.recentProjects[0]?.path).toBe('/tmp/good');
  });

  test('parseAppState returns null for non-object input', () => {
    expect(parseAppState('not state')).toBeNull();
    expect(parseAppState(null)).toBeNull();
    expect(parseAppState(42)).toBeNull();
  });
});

describe('state-store (terminal full-restart state)', () => {
  test('defaults legacy state to a hidden dock with no tabs', () => {
    const parsed = parseAppState({ recentProjects: [] });
    expect(parsed?.terminalDockStates).toEqual({});
    expect(getTerminalDockState(parsed ?? emptyState(), '/tmp/project')).toEqual({
      terminalVisible: false,
      terminalSnapshot: { tabs: [], activeOrdinal: null },
    });
  });

  test('round-trips project-scoped visibility, tab order, and active tab', () => {
    const state = setTerminalDockState(emptyState(), '/tmp/project', {
      terminalVisible: true,
      terminalSnapshot: {
        tabs: [
          { ordinal: 2, customLabel: 'Build' },
          { ordinal: 1, customLabel: null },
        ],
        activeOrdinal: 1,
      },
    });
    const parsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(getTerminalDockState(parsed ?? emptyState(), '/tmp/project')).toEqual(
      state.terminalDockStates['/tmp/project'],
    );
  });

  test('drops legacy layout fields while coercing tab metadata at the persistence boundary', () => {
    const parsed = parseAppState({
      recentProjects: [],
      terminalDockStates: {
        '/tmp/project': {
          terminalVisible: 'yes',
          placement: 'sideways',
          rightWidth: 100,
          terminalSnapshot: {
            tabs: [
              { ordinal: 2, customLabel: 'Build' },
              { ordinal: 2, customLabel: 'duplicate' },
              { ordinal: -1, customLabel: null },
            ],
            activeOrdinal: 99,
          },
        },
      },
    });
    expect(getTerminalDockState(parsed ?? emptyState(), '/tmp/project')).toEqual({
      terminalVisible: false,
      terminalSnapshot: {
        tabs: [{ ordinal: 2, customLabel: 'Build' }],
        activeOrdinal: null,
      },
    });
  });

  test('removing a recent project also removes its terminal state', () => {
    let state = addRecentProject(emptyState(), '/tmp/project', 'project');
    state = setTerminalDockState(state, '/tmp/project', {
      terminalVisible: true,
      terminalSnapshot: { tabs: [{ ordinal: 1, customLabel: null }], activeOrdinal: 1 },
    });
    expect(removeRecentProject(state, '/tmp/project').terminalDockStates).toEqual({});
  });
});

describe('state-store (gitRemoteUrl field on RecentProject)', () => {
  test('addRecentProject persists the optional gitRemoteUrl when provided', () => {
    const next = addRecentProject(
      emptyState(),
      '/tmp/p1',
      'p1',
      'https://github.com/inkeep/open-knowledge.git',
    );
    expect(next.recentProjects[0]?.gitRemoteUrl).toBe(
      'https://github.com/inkeep/open-knowledge.git',
    );
  });

  test('addRecentProject without gitRemoteUrl leaves the field undefined', () => {
    const next = addRecentProject(emptyState(), '/tmp/p1', 'p1');
    expect(next.recentProjects[0]).not.toHaveProperty('gitRemoteUrl');
  });

  test('addRecentProject preserves a previously persisted gitRemoteUrl on re-open without a fresh value', () => {
    // First open: backfill captures the canonical URL.
    let s = addRecentProject(
      emptyState(),
      '/tmp/p1',
      'p1',
      'https://github.com/inkeep/open-knowledge.git',
    );
    // Re-open without the 4th arg (e.g. a transient `.git/config` read miss
    // — a network share briefly unmounted, an antivirus lock).
    s = addRecentProject(s, '/tmp/p1', 'p1');
    expect(s.recentProjects[0]?.gitRemoteUrl).toBe('https://github.com/inkeep/open-knowledge.git');
  });

  test('addRecentProject updates gitRemoteUrl when a fresh value is supplied', () => {
    let s = addRecentProject(emptyState(), '/tmp/p1', 'p1', 'https://github.com/old/owner.git');
    s = addRecentProject(s, '/tmp/p1', 'p1', 'https://github.com/new/owner.git');
    expect(s.recentProjects[0]?.gitRemoteUrl).toBe('https://github.com/new/owner.git');
  });

  test('parseAppState loads a recents entry that omits gitRemoteUrl (legacy/upgrade path)', () => {
    const raw = {
      recentProjects: [
        // Legacy entry: written before the field existed.
        { path: '/tmp/legacy', name: 'legacy', lastOpenedAt: '2026-04-20T00:00:00Z' },
      ],
      lastOpenedProject: '/tmp/legacy',
    };
    const parsed = parseAppState(raw);
    expect(parsed?.recentProjects.length).toBe(1);
    expect(parsed?.recentProjects[0]?.gitRemoteUrl).toBeUndefined();
  });

  test('parseAppState round-trips a recents entry with gitRemoteUrl', () => {
    const state = addRecentProject(
      emptyState(),
      '/tmp/p1',
      'p1',
      'https://github.com/inkeep/open-knowledge.git',
    );
    const reparsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(reparsed?.recentProjects[0]?.gitRemoteUrl).toBe(
      'https://github.com/inkeep/open-knowledge.git',
    );
  });

  test('parseAppState drops a non-string gitRemoteUrl (defensive coercion)', () => {
    const raw = {
      recentProjects: [
        {
          path: '/tmp/p1',
          name: 'p1',
          lastOpenedAt: '2026-04-20T00:00:00Z',
          gitRemoteUrl: 42,
        },
      ],
      lastOpenedProject: '/tmp/p1',
    };
    const parsed = parseAppState(raw);
    expect(parsed?.recentProjects[0]?.gitRemoteUrl).toBeUndefined();
  });

  test('parseAppState drops an empty-string gitRemoteUrl', () => {
    const raw = {
      recentProjects: [
        {
          path: '/tmp/p1',
          name: 'p1',
          lastOpenedAt: '2026-04-20T00:00:00Z',
          gitRemoteUrl: '',
        },
      ],
      lastOpenedProject: '/tmp/p1',
    };
    const parsed = parseAppState(raw);
    expect(parsed?.recentProjects[0]?.gitRemoteUrl).toBeUndefined();
  });

  test('schemaVersion stays at 1 after introducing the additive field', () => {
    expect(emptyState().schemaVersion).toBe(1);
  });
});

describe('saveAppStateToDir (atomic write via tmp + rename)', () => {
  test('writes tmp first, then renames to canonical — real fs round-trip', () => {
    // Real tmpdir + real fs. Verifies the full write+rename path ends with
    // a well-formed state.json whose content matches the input state.
    const userDataDir = mkdtempSync(join(tmpdir(), 'ok-state-atomic-'));
    try {
      const state = addRecentProject(emptyState(), '/tmp/example', 'example');
      saveAppStateToDir(userDataDir, state);
      const statePath = join(userDataDir, 'state.json');
      expect(existsSync(statePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(parsed.recentProjects[0].path).toBe('/tmp/example');
      expect(parsed.lastOpenedProject).toBe('/tmp/example');
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('fs call order is write-tmp → rename-tmp-to-canonical (atomicity invariant)', () => {
    // Mocked fs — asserts the sequence is tmp-write BEFORE canonical-rename,
    // never the other way around. A future refactor that accidentally flips
    // these (or drops the tmp indirection) would silently regress the
    // crash-safety property.
    const calls: Array<{ op: string; path: string }> = [];
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(() => undefined),
      writeFileSync: vi.fn((p: string) => {
        calls.push({ op: 'write', path: p });
      }) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn((from: string, to: string) => {
        calls.push({ op: 'rename', path: `${from}->${to}` });
      }) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: vi.fn(() => undefined) as unknown as SaveAppStateFs['unlinkSync'],
    };
    saveAppStateToDir('/fake/userdata', emptyState(), fs, {
      error: () => {},
    });
    expect(calls.length).toBe(2);
    expect(calls[0]?.op).toBe('write');
    expect(calls[0]?.path).toContain('state.json.tmp-');
    expect(calls[1]?.op).toBe('rename');
    expect(calls[1]?.path).toMatch(/state\.json\.tmp-.*->.*state\.json$/);
  });

  test('renameSync failure → cleanup attempt + error log (does NOT throw)', () => {
    const errorLog = vi.fn(() => {});
    const unlinkSpy = vi.fn(() => {});
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(() => undefined),
      writeFileSync: vi.fn(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn(() => {
        throw new Error('EACCES: permission denied');
      }) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: unlinkSpy as unknown as SaveAppStateFs['unlinkSync'],
    };
    expect(() =>
      saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: errorLog }),
    ).not.toThrow();
    expect(errorLog).toHaveBeenCalled();
    // Best-effort cleanup — tmp file unlink attempted.
    expect(unlinkSpy).toHaveBeenCalled();
  });

  test('mkdirSync failure → outer catch logs "userData setup failed"', () => {
    const errorMessages: string[] = [];
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(() => {
        throw new Error('EROFS: read-only fs');
      }),
      writeFileSync: vi.fn(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: vi.fn(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    saveAppStateToDir('/fake/userdata', emptyState(), fs, {
      error: (msg: string) => {
        errorMessages.push(msg);
      },
    });
    expect(errorMessages.some((m) => m.includes('userData setup failed'))).toBe(true);
  });

  test('creates userDataDir when absent', () => {
    const mkdirSpy = vi.fn(() => undefined);
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => false),
      mkdirSync: mkdirSpy,
      writeFileSync: vi.fn(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: vi.fn(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: () => {} });
    expect(mkdirSpy).toHaveBeenCalledWith('/fake/userdata', { recursive: true });
  });

  // return boolean so writeState callers can
  // detect disk-failure and roll back in-memory state.
  test('returns true on successful persist', () => {
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(() => undefined),
      writeFileSync: vi.fn(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: vi.fn(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    const result = saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: () => {} });
    expect(result).toBe(true);
  });

  test('returns false when renameSync throws', () => {
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(() => undefined),
      writeFileSync: vi.fn(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn(() => {
        throw new Error('EACCES');
      }) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: vi.fn(() => undefined) as unknown as SaveAppStateFs['unlinkSync'],
    };
    const result = saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: () => {} });
    expect(result).toBe(false);
  });

  test('lastUsedProjectParent: defaults to null on a fresh state', () => {
    expect(emptyState().lastUsedProjectParent).toBeNull();
  });

  test('lastUsedProjectParent: setter immutably updates state', () => {
    const next = setLastUsedProjectParent(emptyState(), '/Users/alice/Notes');
    expect(next.lastUsedProjectParent).toBe('/Users/alice/Notes');
    // Other fields untouched.
    expect(next.recentProjects).toEqual([]);
    expect(next.schemaVersion).toBe(1);
  });

  test('lastUsedProjectParent: parseAppState round-trips a valid string', () => {
    const payload = { ...emptyState(), lastUsedProjectParent: '/Users/alice/Notes' };
    const parsed = parseAppState(JSON.parse(JSON.stringify(payload)));
    expect(parsed?.lastUsedProjectParent).toBe('/Users/alice/Notes');
  });

  test('lastUsedProjectParent: parseAppState coerces non-string to null', () => {
    const corrupted = { ...emptyState(), lastUsedProjectParent: 42 };
    const parsed = parseAppState(JSON.parse(JSON.stringify(corrupted)));
    expect(parsed?.lastUsedProjectParent).toBeNull();
  });

  test('lastUsedProjectParent: parseAppState coerces empty string to null', () => {
    const payload = { ...emptyState(), lastUsedProjectParent: '' };
    const parsed = parseAppState(JSON.parse(JSON.stringify(payload)));
    expect(parsed?.lastUsedProjectParent).toBeNull();
  });

  test('returns false when userData mkdir throws', () => {
    const fs: SaveAppStateFs = {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(() => {
        throw new Error('EROFS');
      }),
      writeFileSync: vi.fn(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: vi.fn(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: vi.fn(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    const result = saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: () => {} });
    expect(result).toBe(false);
  });
});

describe('state-store (pendingWindowRestore — post-update window restore)', () => {
  test('emptyState seeds pendingWindowRestore as null (no relaunch pending)', () => {
    expect(emptyState().pendingWindowRestore).toBeNull();
  });

  test('parseAppState defaults a legacy state.json without the key to null', () => {
    const parsed = parseAppState({ recentProjects: [], lastOpenedProject: null });
    expect(parsed?.pendingWindowRestore).toBeNull();
  });

  test('parseAppState coerces a LEGACY string[] snapshot to project entries', () => {
    // Back-compat: a state.json written before the kinded union stored bare
    // project paths. Each coerces to a `{ kind: 'project' }` entry — no schema
    // bump needed.
    const parsed = parseAppState({
      recentProjects: [],
      pendingWindowRestore: ['/tmp/a', '/tmp/b'],
    });
    expect(parsed?.pendingWindowRestore).toEqual([
      { kind: 'project', projectPath: '/tmp/a' },
      { kind: 'project', projectPath: '/tmp/b' },
    ]);
  });

  test('parseAppState round-trips a kinded snapshot (project + loose file)', () => {
    const state = {
      recentProjects: [],
      pendingWindowRestore: [
        { kind: 'project', projectPath: '/tmp/a' },
        { kind: 'file', filePath: '/notes/todo.md' },
      ],
    };
    const parsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(parsed?.pendingWindowRestore).toEqual([
      { kind: 'project', projectPath: '/tmp/a' },
      { kind: 'file', filePath: '/notes/todo.md' },
    ]);
  });

  test('parseAppState preserves an empty snapshot as [] — distinct from null', () => {
    // [] means "the app quit with nothing open"; the boot path opens the
    // Navigator rather than falling back to lastOpenedProject.
    const parsed = parseAppState({ recentProjects: [], pendingWindowRestore: [] });
    expect(parsed?.pendingWindowRestore).toEqual([]);
  });

  test('parseAppState dedupes and drops invalid entries (mixed legacy + kinded)', () => {
    const parsed = parseAppState({
      recentProjects: [],
      pendingWindowRestore: [
        '/tmp/a', // legacy project string
        { kind: 'project', projectPath: '/tmp/a' }, // dup of the above → dropped
        '', // empty → dropped
        123, // non-string/object → dropped
        { kind: 'file', filePath: '/notes/x.md' },
        { kind: 'file' }, // missing filePath → dropped
        { kind: 'bogus', projectPath: '/tmp/z' }, // unknown kind → dropped
        { kind: 'file', filePath: '/notes/x.md' }, // dup file → dropped
        { kind: 'project', projectPath: '/tmp/b' },
        null,
      ],
    });
    expect(parsed?.pendingWindowRestore).toEqual([
      { kind: 'project', projectPath: '/tmp/a' },
      { kind: 'file', filePath: '/notes/x.md' },
      { kind: 'project', projectPath: '/tmp/b' },
    ]);
  });

  test('parseAppState coerces a non-array pendingWindowRestore to null', () => {
    expect(
      parseAppState({ recentProjects: [], pendingWindowRestore: 'nope' })?.pendingWindowRestore,
    ).toBeNull();
    expect(
      parseAppState({ recentProjects: [], pendingWindowRestore: null })?.pendingWindowRestore,
    ).toBeNull();
  });
});

describe('state-store (recentFiles — durable loose-file LRU)', () => {
  test('emptyState seeds recentFiles as an empty list', () => {
    expect(emptyState().recentFiles).toEqual([]);
  });

  test('addRecentFile prepends and does NOT touch lastOpenedProject', () => {
    const withProject = addRecentProject(emptyState(), '/tmp/proj', 'proj');
    const next = addRecentFile(withProject, '/notes/todo.md', 'todo.md');
    expect(next.recentFiles.length).toBe(1);
    expect(next.recentFiles[0]?.path).toBe('/notes/todo.md');
    expect(next.recentFiles[0]?.name).toBe('todo.md');
    // A loose file must never become the single-project restore fallback.
    expect(next.lastOpenedProject).toBe('/tmp/proj');
  });

  test('addRecentFile moves an existing entry to the front', () => {
    let s = addRecentFile(emptyState(), '/notes/a.md', 'a.md');
    s = addRecentFile(s, '/notes/b.md', 'b.md');
    s = addRecentFile(s, '/notes/a.md', 'a.md'); // re-open a
    expect(s.recentFiles.map((f) => f.path)).toEqual(['/notes/a.md', '/notes/b.md']);
  });

  test('addRecentFile caps the list at 20 (LRU eviction)', () => {
    let s = emptyState();
    for (let i = 0; i < 25; i++) {
      s = addRecentFile(s, `/notes/f${i}.md`, `f${i}.md`);
    }
    expect(s.recentFiles.length).toBe(20);
    expect(s.recentFiles[0]?.path).toBe('/notes/f24.md');
    expect(s.recentFiles.find((f) => f.path === '/notes/f0.md')).toBeUndefined();
  });

  test('parseAppState round-trips recentFiles and drops invalid entries', () => {
    const parsed = parseAppState({
      recentProjects: [],
      recentFiles: [
        { path: '/notes/a.md', name: 'a.md', lastOpenedAt: '2026-07-20T00:00:00Z' },
        { path: '', name: 'empty', lastOpenedAt: '2026-07-20T00:00:00Z' }, // empty path → dropped
        { path: '/notes/a.md', name: 'dup', lastOpenedAt: '2026-07-21T00:00:00Z' }, // dup → dropped
        { path: '/notes/b.md', name: 'b.md' }, // missing lastOpenedAt → dropped
        'nonsense', // non-object → dropped
      ],
    });
    expect(parsed?.recentFiles).toEqual([
      { path: '/notes/a.md', name: 'a.md', lastOpenedAt: '2026-07-20T00:00:00Z' },
    ]);
  });

  test('parseAppState defaults a legacy state.json without recentFiles to []', () => {
    const parsed = parseAppState({ recentProjects: [], lastOpenedProject: null });
    expect(parsed?.recentFiles).toEqual([]);
  });
});

describe('state-store (spellCheckEnabled — app-wide spell-check toggle)', () => {
  test('defaults to true on a fresh state', () => {
    expect(emptyState().spellCheckEnabled).toBe(true);
  });

  test('setSpellCheckEnabled immutably updates the flag', () => {
    const original = emptyState();
    const disabled = setSpellCheckEnabled(original, false);
    expect(disabled.spellCheckEnabled).toBe(false);
    // Other fields untouched.
    expect(disabled.recentProjects).toEqual([]);
    expect(disabled.schemaVersion).toBe(1);
    // Original not mutated by the immutable update.
    expect(original.spellCheckEnabled).toBe(true);
  });

  test('setSpellCheckEnabled can re-enable a disabled flag', () => {
    const reenabled = setSpellCheckEnabled(setSpellCheckEnabled(emptyState(), false), true);
    expect(reenabled.spellCheckEnabled).toBe(true);
  });

  test('parseAppState coerces a missing spellCheckEnabled to true (legacy state.json)', () => {
    const parsed = parseAppState({ recentProjects: [], lastOpenedProject: null });
    expect(parsed?.spellCheckEnabled).toBe(true);
  });

  test('parseAppState coerces a non-boolean spellCheckEnabled to true', () => {
    const parsed = parseAppState({ recentProjects: [], spellCheckEnabled: 'nope' });
    expect(parsed?.spellCheckEnabled).toBe(true);
  });

  test('parseAppState preserves an explicit false across a round-trip', () => {
    const state = setSpellCheckEnabled(emptyState(), false);
    const reparsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(reparsed?.spellCheckEnabled).toBe(false);
  });

  test('parseAppState preserves an explicit true across a round-trip', () => {
    const state = setSpellCheckEnabled(emptyState(), true);
    const reparsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(reparsed?.spellCheckEnabled).toBe(true);
  });
});

describe('state-store (projectWindowBounds — per-project window frame memory)', () => {
  const BOUNDS: PersistedWindowBounds = {
    x: 320,
    y: 152,
    width: 1280,
    height: 800,
    isMaximized: false,
    isFullScreen: false,
  };

  test('emptyState seeds an empty map', () => {
    expect(emptyState().projectWindowBounds).toEqual({});
  });

  test('setProjectWindowBounds immutably records a frame', () => {
    const original = emptyState();
    const next = setProjectWindowBounds(original, '/tmp/a', BOUNDS);
    expect(next.projectWindowBounds['/tmp/a']).toEqual(BOUNDS);
    expect(original.projectWindowBounds).toEqual({});
  });

  test('setProjectWindowBounds overwrites a prior frame for the same key', () => {
    let s = setProjectWindowBounds(emptyState(), '/tmp/a', BOUNDS);
    s = setProjectWindowBounds(s, '/tmp/a', { ...BOUNDS, x: 640, isMaximized: true });
    expect(s.projectWindowBounds['/tmp/a']).toEqual({ ...BOUNDS, x: 640, isMaximized: true });
  });

  test('round-trips through parseAppState', () => {
    const state = setProjectWindowBounds(emptyState(), '/tmp/a', {
      ...BOUNDS,
      isFullScreen: true,
    });
    const reparsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(reparsed?.projectWindowBounds['/tmp/a']).toEqual({ ...BOUNDS, isFullScreen: true });
  });

  test('parseAppState defaults a legacy state.json without the key to {}', () => {
    const parsed = parseAppState({ recentProjects: [], lastOpenedProject: null });
    expect(parsed?.projectWindowBounds).toEqual({});
  });

  test('parseAppState drops corrupt entries and keeps valid siblings', () => {
    const parsed = parseAppState({
      recentProjects: [],
      projectWindowBounds: {
        '/tmp/valid': BOUNDS,
        '/tmp/non-numeric': { ...BOUNDS, x: 'left' },
        '/tmp/non-finite': { ...BOUNDS, y: Number.NaN },
        '/tmp/zero-size': { ...BOUNDS, width: 0 },
        '/tmp/not-an-object': 42,
        '': BOUNDS,
      },
    });
    expect(Object.keys(parsed?.projectWindowBounds ?? {})).toEqual(['/tmp/valid']);
  });

  test('parseAppState rounds fractional coordinates and coerces flags to booleans', () => {
    const parsed = parseAppState({
      recentProjects: [],
      projectWindowBounds: {
        '/tmp/a': { x: 1.5, y: -2.4, width: 1280.9, height: 800.2, isMaximized: 'yes' },
      },
    });
    expect(parsed?.projectWindowBounds['/tmp/a']).toEqual({
      x: 2,
      y: -2,
      width: 1281,
      height: 800,
      isMaximized: false,
      isFullScreen: false,
    });
  });

  test('parseAppState coerces a non-object projectWindowBounds to {}', () => {
    expect(
      parseAppState({ recentProjects: [], projectWindowBounds: ['/tmp/a'] })?.projectWindowBounds,
    ).toEqual({});
    expect(
      parseAppState({ recentProjects: [], projectWindowBounds: 'nope' })?.projectWindowBounds,
    ).toEqual({});
  });

  test('removeRecentProject drops the window-bounds entry alongside the session', () => {
    let s = addRecentProject(emptyState(), '/tmp/a', 'a');
    s = setProjectWindowBounds(s, '/tmp/a', BOUNDS);
    s = setProjectWindowBounds(s, '/tmp/b', BOUNDS);
    const next = removeRecentProject(s, '/tmp/a');
    expect(next.projectWindowBounds['/tmp/a']).toBeUndefined();
    expect(next.projectWindowBounds['/tmp/b']).toEqual(BOUNDS);
  });
});

describe('state-store (noteWindowBounds — per-project pop-out frame memory)', () => {
  const FRAME: PersistedWindowBounds = {
    x: 2400,
    y: 120,
    width: 900,
    height: 1000,
    isMaximized: false,
    isFullScreen: false,
  };

  test('emptyState seeds an empty map', () => {
    expect(emptyState().noteWindowBounds).toEqual({});
  });

  test('setNoteWindowBounds immutably records a frame', () => {
    const original = emptyState();
    const next = setNoteWindowBounds(original, '/tmp/a', FRAME);

    expect(next.noteWindowBounds['/tmp/a']).toEqual(FRAME);
    expect(original.noteWindowBounds).toEqual({});
  });

  test('the pop-out slot is independent of the project window frame', () => {
    // Same key, different fields: a user who parks pop-outs on a second monitor
    // must not have that overwrite where the project window itself opens.
    let s = setProjectWindowBounds(emptyState(), '/tmp/a', {
      ...FRAME,
      x: 0,
      y: 0,
    });
    s = setNoteWindowBounds(s, '/tmp/a', FRAME);

    expect(s.projectWindowBounds['/tmp/a']?.x).toBe(0);
    expect(s.noteWindowBounds['/tmp/a']?.x).toBe(2400);
  });

  test('round-trips through parseAppState', () => {
    const s = setNoteWindowBounds(emptyState(), '/tmp/a', FRAME);
    const reparsed = parseAppState(JSON.parse(JSON.stringify(s)));

    expect(reparsed?.noteWindowBounds['/tmp/a']).toEqual(FRAME);
  });

  test('state written before the field existed parses to an empty map', () => {
    // The additive contract: an older build's state has no such key, and this
    // build must read it without a schema bump.
    const legacy = { ...emptyState() } as Record<string, unknown>;
    delete legacy.noteWindowBounds;

    expect(parseAppState(legacy)?.noteWindowBounds).toEqual({});
  });

  test('a corrupt value coerces to an empty map rather than throwing', () => {
    const parsed = parseAppState({ ...emptyState(), noteWindowBounds: 'nonsense' });
    expect(parsed?.noteWindowBounds).toEqual({});
  });

  test('a corrupt entry is dropped while healthy siblings survive', () => {
    const parsed = parseAppState({
      ...emptyState(),
      noteWindowBounds: { '/tmp/a': FRAME, '/tmp/broken': { x: 'no' } },
    });

    expect(parsed?.noteWindowBounds['/tmp/a']).toEqual(FRAME);
    expect(parsed?.noteWindowBounds['/tmp/broken']).toBeUndefined();
  });

  test('removeRecentProject clears the pop-out slot with everything else', () => {
    // One key deletes all of a project's persisted state; a leaked pop-out
    // frame would resurrect a forgotten project's window position.
    let s = setNoteWindowBounds(emptyState(), '/tmp/a', FRAME);
    s = setProjectWindowBounds(s, '/tmp/a', FRAME);
    s = removeRecentProject(s, '/tmp/a');

    expect(s.noteWindowBounds['/tmp/a']).toBeUndefined();
    expect(s.projectWindowBounds['/tmp/a']).toBeUndefined();
  });

  test('the schema version is unchanged — the field is additive', () => {
    expect(setNoteWindowBounds(emptyState(), '/tmp/a', FRAME).schemaVersion).toBe(
      emptyState().schemaVersion,
    );
  });
});

describe('state-store (doc restore entries — popped-out note windows)', () => {
  const FRAME: PersistedWindowBounds = {
    x: 2400,
    y: 120,
    width: 900,
    height: 1000,
    isMaximized: false,
    isFullScreen: false,
  };
  const DOC = {
    kind: 'doc' as const,
    projectPath: '/tmp/a',
    docName: 'notes/alpha',
    bounds: FRAME,
  };

  test('a doc key does not collide with its own project window key', () => {
    // Both windows restore, so one key cannot stand for both — a collision
    // would silently drop the pop-out at the dedup step.
    expect(windowRestoreKey(DOC)).not.toBe(
      windowRestoreKey({ kind: 'project', projectPath: '/tmp/a' }),
    );
  });

  test('two pop-outs of one project get distinct keys', () => {
    expect(windowRestoreKey(DOC)).not.toBe(windowRestoreKey({ ...DOC, docName: 'notes/beta' }));
  });

  test('the survivor path for a pop-out is its project folder, not its key', () => {
    // The key is a composite identity and would never stat. The right survivor
    // question is whether the PROJECT still exists.
    expect(restoreSurvivorPath(DOC)).toBe('/tmp/a');
    expect(restoreSurvivorPath({ kind: 'project', projectPath: '/tmp/a' })).toBe('/tmp/a');
    expect(restoreSurvivorPath({ kind: 'file', filePath: '/tmp/loose.md' })).toBe('/tmp/loose.md');
  });

  test('round-trips a doc entry with its frame', () => {
    const s = { ...emptyState(), pendingWindowRestore: [DOC] };
    const reparsed = parseAppState(JSON.parse(JSON.stringify(s)));

    expect(reparsed?.pendingWindowRestore).toEqual([DOC]);
  });

  test('a doc entry with a corrupt frame keeps the document and drops the frame', () => {
    // The document is the point of the window; the pixels are a nicety.
    const parsed = parseAppState({
      ...emptyState(),
      pendingWindowRestore: [{ ...DOC, bounds: { x: 'nope' } }],
    });

    expect(parsed?.pendingWindowRestore).toEqual([
      { kind: 'doc', projectPath: '/tmp/a', docName: 'notes/alpha' },
    ]);
  });

  test('a doc entry missing its document name is dropped', () => {
    const parsed = parseAppState({
      ...emptyState(),
      pendingWindowRestore: [{ kind: 'doc', projectPath: '/tmp/a' }],
    });

    expect(parsed?.pendingWindowRestore).toEqual([]);
  });

  test('an unknown kind is dropped while known kinds survive', () => {
    // This is the forward-compatibility contract that let the union grow
    // without a schema bump: an older build treats `doc` exactly this way.
    const parsed = parseAppState({
      ...emptyState(),
      pendingWindowRestore: [
        { kind: 'project', projectPath: '/tmp/a' },
        { kind: 'newer-kind', whatever: true },
        DOC,
      ],
    });

    expect(parsed?.pendingWindowRestore).toEqual([{ kind: 'project', projectPath: '/tmp/a' }, DOC]);
  });

  test('two pop-outs of one project both survive the de-dupe', () => {
    const parsed = parseAppState({
      ...emptyState(),
      pendingWindowRestore: [DOC, { ...DOC, docName: 'notes/beta' }],
    });

    expect(parsed?.pendingWindowRestore).toHaveLength(2);
  });
});
