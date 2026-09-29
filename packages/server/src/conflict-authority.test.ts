import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindConflictAuthority,
  ConflictAuthority,
  type ConflictChange,
  type ConflictIo,
  isDocInConflict,
} from './conflict-authority.ts';
import type { Conflict } from './conflict-kinds.ts';
import { strategiesFor } from './conflict-kinds.ts';
import { _resetDocExtensionsForTests, registerDocExtension } from './doc-extensions.ts';
import { getLogger } from './logger.ts';

let tmpDir = '';
let projectDir = '';
let storePath = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'conflict-authority-test-'));
  projectDir = join(tmpDir, 'project');
  storePath = join(projectDir, '.ok', LOCAL_DIR, 'conflicts.json');
  mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface FakeIo extends ConflictIo {
  gitCalls: string[][];
  writes: Array<{ absPath: string; bytes: string }>;
  unlinks: string[];
  declaredDeletes: string[];
  applied: Array<{ docName: string; bytes: string }>;
}

function makeIo(overrides: Partial<ConflictIo> = {}): FakeIo {
  const gitCalls: string[][] = [];
  const writes: Array<{ absPath: string; bytes: string }> = [];
  const unlinks: string[] = [];
  const declaredDeletes: string[] = [];
  const applied: Array<{ docName: string; bytes: string }> = [];
  return {
    gitCalls,
    writes,
    unlinks,
    declaredDeletes,
    applied,
    gitRaw: async (args) => {
      gitCalls.push(args);
      return '';
    },
    writeProjectFileUntracked: (absPath, bytes) => {
      writes.push({ absPath, bytes });
      writeFileSync(absPath, bytes, 'utf-8');
    },
    unlinkProjectFileUndeclared: (absPath) => {
      unlinks.push(absPath);
      rmSync(absPath, { force: true });
    },
    deleteResolvedContent: (_docName, absPath) => {
      declaredDeletes.push(absPath);
      unlinks.push(absPath);
      rmSync(absPath, { force: true });
    },
    applyResolvedContent: async (docName, absPath, bytes) => {
      applied.push({ docName, bytes });
      writeFileSync(absPath, bytes, 'utf-8');
    },
    ...overrides,
  };
}

interface Rig {
  authority: ConflictAuthority;
  io: FakeIo;
  signals: number;
  changes: ConflictChange[];
}

function makeAuthority(io: FakeIo = makeIo()): Rig {
  const rig = { io, signals: 0, changes: [] as ConflictChange[] } as Rig;
  rig.authority = new ConflictAuthority({
    projectDir,
    contentDir: projectDir,
    branch: 'main',
    signal: {
      signal: () => {
        rig.signals++;
      },
    },
    io,
  });
  rig.authority.subscribe((change) => rig.changes.push(change));
  return rig;
}

function readLedger(): { version: number; branch: string; conflicts: Conflict[] } {
  return JSON.parse(readFileSync(storePath, 'utf-8'));
}

function quarantinedLedgers(): string[] {
  return readdirSync(join(projectDir, '.ok', LOCAL_DIR)).filter((name) =>
    name.includes('conflicts.json.corrupt-'),
  );
}

describe('ConflictAuthority membership and persistence', () => {
  test('starts empty when no conflicts.json exists', () => {
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
    expect(authority.list()).toEqual([]);
  });

  test('raise persists the entry with its kind and indexes it by file and docName', () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: 'README.md' });

    expect(authority.count()).toBe(1);
    expect(authority.findByFile('README.md')?.kind).toBe('merge-native');
    expect(authority.findByDocName('README')?.file).toBe('README.md');
    expect(authority.has('README')).toBe(true);

    const persisted = readLedger();
    expect(persisted.version).toBe(2);
    expect(persisted.branch).toBe('main');
    expect(persisted.conflicts).toHaveLength(1);
    expect(persisted.conflicts[0].kind).toBe('merge-native');
  });

  test('raise accumulates distinct files and upserts a changed payload for one file', () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    authority.raise({ kind: 'merge-native', file: 'b.md' });
    authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'sha2' });

    expect(authority.count()).toBe(2);
    expect(authority.findByFile('a.md')?.kind).toBe('working-tree');
  });

  test('a repeated identical raise is a no-op and does not signal', () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    const signalsAfterFirst = rig.signals;

    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    expect(rig.signals).toBe(signalsAfterFirst);
    expect(rig.changes).toHaveLength(1);
  });

  test('every mutation signals sync-status exactly once', () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    expect(rig.signals).toBe(1);
    rig.authority.raise({ kind: 'merge-native', file: 'b.md' });
    expect(rig.signals).toBe(2);
    rig.authority.dissolveWorkingTree('a.md');
    expect(rig.signals).toBe(2);
    rig.authority.raise({
      kind: 'reconcile',
      file: 'c.md',
      reason: 'disk-markers',
      stages: { base: 'b', ours: 'o', theirs: 't' },
    });
    expect(rig.signals).toBe(3);
    rig.authority.dissolveReconcile('c');
    expect(rig.signals).toBe(4);
  });

  test('subscribers see raised and cleared changes carrying the docName', () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'docs/note.md',
      reason: 'merged-with-markers',
      stages: { base: 'b', ours: 'o', theirs: 't' },
    });
    rig.authority.dissolveReconcile('docs/note');

    expect(rig.changes).toHaveLength(2);
    expect(rig.changes[0]).toMatchObject({ type: 'raised', docName: 'docs/note' });
    expect(rig.changes[1]).toMatchObject({
      type: 'cleared',
      docName: 'docs/note',
      cause: 'dissolved',
    });
  });

  test('raise on a system doc is refused', () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: '__system__.md',
      reason: 'disk-markers',
      stages: { base: '', ours: '', theirs: '' },
    });

    expect(rig.authority.count()).toBe(0);
    expect(rig.authority.list()).toEqual([]);
    expect(rig.signals).toBe(0);
    expect(rig.changes).toEqual([]);
  });

  test('a git kind replaces a reconcile entry but a reconcile raise never replaces a git kind', () => {
    const { authority } = makeAuthority();
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'b', ours: 'o', theirs: 't' },
    });
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    expect(authority.findByFile('a.md')?.kind).toBe('merge-native');

    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'b', ours: 'o', theirs: 't' },
    });
    expect(authority.findByFile('a.md')?.kind).toBe('merge-native');
  });

  test('setBranch lands on the next persisted write', () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    authority.setBranch('feat/new-branch');
    authority.raise({ kind: 'merge-native', file: 'b.md' });
    expect(readLedger().branch).toBe('feat/new-branch');
  });
});

