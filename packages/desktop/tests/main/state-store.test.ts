import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addRecentProject,
  annotateMissing,
  emptyState,
  getProjectSessionState,
  parseAppState,
  removeRecentProject,
  type SaveAppStateFs,
  saveAppStateToDir,
  setLastUsedProjectParent,
  setProjectSessionState,
  setSpellCheckEnabled,
} from '../../src/main/state-store.ts';

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
    const state = setProjectSessionState(emptyState(), '/tmp/a', {
      openTabs: ['README', 'docs/guide'],
      pinnedTabIds: ['README'],
      activeDocName: 'docs/guide',
      activeTabId: 'docs/guide',
      updatedAt: '2026-05-06T00:00:00Z',
    });
    expect(getProjectSessionState(state, '/tmp/a')).toEqual({
      openTabs: ['README', 'docs/guide'],
      pinnedTabIds: ['README'],
      activeDocName: 'docs/guide',
      activeTabId: 'docs/guide',
      updatedAt: '2026-05-06T00:00:00Z',
    });
    expect(getProjectSessionState(state, '/tmp/b')).toEqual({
      openTabs: [],
      pinnedTabIds: [],
      activeDocName: null,
      activeTabId: null,
      updatedAt: null,
    });
  });

  test('project session state preserves active folder tabs', () => {
    const folderTabId = '\u0000folder:docs';
    const state = setProjectSessionState(emptyState(), '/tmp/a', {
      openTabs: ['README', folderTabId],
      pinnedTabIds: [folderTabId],
      activeDocName: null,
      activeTabId: folderTabId,
      updatedAt: '2026-05-06T00:00:00Z',
    });
    expect(getProjectSessionState(state, '/tmp/a')).toEqual({
      openTabs: ['README', folderTabId],
      pinnedTabIds: [folderTabId],
      activeDocName: null,
      activeTabId: folderTabId,
      updatedAt: '2026-05-06T00:00:00Z',
    });
  });

  test('removeRecentProject drops matching session state', () => {
    const withSession = setProjectSessionState(emptyState(), '/tmp/a', {
      openTabs: ['README'],
      pinnedTabIds: ['README'],
      activeDocName: 'README',
      activeTabId: 'README',
      updatedAt: '2026-05-06T00:00:00Z',
    });
    const next = removeRecentProject(withSession, '/tmp/a');
    expect(getProjectSessionState(next, '/tmp/a')).toEqual({
      openTabs: [],
      pinnedTabIds: [],
      activeDocName: null,
      activeTabId: null,
      updatedAt: null,
    });
  });

  test('annotateMissing flips missing for non-existent paths', () => {
    let s = addRecentProject(emptyState(), '/tmp/exists', 'exists');
    s = addRecentProject(s, '/tmp/missing', 'missing');
    const annotated = annotateMissing(s, (p) => p === '/tmp/exists');
    expect(annotated.find((p) => p.path === '/tmp/exists')?.missing).toBe(false);
    expect(annotated.find((p) => p.path === '/tmp/missing')?.missing).toBe(true);
  });

  test('parseAppState accepts well-formed state', () => {
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
    expect(parsed?.projectSessions['/tmp/a']).toEqual({
      openTabs: ['README', 'docs/guide'],
      pinnedTabIds: ['README'],
      activeDocName: 'docs/guide',
      activeTabId: 'docs/guide',
      updatedAt: '2026-05-06T00:00:00Z',
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
      existsSync: mock(() => true),
      mkdirSync: mock(() => undefined),
      writeFileSync: mock((p: string) => {
        calls.push({ op: 'write', path: p });
      }) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock((from: string, to: string) => {
        calls.push({ op: 'rename', path: `${from}->${to}` });
      }) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: mock(() => undefined) as unknown as SaveAppStateFs['unlinkSync'],
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
    const errorLog = mock(() => {});
    const unlinkSpy = mock(() => {});
    const fs: SaveAppStateFs = {
      existsSync: mock(() => true),
      mkdirSync: mock(() => undefined),
      writeFileSync: mock(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock(() => {
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
      existsSync: mock(() => false),
      mkdirSync: mock(() => {
        throw new Error('EROFS: read-only fs');
      }),
      writeFileSync: mock(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: mock(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    saveAppStateToDir('/fake/userdata', emptyState(), fs, {
      error: (msg: string) => {
        errorMessages.push(msg);
      },
    });
    expect(errorMessages.some((m) => m.includes('userData setup failed'))).toBe(true);
  });

  test('creates userDataDir when absent', () => {
    const mkdirSpy = mock(() => undefined);
    const fs: SaveAppStateFs = {
      existsSync: mock(() => false),
      mkdirSync: mkdirSpy,
      writeFileSync: mock(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: mock(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: () => {} });
    expect(mkdirSpy).toHaveBeenCalledWith('/fake/userdata', { recursive: true });
  });

  // return boolean so writeState callers can
  // detect disk-failure and roll back in-memory state.
  test('returns true on successful persist', () => {
    const fs: SaveAppStateFs = {
      existsSync: mock(() => true),
      mkdirSync: mock(() => undefined),
      writeFileSync: mock(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: mock(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
    };
    const result = saveAppStateToDir('/fake/userdata', emptyState(), fs, { error: () => {} });
    expect(result).toBe(true);
  });

  test('returns false when renameSync throws', () => {
    const fs: SaveAppStateFs = {
      existsSync: mock(() => true),
      mkdirSync: mock(() => undefined),
      writeFileSync: mock(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock(() => {
        throw new Error('EACCES');
      }) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: mock(() => undefined) as unknown as SaveAppStateFs['unlinkSync'],
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
      existsSync: mock(() => false),
      mkdirSync: mock(() => {
        throw new Error('EROFS');
      }),
      writeFileSync: mock(() => {}) as unknown as SaveAppStateFs['writeFileSync'],
      renameSync: mock(() => {}) as unknown as SaveAppStateFs['renameSync'],
      unlinkSync: mock(() => {}) as unknown as SaveAppStateFs['unlinkSync'],
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

  test('parseAppState round-trips a non-empty restore snapshot', () => {
    const state = { ...emptyState(), pendingWindowRestore: ['/tmp/a', '/tmp/b'] };
    const parsed = parseAppState(JSON.parse(JSON.stringify(state)));
    expect(parsed?.pendingWindowRestore).toEqual(['/tmp/a', '/tmp/b']);
  });

  test('parseAppState preserves an empty snapshot as [] — distinct from null', () => {
    // [] means "a relaunch happened with no project windows open"; the boot
    // path opens the Navigator rather than falling back to lastOpenedProject.
    const parsed = parseAppState({ recentProjects: [], pendingWindowRestore: [] });
    expect(parsed?.pendingWindowRestore).toEqual([]);
  });

  test('parseAppState dedupes and drops non-string / empty entries', () => {
    const parsed = parseAppState({
      recentProjects: [],
      pendingWindowRestore: ['/tmp/a', '/tmp/a', '', 123, '/tmp/b', null],
    });
    expect(parsed?.pendingWindowRestore).toEqual(['/tmp/a', '/tmp/b']);
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
