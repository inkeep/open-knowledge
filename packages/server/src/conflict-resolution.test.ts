import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type Conflict, ConflictAuthority, type ConflictIo } from './conflict-authority.ts';
import {
  commitMergeIfEmpty,
  projectAbsPath,
  resolveMergeNative,
  resolveReconcile,
  resolveWorkingTree,
  selectReconcileOurs,
} from './conflict-resolution.ts';

let tmpDir = '';
let projectDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'conflict-resolution-test-'));
  projectDir = join(tmpDir, 'project');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RecordingIo extends ConflictIo {
  gitCalls: string[][];
  applied: Array<{ docName: string; bytes: string }>;
  unlinks: string[];
}

function makeIo(overrides: Partial<ConflictIo> = {}): RecordingIo {
  const gitCalls: string[][] = [];
  const applied: Array<{ docName: string; bytes: string }> = [];
  const unlinks: string[] = [];
  return {
    gitCalls,
    applied,
    unlinks,
    gitRaw: async (args) => {
      gitCalls.push(args);
      return '';
    },
    writeProjectFileUntracked: (absPath, bytes) => writeFileSync(absPath, bytes, 'utf-8'),
    unlinkProjectFile: (absPath) => {
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

const mergeNative = (file: string): Extract<Conflict, { kind: 'merge-native' }> => ({
  kind: 'merge-native',
  file,
  detectedAt: '2026-05-19T00:00:00.000Z',
});

const workingTree = (
  file: string,
  theirsSha: string,
): Extract<Conflict, { kind: 'working-tree' }> => ({
  kind: 'working-tree',
  file,
  detectedAt: '2026-05-19T00:00:00.000Z',
  theirsSha,
});

const reconcile = (
  file: string,
  reason: Extract<Conflict, { kind: 'reconcile' }>['reason'],
): Extract<Conflict, { kind: 'reconcile' }> => ({
  kind: 'reconcile',
  file,
  detectedAt: '2026-05-19T00:00:00.000Z',
  branch: 'main',
  reason,
  stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
});

describe('projectAbsPath', () => {
  test('resolves a project-relative path', () => {
    expect(projectAbsPath(projectDir, 'a.md')).toBe(join(realpathSync(projectDir), 'a.md'));
  });

  test('refuses parent traversal and absolute paths', () => {
    expect(() => projectAbsPath(projectDir, '../../etc/shadow.md')).toThrow(
      'file path escapes project directory',
    );
    expect(() => projectAbsPath(projectDir, '/etc/shadow.md')).toThrow(
      'file path escapes project directory',
    );
  });
});

describe('resolveMergeNative', () => {
  test("'mine' checks out ours and stages it", async () => {
    const io = makeIo();
    await resolveMergeNative(mergeNative('a.md'), 'mine', undefined, io, projectDir);
    expect(io.gitCalls).toEqual([
      ['checkout', '--ours', '--', ':(literal)a.md'],
      ['add', '--', ':(literal)a.md'],
    ]);
  });

  test("'theirs' checks out theirs and stages it", async () => {
    const io = makeIo();
    await resolveMergeNative(mergeNative('a.md'), 'theirs', undefined, io, projectDir);
    expect(io.gitCalls).toEqual([
      ['checkout', '--theirs', '--', ':(literal)a.md'],
      ['add', '--', ':(literal)a.md'],
    ]);
  });

  test("'content' writes the bytes then stages the file", async () => {
    const io = makeIo();
    await resolveMergeNative(mergeNative('a.md'), 'content', 'MERGED\n', io, projectDir);
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('MERGED\n');
    expect(io.gitCalls).toEqual([['add', '--', ':(literal)a.md']]);
  });

  test("'content' without bytes throws", async () => {
    const io = makeIo();
    await expect(
      resolveMergeNative(mergeNative('a.md'), 'content', undefined, io, projectDir),
    ).rejects.toThrow("strategy 'content' requires content parameter");
  });

  test("'delete' stages the removal through git", async () => {
    const io = makeIo();
    await resolveMergeNative(mergeNative('a.md'), 'delete', undefined, io, projectDir);
    expect(io.gitCalls).toEqual([['rm', '--', ':(literal)a.md']]);
  });
});

describe('resolveWorkingTree', () => {
  test("'mine' touches neither disk nor git", async () => {
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL\n', 'utf-8');
    const io = makeIo();
    await resolveWorkingTree(workingTree('a.md', 'sha'), 'mine', undefined, io, projectDir);
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL\n');
    expect(io.gitCalls).toEqual([]);
  });

  test("'theirs' writes the pinned blob without committing", async () => {
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL\n', 'utf-8');
    const io = makeIo({ gitRaw: async () => 'REMOTE\n' });
    await resolveWorkingTree(workingTree('a.md', 'sha'), 'theirs', undefined, io, projectDir);
    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('REMOTE\n');
  });

  test("'theirs' writes to the target validated before the asynchronous blob read", async () => {
    const originalTarget = join(projectDir, 'original.md');
    const replacementTarget = join(projectDir, 'replacement.md');
    const link = join(projectDir, 'a.md');
    writeFileSync(originalTarget, 'ORIGINAL\n', 'utf-8');
    writeFileSync(replacementTarget, 'REPLACEMENT\n', 'utf-8');
    symlinkSync(originalTarget, link);
    const io = makeIo({
      gitRaw: async () => {
        unlinkSync(link);
        symlinkSync(replacementTarget, link);
        return 'REMOTE\n';
      },
    });

    await resolveWorkingTree(workingTree('a.md', 'sha'), 'theirs', undefined, io, projectDir);

    expect(readFileSync(originalTarget, 'utf-8')).toBe('REMOTE\n');
    expect(readFileSync(replacementTarget, 'utf-8')).toBe('REPLACEMENT\n');
  });

  test("'delete' removes the file", async () => {
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL\n', 'utf-8');
    const io = makeIo();
    await resolveWorkingTree(workingTree('a.md', 'sha'), 'delete', undefined, io, projectDir);
    expect(existsSync(join(projectDir, 'a.md'))).toBe(false);
  });
});

describe('resolveReconcile', () => {
  test("'mine' applies the selected ours bytes through the host", async () => {
    const io = makeIo();
    const abs = join(projectDir, 'a.md');
    await resolveReconcile('mine', 'LIVE\n', 'a', abs, io);
    expect(io.applied).toEqual([{ docName: 'a', bytes: 'LIVE\n' }]);
  });

  test("'theirs' applies the snapshotted theirs stage through the host", async () => {
    const io = makeIo();
    const abs = join(projectDir, 'a.md');
    await resolveReconcile('theirs', 'THEIRS\n', 'a', abs, io);
    expect(io.applied).toEqual([{ docName: 'a', bytes: 'THEIRS\n' }]);
  });

  test("'content' applies the supplied bytes and never touches git", async () => {
    const io = makeIo();
    const abs = join(projectDir, 'a.md');
    await resolveReconcile('content', 'HAND\n', 'a', abs, io);
    expect(io.applied).toEqual([{ docName: 'a', bytes: 'HAND\n' }]);
    expect(io.gitCalls).toEqual([]);
  });

  test("'delete' unlinks the file and never touches git", async () => {
    const abs = join(projectDir, 'a.md');
    writeFileSync(abs, 'markers\n', 'utf-8');
    const io = makeIo();
    await resolveReconcile('delete', undefined, 'a', abs, io);
    expect(io.unlinks).toEqual([abs]);
    expect(io.gitCalls).toEqual([]);
  });

  test('a host throw propagates so the caller can keep the entry', async () => {
    const io = makeIo({
      applyResolvedContent: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      resolveReconcile('mine', 'OURS\n', 'a', join(projectDir, 'a.md'), io),
    ).rejects.toThrow('disk full');
  });
});

describe('selectReconcileOurs', () => {
  test('prefers marker-free live content, including an empty document', () => {
    const entry = reconcile('a.md', 'merged-with-markers');
    expect(selectReconcileOurs(entry, 'LIVE\n')).toBe('LIVE\n');
    expect(selectReconcileOurs(entry, '')).toBe('');
  });

  test('falls back to the captured stage when live content is absent or contains markers', () => {
    const entry = reconcile('a.md', 'merged-with-markers');
    expect(selectReconcileOurs(entry, null)).toBe('OURS\n');
    expect(
      selectReconcileOurs(entry, '<<<<<<< ours\nLIVE\n=======\nTHEIRS\n>>>>>>> theirs\n'),
    ).toBe('OURS\n');
  });
});

describe('ConflictAuthority live ours selection', () => {
  test('reads marker-free live content once and lands the selected bytes', async () => {
    let reads = 0;
    const io = makeIo({
      readLiveContent: () => {
        reads++;
        return reads === 1 ? 'LIVE\n' : 'CHANGED\n';
      },
    });
    const authority = new ConflictAuthority({
      projectDir,
      contentDir: projectDir,
      branch: 'main',
      io,
    });
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
    });

    await authority.resolve('a.md', 'mine');

    expect(reads).toBe(1);
    expect(io.applied).toEqual([{ docName: 'a', bytes: 'LIVE\n' }]);
  });

  test('falls back to captured ours when the optional live reader is absent', async () => {
    const io = makeIo();
    const authority = new ConflictAuthority({
      projectDir,
      contentDir: projectDir,
      branch: 'main',
      io,
    });
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
    });

    await authority.resolve('a.md', 'mine');

    expect(io.applied).toEqual([{ docName: 'a', bytes: 'OURS\n' }]);
  });

  test('validates the selected live bytes instead of a marker-filled captured stage', async () => {
    const io = makeIo({ readLiveContent: () => 'LIVE\n' });
    const authority = new ConflictAuthority({
      projectDir,
      contentDir: projectDir,
      branch: 'main',
      io,
    });
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: {
        base: 'BASE\n',
        ours: '<<<<<<< ours\nOURS\n=======\nTHEIRS\n>>>>>>> theirs\n',
        theirs: 'THEIRS\n',
      },
    });

    await authority.resolve('a.md', 'mine');

    expect(io.applied).toEqual([{ docName: 'a', bytes: 'LIVE\n' }]);
  });

  test('rejects mine when live and captured ours both contain markers', async () => {
    const markers = '<<<<<<< ours\nOURS\n=======\nTHEIRS\n>>>>>>> theirs\n';
    const io = makeIo({ readLiveContent: () => markers });
    const authority = new ConflictAuthority({
      projectDir,
      contentDir: projectDir,
      branch: 'main',
      io,
    });
    authority.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'BASE\n', ours: markers, theirs: 'THEIRS\n' },
    });

    await expect(authority.resolve('a.md', 'mine')).rejects.toMatchObject({
      name: 'ConflictMarkersInContentError',
    });
    expect(io.applied).toEqual([]);
  });
});

describe('commitMergeIfEmpty', () => {
  test('reports ok when the merge commit lands', async () => {
    const io = makeIo();
    expect(await commitMergeIfEmpty(io)).toEqual({ ok: true });
    expect(io.gitCalls).toEqual([['commit', '--no-edit']]);
  });

  test('reports the still-unmerged files when the commit fails', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        return 'a.md\0b.md\0';
      },
    });
    const result = await commitMergeIfEmpty(io);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unmerged).toEqual(['a.md', 'b.md']);
  });

  test('a crashed probe is not reported as a clean index', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        throw new Error('git exploded');
      },
    });
    const result = await commitMergeIfEmpty(io);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmerged).toBeNull();
    expect(result.unmerged === null ? result.probeError : undefined).toBeInstanceOf(Error);
    expect(result.cause).toBeInstanceOf(Error);
  });

  test('a probe reporting nothing unmerged stays distinguishable as an empty list', async () => {
    const io = makeIo({
      gitRaw: async (args) => {
        if (args[0] === 'commit') throw new Error('nothing to commit');
        return '';
      },
    });
    const result = await commitMergeIfEmpty(io);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unmerged).toEqual([]);
  });
});