describe('ConflictAuthority per-kind closers', () => {
  test('dissolveReconcile clears a reconcile entry and refuses another kind', () => {
    const { authority } = makeAuthority();
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'b', ours: 'o', theirs: 't' },
    });
    authority.dissolveReconcile('a');
    expect(authority.count()).toBe(0);

    authority.raise({ kind: 'merge-native', file: 'a.md' });
    authority.dissolveReconcile('a');
    expect(authority.count()).toBe(1);
    expect(authority.findByFile('a.md')?.kind).toBe('merge-native');
  });

  test('dissolveWorkingTree clears a working-tree entry and refuses another kind', () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'sha' });
    authority.dissolveWorkingTree('a.md');
    expect(authority.count()).toBe(0);

    authority.raise({ kind: 'merge-native', file: 'a.md' });
    authority.dissolveWorkingTree('a.md');
    expect(authority.count()).toBe(1);
    expect(authority.findByFile('a.md')?.kind).toBe('merge-native');
  });

  test('a closer on an absent file is a no-op and does not signal', () => {
    const rig = makeAuthority();
    rig.authority.dissolveReconcile('nope');
    rig.authority.dissolveWorkingTree('nope.md');

    expect(rig.authority.count()).toBe(0);
    expect(rig.signals).toBe(0);
    expect(rig.changes).toEqual([]);
  });
});

describe('ConflictAuthority pruneMergeNativeAgainstGit (PRD-8318 ordering)', () => {
  function unmergedIo(unmerged: string[]): FakeIo {
    return makeIo({
      gitRaw: async (args) => (args[0] === 'diff' ? unmerged.map((f) => `${f}\0`).join('') : ''),
    });
  }

  function seedMergeHead(): void {
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    writeFileSync(join(projectDir, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf-8');
  }

  test('with no MERGE_HEAD every merge-native entry is pruned', async () => {
    const rig = makeAuthority(unmergedIo([]));
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    rig.authority.raise({ kind: 'working-tree', file: 'b.md', theirsSha: 'sha' });

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(1);
    expect(rig.authority.findByFile('a.md')).toBeUndefined();
    expect(rig.authority.findByFile('b.md')).toBeDefined();
  });

  test('mid-merge only entries no longer unmerged are pruned', async () => {
    seedMergeHead();
    const rig = makeAuthority(unmergedIo(['b.md']));
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    rig.authority.raise({ kind: 'merge-native', file: 'b.md' });

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(1);
    expect(rig.authority.findByFile('a.md')).toBeUndefined();
    expect(rig.authority.findByFile('b.md')).toBeDefined();
  });

  test('a prune that removes nothing does not signal', async () => {
    seedMergeHead();
    const rig = makeAuthority(unmergedIo(['a.md']));
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    const before = rig.signals;

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(0);
    expect(rig.signals).toBe(before);
  });

  test('prune before dissolve and dissolve before prune converge on the same empty state', async () => {
    seedMergeHead();

    function seedBoth(): ReturnType<typeof makeAuthority> {
      const rig = makeAuthority(unmergedIo([]));
      rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
      rig.authority.raise({
        kind: 'reconcile',
        file: 'b.md',
        reason: 'disk-markers',
        stages: { base: 'base', ours: 'ours', theirs: 'theirs' },
      });
      return rig;
    }

    const pruneFirst = seedBoth();
    expect(await pruneFirst.authority.pruneMergeNativeAgainstGit()).toBe(1);
    pruneFirst.authority.dissolveReconcile('b');

    const dissolveFirst = seedBoth();
    dissolveFirst.authority.dissolveReconcile('b');
    expect(await dissolveFirst.authority.pruneMergeNativeAgainstGit()).toBe(1);

    expect(pruneFirst.authority.count()).toBe(0);
    expect(dissolveFirst.authority.count()).toBe(0);
  });

  test('a malformed .git pointer leaves the ledger untouched', async () => {
    const rig = makeAuthority(unmergedIo([]));
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    writeFileSync(join(projectDir, '.git'), 'this is not a gitdir pointer\n', 'utf-8');

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(0);
    expect(rig.authority.findByFile('a.md')).toBeDefined();
  });

  test.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'an unreadable .git leaves the ledger untouched',
    async () => {
      const rig = makeAuthority(unmergedIo([]));
      rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
      mkdirSync(join(projectDir, '.git'), { recursive: true });
      chmodSync(projectDir, 0o000);
      try {
        expect(() => statSync(join(projectDir, '.git'))).toThrow();
        expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(0);
      } finally {
        chmodSync(projectDir, 0o755);
      }
      expect(rig.authority.findByFile('a.md')).toBeDefined();
    },
  );

  test('an absent .git still prunes every merge-native entry', async () => {
    const rig = makeAuthority(unmergedIo([]));
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(1);
    expect(rig.authority.findByFile('a.md')).toBeUndefined();
  });

  test('a replacement raised while Git pruning awaits survives the old probe', async () => {
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'MERGE_HEAD'), 'merge-head\n');
    const rig = makeAuthority(
      makeIo({
        gitRaw: async () => {
          rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'replacement' });
          return '';
        },
      }),
    );
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(0);
    expect(rig.authority.findByFile('a.md')).toMatchObject({
      kind: 'working-tree',
      theirsSha: 'replacement',
    });
    expect(rig.changes.some((change) => change.type === 'cleared')).toBe(false);
  });

  test('a failing git probe leaves the ledger untouched', async () => {
    seedMergeHead();
    const rig = makeAuthority(
      makeIo({
        gitRaw: async () => {
          throw new Error('git exploded');
        },
      }),
    );
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

    expect(await rig.authority.pruneMergeNativeAgainstGit()).toBe(0);
    expect(rig.authority.findByFile('a.md')).toBeDefined();
  });
});

describe('ConflictAuthority ledger migration', () => {
  function writeLedger(conflicts: unknown[], version = 1): void {
    writeFileSync(storePath, JSON.stringify({ version, branch: 'main', conflicts }), 'utf-8');
  }

  test('a legacy entry with no kind loads as merge-native', () => {
    writeLedger([{ file: 'a.md', detectedAt: '2026-05-19T00:00:00.000Z' }]);
    const { authority } = makeAuthority();
    expect(authority.findByFile('a.md')?.kind).toBe('merge-native');
  });

  test.each([1, 2])(
    'a version %i entry with an unrecognized kind is logged and dropped',
    (version) => {
      const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
      try {
        writeLedger([{ file: 'a.md', detectedAt: 'x', kind: 'future-kind' }], version);
        const { authority } = makeAuthority();
        expect(authority.count()).toBe(0);
        expect(warn).toHaveBeenCalledWith(
          { file: 'a.md', kind: 'future-kind' },
          '[conflicts] dropped a ledger entry with an unrecognized conflict kind',
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  test('a non-string kind is logged with a bounded type marker', () => {
    const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
    try {
      writeLedger([{ file: 'a.md', detectedAt: 'x', kind: { nested: true } }]);
      const { authority } = makeAuthority();
      expect(authority.count()).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        { file: 'a.md', kind: '<object>' },
        '[conflicts] dropped a ledger entry with an unrecognized conflict kind',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('an oversized string kind is truncated in the log', () => {
    const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
    try {
      writeLedger([{ file: 'a.md', detectedAt: 'x', kind: 'x'.repeat(100) }]);
      const { authority } = makeAuthority();
      expect(authority.count()).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        { file: 'a.md', kind: 'x'.repeat(80) },
        '[conflicts] dropped a ledger entry with an unrecognized conflict kind',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('a legacy working-tree variant with a pinned blob loads as working-tree', () => {
    writeLedger([
      {
        file: 'a.md',
        detectedAt: '2026-05-19T00:00:00.000Z',
        variant: 'working-tree',
        theirsSha: 'sha',
        baseSha: 'base',
      },
    ]);
    const { authority } = makeAuthority();
    const entry = authority.findByFile('a.md');
    expect(entry).toMatchObject({ kind: 'working-tree', theirsSha: 'sha', baseSha: 'base' });
  });

  test('a working-tree entry with no pinned blob is dropped', () => {
    writeLedger([{ file: 'a.md', detectedAt: 'x', variant: 'working-tree' }]);
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
  });

  test('a reconcile entry with no stages is dropped', () => {
    writeLedger([{ file: 'a.md', detectedAt: 'x', kind: 'reconcile', reason: 'disk-markers' }]);
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
  });

  test('a reconcile entry whose stages is null is dropped instead of throwing at boot', () => {
    writeLedger([
      { file: 'a.md', detectedAt: 'x', kind: 'reconcile', reason: 'disk-markers', stages: null },
      { file: 'b.md', detectedAt: 'x' },
    ]);
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(1);
    expect(authority.findByFile('b.md')?.kind).toBe('merge-native');
  });

  test('a reconcile entry missing the ours or theirs stage is dropped, never coerced', () => {
    writeLedger([
      {
        file: 'a.md',
        detectedAt: 'x',
        kind: 'reconcile',
        reason: 'merged-with-markers',
        stages: { base: 'B' },
      },
      {
        file: 'b.md',
        detectedAt: 'x',
        kind: 'reconcile',
        reason: 'merged-with-markers',
        stages: { base: 'B', ours: 'O' },
      },
    ]);
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
  });

  test('a reconcile entry with stages survives restart intact', () => {
    writeLedger([
      {
        file: 'a.md',
        detectedAt: 'x',
        kind: 'reconcile',
        reason: 'merged-with-markers',
        stages: { base: 'B', ours: 'O', theirs: 'T' },
      },
    ]);
    const { authority } = makeAuthority();
    expect(authority.findByFile('a.md')).toMatchObject({
      kind: 'reconcile',
      reason: 'merged-with-markers',
      stages: { base: 'B', ours: 'O', theirs: 'T' },
    });
  });

  test('corrupt JSON starts empty and the unreadable file is moved aside', () => {
    writeFileSync(storePath, 'NOT JSON', 'utf-8');
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
    expect(existsSync(storePath)).toBe(false);
    expect(quarantinedLedgers()).toHaveLength(1);
  });

  test.each(['null', '[]', '"ledger"', '42', 'true'])(
    'a non-object ledger %s is quarantined and startup recovers',
    (payload) => {
      writeFileSync(storePath, payload, 'utf-8');
      const { authority } = makeAuthority();
      expect(authority.count()).toBe(0);
      expect(existsSync(storePath)).toBe(false);
      const quarantined = quarantinedLedgers();
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(dirname(storePath), quarantined[0] ?? ''), 'utf-8')).toBe(payload);
      authority.raise({ kind: 'merge-native', file: 'recovered.md' });
      expect(makeAuthority().authority.findByFile('recovered.md')?.kind).toBe('merge-native');
    },
  );

  test('migrated entries are written back carrying their kind', () => {
    writeLedger([{ file: 'a.md', detectedAt: '2026-05-19T00:00:00.000Z' }]);
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: 'b.md' });
    expect(readLedger().conflicts.every((c) => typeof c.kind === 'string')).toBe(true);
  });
});

describe('ConflictAuthority ledger durability', () => {
  function writeRawLedger(payload: unknown): void {
    writeFileSync(storePath, JSON.stringify(payload), 'utf-8');
  }

  test('a version 1 ledger still loads', () => {
    writeRawLedger({
      version: 1,
      branch: 'main',
      conflicts: [{ file: 'a.md', detectedAt: 'x', kind: 'merge-native' }],
    });
    const { authority } = makeAuthority();
    expect(authority.findByFile('a.md')?.kind).toBe('merge-native');
  });

  test('an unknown ledger version is moved aside instead of migrated', () => {
    writeRawLedger({
      version: 99,
      branch: 'main',
      conflicts: [{ file: 'a.md', detectedAt: 'x', kind: 'merge-native' }],
    });
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
    expect(existsSync(storePath)).toBe(false);
    expect(quarantinedLedgers()).toHaveLength(1);
  });

  test('a ledger with no version at all is moved aside', () => {
    writeRawLedger({ branch: 'main', conflicts: [] });
    const { authority } = makeAuthority();
    expect(authority.count()).toBe(0);
    expect(quarantinedLedgers()).toHaveLength(1);
  });

  test('a successful persist writes version 2 and leaves no temp file behind', () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    expect(readLedger().version).toBe(2);
    expect(existsSync(`${storePath}.tmp`)).toBe(false);
  });

  test('a persist that cannot land is logged rather than swallowed, and membership survives', () => {
    const error = vi.spyOn(getLogger('conflict-authority'), 'error');
    try {
      const rig = makeAuthority();
      mkdirSync(`${storePath}.tmp`, { recursive: true });

      rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toBe(
        '[conflicts] failed to persist conflicts.json — the ledger will not survive restart',
      );
      expect(rig.authority.findByFile('a.md')).toBeDefined();
      expect(rig.authority.has('a')).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe('ConflictAuthority docName and path mapping', () => {
  afterEach(() => {
    _resetDocExtensionsForTests();
  });

  test('a mermaid docName keeps its own extension in both directions', () => {
    const rig = makeAuthority();
    expect(rig.authority.fileOf('diagram.mermaid')).toBe('diagram.mermaid');

    rig.authority.raise({ kind: 'merge-native', file: 'diagram.mermaid' });
    expect(rig.authority.has('diagram.mermaid')).toBe(true);
  });

  test('a non-markdown text docName keeps its own extension in both directions', () => {
    const rig = makeAuthority();
    expect(rig.authority.fileOf('notes.txt')).toBe('notes.txt');

    rig.authority.raise({ kind: 'merge-native', file: 'notes.txt' });
    expect(rig.authority.has('notes.txt')).toBe(true);
  });

  test('a markdown docName still gains its registered extension', () => {
    registerDocExtension('page', '.mdx');
    const rig = makeAuthority();
    expect(rig.authority.fileOf('page')).toBe('page.mdx');

    rig.authority.raise({ kind: 'merge-native', file: 'page.mdx' });
    expect(rig.authority.has('page')).toBe(true);
  });
});

describe('isDocInConflict binding', () => {
  function namedDoc(name: string): Y.Doc {
    return Object.assign(new Y.Doc(), { name });
  }

  test('an unbound document reads as clear and says so in the log', () => {
    const error = vi.spyOn(getLogger('conflict-authority'), 'error');
    try {
      const doc = namedDoc('a');
      expect(isDocInConflict(doc as never)).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toMatchObject({ 'doc.name': 'a' });
    } finally {
      error.mockRestore();
    }
  });

  test('a bound document tracks the authority membership', () => {
    const rig = makeAuthority();
    const doc = namedDoc('a');
    bindConflictAuthority(doc, rig.authority);

    expect(isDocInConflict(doc as never)).toBe(false);

    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    expect(isDocInConflict(doc as never)).toBe(true);
  });
});

describe('strategiesFor', () => {
  test('git kinds accept every strategy', () => {
    expect(strategiesFor('merge-native')).toEqual(['mine', 'theirs', 'content', 'delete']);
    expect(strategiesFor('working-tree')).toEqual(['mine', 'theirs', 'content', 'delete']);
  });

  test('a reconcile conflict whose theirs side carries markers does not advertise theirs', () => {
    expect(strategiesFor('reconcile', 'disk-markers')).toEqual(['mine', 'content', 'delete']);
    expect(strategiesFor('reconcile', 'refused-conflict-markers')).toEqual([
      'mine',
      'content',
      'delete',
    ]);
  });

  test('a reconcile conflict with clean theirs bytes advertises theirs', () => {
    expect(strategiesFor('reconcile', 'merged-with-markers')).toContain('theirs');
    expect(strategiesFor('reconcile', 'refused-too-large')).toContain('theirs');
  });

  test('a document the merger declined as too large is not offered a hand-merged content resolve', () => {
    expect(strategiesFor('reconcile', 'refused-too-large')).toEqual(['mine', 'theirs', 'delete']);
  });

  test('a document refused for having no base is offered every strategy', () => {
    expect(strategiesFor('reconcile', 'refused-no-base')).toEqual([
      'mine',
      'theirs',
      'content',
      'delete',
    ]);
  });
});

describe('ConflictAuthority lifecycleOf', () => {
  test('returns the map arms for deleted-upstream and renamed', () => {
    const { authority } = makeAuthority();
    const doc = new Y.Doc();
    doc.getMap('lifecycle').set('status', 'deleted-upstream');
    expect(authority.lifecycleOf(doc, 'a')).toEqual({ status: 'deleted-upstream' });

    const renamed = new Y.Doc();
    renamed.getMap('lifecycle').set('status', 'renamed');
    renamed.getMap('lifecycle').set('newPath', 'b');
    expect(authority.lifecycleOf(renamed, 'a')).toEqual({ status: 'renamed', newPath: 'b' });
  });

  test('returns the conflict arm from membership, carrying kind and reason', () => {
    const { authority } = makeAuthority();
    const doc = new Y.Doc();
    expect(authority.lifecycleOf(doc, 'a')).toBeNull();

    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'b', ours: 'o', theirs: 't' },
    });
    expect(authority.lifecycleOf(doc, 'a')).toEqual({
      status: 'conflict',
      kind: 'reconcile',
      reason: 'disk-markers',
    });
  });

  test('returns the working-tree conflict lifecycle for a pull-only collision', () => {
    const { authority } = makeAuthority();
    const doc = new Y.Doc();
    authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'origin-sha' });

    expect(authority.lifecycleOf(doc, 'a')).toEqual({
      status: 'conflict',
      kind: 'working-tree',
      reason: 'pull-only-collision',
    });
  });

  test('the lifecycle map is never written by the authority', () => {
    const { authority } = makeAuthority();
    const doc = new Y.Doc();
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    authority.lifecycleOf(doc, 'a');
    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });
});

describe('ConflictAuthority resolve', () => {
  test('throws when the file is not tracked', async () => {
    const { authority } = makeAuthority();
    await expect(authority.resolve('unknown.md', 'mine')).rejects.toThrow(
      'no conflict tracked for file: unknown.md',
    );
  });

  test("strategy 'content' refuses bytes that still carry conflict markers", async () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    const markered = [
      '# Pricing',
      '',
      '<<<<<<< ours',
      'The Team tier moves to $29 per seat.',
      '=======',
      'The Team tier moves to $29 per seat, grandfathered.',
      '>>>>>>> theirs',
      '',
    ].join('\n');

    await expect(authority.resolve('a.md', 'content', markered)).rejects.toMatchObject({
      name: 'ConflictMarkersInContentError',
      file: 'a.md',
    });
    expect(authority.count()).toBe(1);
  });

  test("strategy 'content' accepts a resolution whose body contains a setext H1", async () => {
    const { authority, io } = makeAuthority() as Rig;
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    await authority.resolve(
      'a.md',
      'content',
      'Release Notes\n=======\n\nThe Team tier moves to $29.\n',
    );
    expect(authority.count()).toBe(0);
    expect(io.writes).toHaveLength(1);
  });

  test("strategy 'content' without content throws", async () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: 'a.md' });
    await expect(authority.resolve('a.md', 'content', undefined)).rejects.toThrow(
      "strategy 'content' requires content parameter",
    );
  });

  test("strategy 'content' rejects path traversal outside the project directory", async () => {
    const { authority } = makeAuthority();
    authority.raise({ kind: 'merge-native', file: '../../../etc/shadow.md' });
    await expect(
      authority.resolve('../../../etc/shadow.md', 'content', 'malicious'),
    ).rejects.toThrow('file path escapes project directory');

    authority.raise({ kind: 'merge-native', file: 'subdir/../../escape.md' });
    await expect(
      authority.resolve('subdir/../../escape.md', 'content', 'malicious'),
    ).rejects.toThrow('file path escapes project directory');
  });

  test('a merge-native resolve stages the choice, clears the entry and commits the merge', async () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    await rig.authority.resolve('a.md', 'mine');

    expect(rig.authority.count()).toBe(0);
    expect(rig.io.gitCalls).toEqual([
      ['checkout', '--ours', '--', ':(literal)a.md'],
      ['add', '--', ':(literal)a.md'],
      ['commit', '--no-edit'],
    ]);
  });

  test('a failed merge commit re-adds the unmerged files and throws', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        if (args[0] === 'diff') return 'a.md\0';
        return '';
      },
    });
    const rig = makeAuthority(io);
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

    await expect(rig.authority.resolve('a.md', 'mine')).rejects.toThrow('Merge commit failed');
    expect(rig.authority.findByFile('a.md')?.kind).toBe('merge-native');
  });

  test('a reconcile resolve writes the chosen bytes through the io and clears the entry', async () => {
    const rig = makeAuthority();
    writeFileSync(join(projectDir, 'a.md'), 'markers\n', 'utf-8');
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
    });

    await rig.authority.resolve('a.md', 'mine');
    expect(rig.io.applied).toEqual([{ docName: 'a', bytes: 'OURS\n' }]);
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('OURS\n');
    expect(rig.authority.count()).toBe(0);
    expect(rig.io.gitCalls).toEqual([]);
  });

  test("a reconcile 'delete' declares the unlink and clears the entry", async () => {
    const rig = makeAuthority();
    writeFileSync(join(projectDir, 'a.md'), 'markers\n', 'utf-8');
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'B', ours: 'O', theirs: 'T' },
    });

    await rig.authority.resolve('a.md', 'delete');
    expect(existsSync(join(projectDir, 'a.md'))).toBe(false);
    expect(rig.io.declaredDeletes).toEqual([join(projectDir, 'a.md')]);
    expect(rig.authority.count()).toBe(0);
  });

  test('a host failure leaves the entry in place so the gate stays up', async () => {
    const rig = makeAuthority(
      makeIo({
        applyResolvedContent: async () => {
          throw new Error('disk full');
        },
      }),
    );
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'B', ours: 'O', theirs: 'T' },
    });

    await expect(rig.authority.resolve('a.md', 'mine')).rejects.toThrow('disk full');
    expect(rig.authority.has('a')).toBe(true);
  });

  test('the resolved bytes reach disk BEFORE the entry leaves the ledger', async () => {
    const target = join(projectDir, 'a.md');
    writeFileSync(target, 'LOCAL\n', 'utf-8');
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'B', ours: 'O', theirs: 'T' },
    });

    let diskAtClear: string | null = null;
    rig.authority.subscribe((change) => {
      if (change.type === 'cleared') diskAtClear = readFileSync(target, 'utf-8');
    });

    await rig.authority.resolve('a.md', 'content', 'HAND-MERGED\n');
    expect(diskAtClear).toBe('HAND-MERGED\n');
    expect(rig.authority.count()).toBe(0);
  });
});

describe('ConflictAuthority working-tree resolve against a real repo', () => {
  async function seedOverlay(
    file: string,
    remote: string,
    local: string,
  ): Promise<{ blobSha: string; headSha: string }> {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, file), remote, 'utf-8');
    await git.add('.');
    await git.commit('seed');
    const blobSha = (await git.raw(['rev-parse', `HEAD:${file}`])).trim();
    const headSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
    writeFileSync(join(projectDir, file), local, 'utf-8');
    return { blobSha, headSha };
  }

  async function headSha(): Promise<string> {
    return (await simpleGit(projectDir).raw(['rev-parse', 'HEAD'])).trim();
  }

  function realGitIo(): FakeIo {
    return makeIo({ gitRaw: async (args) => simpleGit(projectDir).raw(args) });
  }

  test("'theirs' restores the pinned origin-tip blob without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const rig = makeAuthority(realGitIo());
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: blobSha });

    await rig.authority.resolve('a.md', 'theirs');
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('REMOTE\n');
    expect(rig.authority.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test("'mine' keeps the overlay verbatim without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const rig = makeAuthority(realGitIo());
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: blobSha });

    await rig.authority.resolve('a.md', 'mine');
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL\n');
    expect(rig.authority.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test("'content' writes the merged bytes without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const rig = makeAuthority(realGitIo());
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: blobSha });

    await rig.authority.resolve('a.md', 'content', 'HAND-MERGED\n');
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('HAND-MERGED\n');
    expect(rig.authority.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test("'delete' honors the local deletion without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const rig = makeAuthority(realGitIo());
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: blobSha });

    await rig.authority.resolve('a.md', 'delete');
    expect(existsSync(join(projectDir, 'a.md'))).toBe(false);
    expect(rig.authority.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test('the union type refuses a working-tree raise with no pinned blob', () => {
    const { authority } = makeAuthority();
    // @ts-expect-error a working-tree conflict without theirsSha is not constructible
    authority.raise({ kind: 'working-tree', file: 'a.md' });
  });
});

const MARKERED = [
  '# Pricing',
  '',
  '<<<<<<< ours',
  'The Team tier moves to $29 per seat.',
  '=======',
  'The Team tier moves to $29 per seat, grandfathered.',
  '>>>>>>> theirs',
  '',
].join('\n');

describe('ConflictAuthority resolve refuses markers on every strategy', () => {
  const REASONS = [
    'merged-with-markers',
    'refused-conflict-markers',
    'refused-too-large',
    'disk-markers',
  ] as const;

  for (const reason of REASONS) {
    test(`'mine' on a ${reason} entry whose ours carries markers is refused`, async () => {
      const rig = makeAuthority();
      rig.authority.raise({
        kind: 'reconcile',
        file: 'a.md',
        reason,
        stages: { base: 'B', ours: MARKERED, theirs: 'CLEAN\n' },
      });

      await expect(rig.authority.resolve('a.md', 'mine')).rejects.toMatchObject({
        name: 'ConflictMarkersInContentError',
      });
      expect(rig.io.applied).toEqual([]);
      expect(rig.authority.has('a')).toBe(true);
    });

    test(`'theirs' on a ${reason} entry whose theirs carries markers is refused`, async () => {
      const rig = makeAuthority();
      rig.authority.raise({
        kind: 'reconcile',
        file: 'a.md',
        reason,
        stages: { base: 'B', ours: 'CLEAN\n', theirs: MARKERED },
      });

      await expect(rig.authority.resolve('a.md', 'theirs')).rejects.toMatchObject({
        name: 'ConflictMarkersInContentError',
      });
      expect(rig.io.applied).toEqual([]);
      expect(rig.authority.has('a')).toBe(true);
    });
  }

  test('a strategy outside the advertised set for the entry is refused', async () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'B', ours: 'O', theirs: 'T' },
    });

    await expect(rig.authority.resolve('a.md', 'theirs')).rejects.toMatchObject({
      name: 'ConflictMarkersInContentError',
    });
    expect(strategiesFor('reconcile', 'disk-markers')).not.toContain('theirs');
    expect(rig.authority.has('a')).toBe(true);
  });

  test("'delete' is exempt from the marker check", async () => {
    const rig = makeAuthority();
    writeFileSync(join(projectDir, 'a.md'), MARKERED, 'utf-8');
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'B', ours: MARKERED, theirs: MARKERED },
    });

    await rig.authority.resolve('a.md', 'delete');
    expect(rig.authority.count()).toBe(0);
  });

  test("a working-tree 'theirs' whose pinned blob carries markers is refused before the write", async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'a.md'), MARKERED, 'utf-8');
    await git.add('.');
    await git.commit('seed');
    const blobSha = (await git.raw(['rev-parse', 'HEAD:a.md'])).trim();
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL\n', 'utf-8');

    const rig = makeAuthority(makeIo({ gitRaw: async (args) => simpleGit(projectDir).raw(args) }));
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: blobSha });

    await expect(rig.authority.resolve('a.md', 'theirs')).rejects.toMatchObject({
      name: 'ConflictMarkersInContentError',
    });
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL\n');
    expect(rig.authority.has('a')).toBe(true);
  });
});

describe('ConflictAuthority reconcile re-raise keeps the pre-conflict ours', () => {
  test('a second reconcile raise for the same file does not overwrite stages.ours', () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'B1', ours: 'PRE-CONFLICT\n', theirs: 'T1' },
    });
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'B2', ours: MARKERED, theirs: 'T2' },
    });

    const entry = rig.authority.findByFile('a.md');
    expect(entry?.kind).toBe('reconcile');
    if (entry?.kind !== 'reconcile') throw new Error('expected a reconcile entry');
    expect(entry.stages.ours).toBe('PRE-CONFLICT\n');
    expect(entry.stages.base).toBe('B2');
    expect(entry.stages.theirs).toBe('T2');
    expect(entry.reason).toBe('merged-with-markers');
  });

  test('a re-raise that differs only in ours is absorbed without a second change', () => {
    const rig = makeAuthority();
    const input = {
      kind: 'reconcile' as const,
      file: 'a.md',
      reason: 'merged-with-markers' as const,
      stages: { base: 'B', ours: 'PRE-CONFLICT\n', theirs: 'T' },
    };
    rig.authority.raise(input);
    const signalsAfterFirst = rig.signals;

    rig.authority.raise({ ...input, stages: { ...input.stages, ours: 'later editor text' } });

    expect(rig.changes).toHaveLength(1);
    expect(rig.signals).toBe(signalsAfterFirst);
    expect(rig.authority.findByFile('a.md')).toMatchObject({
      stages: { base: 'B', ours: 'PRE-CONFLICT\n', theirs: 'T' },
    });
  });

  test('a later clean reconcile dissolves the entry that held the pre-conflict ours', () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'B', ours: 'PRE-CONFLICT\n', theirs: MARKERED },
    });
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'B2', ours: 'LIVE-WITH-MARKERS\n', theirs: MARKERED },
    });

    const held = rig.authority.findByFile('a.md');
    if (held?.kind !== 'reconcile') throw new Error('expected a reconcile entry');
    expect(held.stages.ours).toBe('PRE-CONFLICT\n');

    rig.authority.dissolveReconcile('a');
    expect(rig.authority.has('a')).toBe(false);
    expect(rig.changes.at(-1)).toMatchObject({ type: 'cleared', file: 'a.md', cause: 'dissolved' });
  });
});

describe('ConflictAuthority merge-native resolve commits before it clears', () => {
  test('the merge commit runs before the cleared change reaches a subscriber', async () => {
    const order: string[] = [];
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') order.push('git-commit');
        return '';
      },
    });
    const rig = makeAuthority(io);
    rig.authority.subscribe((change) => {
      if (change.type === 'cleared') order.push('subscriber-cleared');
    });
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

    await rig.authority.resolve('a.md', 'mine');
    expect(order).toEqual(['git-commit', 'subscriber-cleared']);
  });

  test('a failed merge commit keeps the entry and raises the other unmerged files', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        if (args[0] === 'diff') return 'a.md\0b.md\0';
        return '';
      },
    });
    const rig = makeAuthority(io);
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });

    await expect(rig.authority.resolve('a.md', 'mine')).rejects.toThrow('Merge commit failed');
    expect(rig.authority.findByFile('a.md')?.kind).toBe('merge-native');
    expect(rig.authority.findByFile('b.md')?.kind).toBe('merge-native');
    expect(rig.changes.some((c) => c.type === 'cleared')).toBe(false);
  });

  test('a second merge-native entry defers the merge commit', async () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    rig.authority.raise({ kind: 'merge-native', file: 'b.md' });

    await rig.authority.resolve('a.md', 'mine');
    expect(rig.io.gitCalls.some((args) => args[0] === 'commit')).toBe(false);

    await rig.authority.resolve('b.md', 'mine');
    expect(rig.io.gitCalls.some((args) => args[0] === 'commit')).toBe(true);
  });
});

describe('ConflictAuthority docName index ownership', () => {
  test('clearing the non-owner leaves the docName index pointing at the owner', () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'sha-md' });
    rig.authority.raise({ kind: 'working-tree', file: 'a.mdx', theirsSha: 'sha-mdx' });
    expect(rig.authority.findByDocName('a')?.file).toBe('a.mdx');

    rig.authority.dissolveWorkingTree('a.md');
    expect(rig.authority.findByFile('a.md')).toBeUndefined();
    expect(rig.authority.findByDocName('a')?.file).toBe('a.mdx');
    expect(rig.authority.has('a')).toBe(true);
  });

  test('clearing the owner re-points the docName index at the surviving entry', () => {
    const rig = makeAuthority();
    rig.authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'sha-md' });
    rig.authority.raise({ kind: 'working-tree', file: 'a.mdx', theirsSha: 'sha-mdx' });

    rig.authority.dissolveWorkingTree('a.mdx');
    expect(rig.authority.findByDocName('a')?.file).toBe('a.md');
    expect(rig.authority.has('a')).toBe(true);
  });
});

const MARKERED_BODY = [
  '# Pricing',
  '',
  '<<<<<<< ours',
  'ours side',
  '=======',
  'theirs side',
  '>>>>>>> theirs',
  '',
].join('\n');

const STAGES = { base: 'B', ours: 'O', theirs: 'T' } as const;

function writeLedgerRows(branch: string, conflicts: unknown[]): void {
  writeFileSync(storePath, JSON.stringify({ version: 2, branch, conflicts }), 'utf-8');
}

function reconcileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'reconcile',
    file: 'a.md',
    detectedAt: '2026-05-19T00:00:00.000Z',
    reason: 'merged-with-markers',
    stages: { ...STAGES },
    ...overrides,
  };
}

describe('ConflictAuthority scopes reconcile entries to the branch that raised them', () => {
  test('raise stamps the current branch onto the persisted entry', () => {
    const { authority } = makeAuthority();
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { ...STAGES },
    });

    expect(authority.findByFile('a.md')).toMatchObject({ kind: 'reconcile', branch: 'main' });
    expect(readLedger().conflicts[0]).toMatchObject({ branch: 'main' });
  });

  test('an entry raised on another branch is dropped at load, git kinds are kept', () => {
    writeLedgerRows('feature/x', [
      reconcileRow({ branch: 'feature/x' }),
      { kind: 'merge-native', file: 'b.md', detectedAt: '2026-05-19T00:00:00.000Z' },
    ]);

    const { authority } = makeAuthority();
    expect(authority.findByFile('a.md')).toBeUndefined();
    expect(authority.findByFile('b.md')?.kind).toBe('merge-native');
  });

  test('an older entry carrying no branch is adopted onto the current branch', () => {
    writeLedgerRows('main', [reconcileRow()]);

    const { authority } = makeAuthority();
    expect(authority.findByFile('a.md')).toMatchObject({ kind: 'reconcile', branch: 'main' });
  });

  test('a branch change clears the reconcile entries raised on the branch we left', () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { ...STAGES },
    });
    rig.authority.raise({ kind: 'merge-native', file: 'b.md' });
    const signalsBefore = rig.signals;

    rig.authority.setBranch('feature/x');

    expect(rig.authority.findByFile('a.md')).toBeUndefined();
    expect(rig.authority.findByFile('b.md')?.kind).toBe('merge-native');
    expect(rig.signals).toBe(signalsBefore + 1);
    expect(rig.changes.at(-1)).toMatchObject({
      type: 'cleared',
      file: 'a.md',
      docName: 'a',
      cause: 'branch-changed',
    });
    expect(readLedger().branch).toBe('feature/x');
  });

  test('re-declaring the branch already in force clears nothing', () => {
    const rig = makeAuthority();
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { ...STAGES },
    });
    const signalsBefore = rig.signals;

    rig.authority.setBranch('main');

    expect(rig.authority.findByFile('a.md')).toBeDefined();
    expect(rig.signals).toBe(signalsBefore);
  });

  test('an entry raised after the switch survives the next load on that branch', () => {
    const rig = makeAuthority();
    rig.authority.setBranch('feature/x');
    rig.authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { ...STAGES },
    });

    const reloaded = new ConflictAuthority({
      projectDir,
      contentDir: projectDir,
      branch: 'feature/x',
      io: makeIo(),
    });
    expect(reloaded.findByFile('a.md')).toMatchObject({ branch: 'feature/x' });
  });

  test('omitting branch adopts the ledger branch, keeping its rows and stamping later raises', () => {
    writeLedgerRows('feature/y', [reconcileRow({ branch: 'feature/y' })]);

    const adopting = new ConflictAuthority({
      projectDir,
      contentDir: projectDir,
      io: makeIo(),
    });

    expect(adopting.findByFile('a.md')).toMatchObject({ kind: 'reconcile', branch: 'feature/y' });

    adopting.raise({
      kind: 'reconcile',
      file: 'c.md',
      reason: 'merged-with-markers',
      stages: { ...STAGES },
    });

    expect(adopting.findByFile('c.md')).toMatchObject({ branch: 'feature/y' });
    expect(readLedger().branch).toBe('feature/y');
  });
});

describe('ConflictAuthority validates marker-bearing reconcile entries against disk at load', () => {
  function writeMarkerLedger(reason: 'disk-markers' | 'refused-conflict-markers'): void {
    writeLedgerRows('main', [
      reconcileRow({
        branch: 'main',
        reason,
        stages: { base: 'B', ours: 'O', theirs: MARKERED_BODY },
      }),
    ]);
  }

  test('the entry survives while the file still carries markers', () => {
    writeFileSync(join(projectDir, 'a.md'), MARKERED_BODY, 'utf-8');
    writeMarkerLedger('disk-markers');

    expect(makeAuthority().authority.findByFile('a.md')?.kind).toBe('reconcile');
  });

  test('the entry is dropped once the markers were resolved out of band', () => {
    writeFileSync(join(projectDir, 'a.md'), '# Pricing\n\nsettled\n', 'utf-8');
    writeMarkerLedger('disk-markers');

    expect(makeAuthority().authority.count()).toBe(0);
  });

  test('a refused-conflict-markers entry is dropped when its file is gone', () => {
    writeMarkerLedger('refused-conflict-markers');

    expect(makeAuthority().authority.count()).toBe(0);
  });

  test('a reason that promises nothing about disk is loaded without reading the file', () => {
    writeFileSync(join(projectDir, 'a.md'), 'clean body\n', 'utf-8');
    writeLedgerRows('main', [reconcileRow({ branch: 'main', reason: 'merged-with-markers' })]);

    expect(makeAuthority().authority.findByFile('a.md')?.kind).toBe('reconcile');
  });

  test('an unreadable file keeps its entry rather than silently unfreezing the doc', () => {
    mkdirSync(join(projectDir, 'a.md'), { recursive: true });
    writeMarkerLedger('disk-markers');

    expect(makeAuthority().authority.findByFile('a.md')?.kind).toBe('reconcile');
  });
});

describe('ConflictAuthority reports the reconcile entry a git conflict displaces', () => {
  test('the git kind still wins, and the dropped editor text is announced', () => {
    const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
    try {
      const { authority } = makeAuthority();
      authority.raise({
        kind: 'reconcile',
        file: 'a.md',
        reason: 'disk-markers',
        stages: { base: 'B', ours: 'editor text', theirs: 'T' },
      });
      warn.mockClear();

      authority.raise({ kind: 'merge-native', file: 'a.md' });

      expect(authority.findByFile('a.md')?.kind).toBe('merge-native');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        file: 'a.md',
        reason: 'disk-markers',
        replacedBy: 'merge-native',
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('replacing one git kind with another says nothing', () => {
    const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
    try {
      const { authority } = makeAuthority();
      authority.raise({ kind: 'merge-native', file: 'a.md' });
      warn.mockClear();

      authority.raise({ kind: 'working-tree', file: 'a.md', theirsSha: 'sha' });
      expect(authority.findByFile('a.md')?.kind).toBe('working-tree');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ConflictAuthority tells a crashed unmerged probe from a clean index', () => {
  test('a crashed probe fabricates no entries and is logged as an error, not a clean index', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        if (args[0] === 'diff') throw new Error('fatal: not a git repository');
        return '';
      },
    });
    const rig = makeAuthority(io);
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    const error = vi.spyOn(getLogger('conflict-authority'), 'error');
    const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
    try {
      await expect(rig.authority.resolve('a.md', 'mine')).rejects.toThrow('Merge commit failed');

      expect(rig.authority.count()).toBe(1);
      expect(rig.authority.findByFile('a.md')?.kind).toBe('merge-native');
      expect(rig.changes.some((c) => c.type === 'cleared')).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toMatchObject({ file: 'a.md' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  test('a probe reporting a clean index stays a warning and raises nothing extra', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        return '';
      },
    });
    const rig = makeAuthority(io);
    rig.authority.raise({ kind: 'merge-native', file: 'a.md' });
    const error = vi.spyOn(getLogger('conflict-authority'), 'error');
    const warn = vi.spyOn(getLogger('conflict-authority'), 'warn');
    try {
      await expect(rig.authority.resolve('a.md', 'mine')).rejects.toThrow('Merge commit failed');

      expect(rig.authority.count()).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({ files: [] });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('ConflictAuthority ledger version 2 migration', () => {
  test.each([1, 2])('a version %i ledger persists as version 2 and survives restart', (version) => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version,
        branch: 'main',
        conflicts: [{ file: 'a.md', detectedAt: 'x', kind: 'merge-native' }],
      }),
    );

    expect(makeAuthority().authority.findByFile('a.md')?.kind).toBe('merge-native');
    expect(readLedger().version).toBe(2);
    expect(makeAuthority().authority.findByFile('a.md')?.kind).toBe('merge-native');
  });
});
