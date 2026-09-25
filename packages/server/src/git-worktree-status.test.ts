import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { GitWorktreeOpenTarget } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PorcelainEntry } from './git-paths.ts';
import { parsePorcelainEntries } from './git-paths.ts';
import {
  isExpectedGitAbsence,
  partitionPorcelainEntries,
  readIncomingEntries,
  readWorktreeStatus,
  WORKTREE_STATUS_LIST_CAP,
} from './git-worktree-status.ts';
import { getLogger } from './logger.ts';

const gitInstanceTimeouts = vi.hoisted(() => [] as (number | undefined)[]);
const gitInstanceAbortSignals = vi.hoisted(() => [] as (AbortSignal | undefined)[]);
const rawFailure = vi.hoisted(() => ({
  matches: null as ((args: string[]) => boolean) | null,
  error: new Error('simulated git crash'),
}));

vi.mock('./git-handle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-handle.ts')>();
  return {
    ...actual,
    createGitInstance: (
      projectDir: string,
      options: Parameters<typeof actual.createGitInstance>[1],
    ) => {
      gitInstanceTimeouts.push(options.timeoutMs);
      gitInstanceAbortSignals.push(options.abortSignal);
      const handle = actual.createGitInstance(projectDir, options);
      const realRaw = handle.git.raw.bind(handle.git);
      handle.git.raw = ((...args: unknown[]) => {
        const first = args[0];
        if (Array.isArray(first) && rawFailure.matches?.(first as string[])) {
          return Promise.reject(rawFailure.error);
        }
        return (realRaw as (...a: unknown[]) => unknown)(...args);
      }) as typeof handle.git.raw;
      return handle;
    },
  };
});

const SYNC_ENGINE_GIT_BLOCK_TIMEOUT_MS = 120_000;

function readSpawnedPids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, 'utf8')
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const allScoped = () => true;

function partition(entries: PorcelainEntry[], scoped: (p: string) => boolean = allScoped) {
  return partitionPorcelainEntries(entries, scoped);
}

describe('parsePorcelainEntries', () => {
  test('keeps both status columns, which parsePorcelainPaths discards', () => {
    const out = parsePorcelainEntries('M  a.md\0 M b.md\0MM c.md\0');
    expect(out).toEqual([
      { x: 'M', y: ' ', path: 'a.md' },
      { x: ' ', y: 'M', path: 'b.md' },
      { x: 'M', y: 'M', path: 'c.md' },
    ]);
  });

  test('consumes a rename origin as origPath rather than a separate entry', () => {
    const out = parsePorcelainEntries('R  new.md\0old.md\0M  other.md\0');
    expect(out).toEqual([
      { x: 'R', y: ' ', path: 'new.md', origPath: 'old.md' },
      { x: 'M', y: ' ', path: 'other.md' },
    ]);
  });

  test('preserves non-ASCII path bytes', () => {
    const out = parsePorcelainEntries('M  hyvää yötä.md\0');
    expect(out[0]?.path).toBe('hyvää yötä.md');
  });

  test('drops the trailing empty field after the final NUL', () => {
    expect(parsePorcelainEntries('')).toEqual([]);
    expect(parsePorcelainEntries('\0')).toEqual([]);
  });
});

describe('partitionPorcelainEntries', () => {
  test('files a path under the column that changed', () => {
    const out = partition(parsePorcelainEntries('M  staged.md\0 D unstaged.md\0'));
    expect(out.staged).toEqual([{ path: 'staged.md', code: 'M', syncScoped: true }]);
    expect(out.notStaged).toEqual([{ path: 'unstaged.md', code: 'D', syncScoped: true }]);
    expect(out.untracked).toEqual([]);
  });

  test('a path dirty in both columns appears in both lists, as git shows it', () => {
    const out = partition(parsePorcelainEntries('MM both.md\0'));
    expect(out.staged).toEqual([{ path: 'both.md', code: 'M', syncScoped: true }]);
    expect(out.notStaged).toEqual([{ path: 'both.md', code: 'M', syncScoped: true }]);
  });

  test('untracked lands in its own list under a single code', () => {
    const out = partition(parsePorcelainEntries('?? new.md\0'));
    expect(out.untracked).toEqual([{ path: 'new.md', code: '?', syncScoped: true }]);
    expect(out.staged).toEqual([]);
    expect(out.notStaged).toEqual([]);
  });

  test('ignored entries are dropped — this surface never passes --ignored', () => {
    const out = partition(parsePorcelainEntries('!! dist/bundle.js\0'));
    expect(out.staged).toEqual([]);
    expect(out.notStaged).toEqual([]);
    expect(out.untracked).toEqual([]);
  });

  test('carries the rename origin onto the staged entry', () => {
    const out = partition(parsePorcelainEntries('R  new.md\0old.md\0'));
    expect(out.staged).toEqual([
      { path: 'new.md', code: 'R', syncScoped: true, origPath: 'old.md' },
    ]);
  });

  test('marks each entry with the caller-supplied sync scope', () => {
    const out = partition(parsePorcelainEntries('M  docs/a.md\0 M src/main.ts\0'), (p) =>
      p.startsWith('docs/'),
    );
    expect(out.staged[0]).toMatchObject({ path: 'docs/a.md', syncScoped: true });
    expect(out.notStaged[0]).toMatchObject({ path: 'src/main.ts', syncScoped: false });
  });

  test('caps each list independently and reports the truncation', () => {
    const many = Array.from({ length: WORKTREE_STATUS_LIST_CAP + 5 }, (_, i) => ({
      x: '?',
      y: '?',
      path: `f${i}.md`,
    }));
    const out = partition([...many, { x: 'M', y: ' ', path: 'staged.md' }]);
    expect(out.untracked).toHaveLength(WORKTREE_STATUS_LIST_CAP);
    expect(out.staged).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  test('sync-scoped entries keep their slot when out-of-scope ones exhaust the cap', () => {
    const many = Array.from({ length: WORKTREE_STATUS_LIST_CAP + 5 }, (_, i) => ({
      x: '?',
      y: '?',
      path: `build/f${String(i).padStart(3, '0')}.md`,
    }));
    const out = partition([...many, { x: '?', y: '?', path: 'notes/mine.md' }], (p) =>
      p.startsWith('notes/'),
    );
    expect(out.untracked).toHaveLength(WORKTREE_STATUS_LIST_CAP);
    expect(out.untracked[0]?.path).toBe('notes/mine.md');
    expect(out.untracked.map((e) => e.path)).toContain('notes/mine.md');
    expect(out.truncated).toBe(true);
  });

  test('ordering within the sync-scoped group is the order git reported', () => {
    const out = partition(
      parsePorcelainEntries('?? build/z.md\0?? notes/b.md\0?? notes/a.md\0'),
      (p) => p.startsWith('notes/'),
    );
    expect(out.untracked.map((e) => e.path)).toEqual(['notes/b.md', 'notes/a.md', 'build/z.md']);
  });

  test('a listing within the cap is not marked truncated', () => {
    const out = partition(parsePorcelainEntries('M  a.md\0'));
    expect(out.truncated).toBe(false);
  });

  test('an unrecognized status letter degrades to M rather than escaping the enum', () => {
    const out = partition([{ x: 'X', y: ' ', path: 'weird.md' }]);
    expect(out.staged[0]?.code).toBe('M');
  });
});

describe('readIncomingEntries', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-incoming-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function projectBehindOrigin() {
    const bare = join(dir, 'bare.git');
    await simpleGit().init(true, [bare]);
    await simpleGit(bare).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

    const project = join(dir, 'project');
    const git = simpleGit();
    await git.clone(bare, project);
    const pg = simpleGit(project);
    await pg.raw('config', 'user.name', 'Test');
    await pg.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(project, 'kept.md'), 'v1\n');
    await pg.add('.');
    await pg.commit('seed');
    await pg.push(['--set-upstream', 'origin', 'main']);

    const sister = join(dir, 'sister');
    await simpleGit().clone(bare, sister);
    const sg = simpleGit(sister);
    await sg.raw('config', 'user.name', 'Sister');
    await sg.raw('config', 'user.email', 'sister@test.com');
    return { pg, sg, sister };
  }

  test('a branch that is only AHEAD has nothing incoming', async () => {
    const { pg } = await projectBehindOrigin();
    writeFileSync(join(await pg.revparse('--show-toplevel'), 'mine.md'), 'local\n');
    await pg.add('.');
    await pg.commit('local-only');

    expect(await readIncomingEntries(pg)).toEqual([]);
  });

  test('lists what a pull would bring in, by change kind', async () => {
    const { pg, sg, sister } = await projectBehindOrigin();
    writeFileSync(join(sister, 'kept.md'), 'v1\nv2\n');
    writeFileSync(join(sister, 'added.md'), 'new\n');
    await sg.add('.');
    await sg.commit('sister changes');
    await sg.push();
    await pg.fetch('origin');

    const incoming = await readIncomingEntries(pg);
    const byPath = Object.fromEntries(incoming.map((e) => [e.path, e.code]));
    expect(byPath).toEqual({ 'kept.md': 'M', 'added.md': 'A' });
    expect(incoming.every((e) => e.syncScoped)).toBe(true);
  });

  test('reports the post-merge path for a rename, keeping the origin', async () => {
    const { pg, sg } = await projectBehindOrigin();
    await sg.mv('kept.md', 'renamed.md');
    await sg.commit('sister renames');
    await sg.push();
    await pg.fetch('origin');

    const incoming = await readIncomingEntries(pg);
    const rename = incoming.find((e) => e.code === 'R');
    expect(rename?.path).toBe('renamed.md');
    expect(rename?.origPath).toBe('kept.md');
  });

  test('is empty when the branch is already up to date', async () => {
    const { pg } = await projectBehindOrigin();
    await pg.fetch('origin');
    expect(await readIncomingEntries(pg)).toEqual([]);
  });

  test('returns empty rather than throwing when there is no upstream', async () => {
    const solo = join(dir, 'solo');
    const git = simpleGit();
    await git.init(false, [solo]);
    const sg = simpleGit(solo);
    await sg.raw('config', 'user.name', 'Test');
    await sg.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(solo, 'a.md'), 'x\n');
    await sg.add('.');
    await sg.commit('seed');

    expect(await readIncomingEntries(sg)).toEqual([]);
  });
});

describe('isExpectedGitAbsence', () => {
  test('admits the three states git reports as absence rather than failure', () => {
    expect(
      isExpectedGitAbsence(
        new Error(
          "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
        ),
      ),
    ).toBe(true);
    expect(isExpectedGitAbsence(new Error("fatal: no upstream configured for branch 'main'"))).toBe(
      true,
    );
    expect(isExpectedGitAbsence(new Error('fatal: HEAD does not point to a branch'))).toBe(true);
    expect(isExpectedGitAbsence(new Error("fatal: no such branch: 'main'"))).toBe(true);
  });

  test('a real read failure is not absence', () => {
    expect(isExpectedGitAbsence(new Error('fatal: not a git repository'))).toBe(false);
    expect(isExpectedGitAbsence(new Error('fatal: Unable to read current working directory'))).toBe(
      false,
    );
    expect(isExpectedGitAbsence(undefined)).toBe(false);
  });
});

describe('readWorktreeStatus open-target stamping', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-worktree-doc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const notesAndJson = (projectRelPath: string): GitWorktreeOpenTarget | undefined => {
    if (projectRelPath.startsWith('notes/') && projectRelPath.endsWith('.md')) {
      return { kind: 'doc', docName: projectRelPath.slice(0, -'.md'.length) };
    }
    return projectRelPath.endsWith('.json') ? { kind: 'asset', path: projectRelPath } : undefined;
  };

  test('stamps each row with the target the mapper resolves, doc or asset', async () => {
    const project = join(dir, 'project');
    const git = simpleGit();
    await git.init(false, [project]);
    const pg = simpleGit(project);
    await pg.raw('config', 'user.name', 'Test');
    await pg.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(project, 'opencode.json'), '{}\n');
    mkdirSync(join(project, 'notes'), { recursive: true });
    writeFileSync(join(project, 'notes/cadence.md'), 'draft\n');
    await pg.add('.');
    await pg.commit('seed');

    writeFileSync(join(project, 'opencode.json'), '{"mcp":{}}\n');
    writeFileSync(join(project, 'notes/cadence.md'), 'draft\nmore\n');

    const status = await readWorktreeStatus(project, () => true, notesAndJson);

    const note = status.notStaged.find((e) => e.path === 'notes/cadence.md');
    const config = status.notStaged.find((e) => e.path === 'opencode.json');
    expect(note?.open).toEqual({ kind: 'doc', docName: 'notes/cadence' });
    expect(config?.open).toEqual({ kind: 'asset', path: 'opencode.json' });
  });

  test('omits every open target when no mapper is supplied', async () => {
    const project = join(dir, 'project');
    await simpleGit().init(false, [project]);
    const pg = simpleGit(project);
    await pg.raw('config', 'user.name', 'Test');
    await pg.raw('config', 'user.email', 'test@test.com');
    mkdirSync(join(project, 'notes'), { recursive: true });
    writeFileSync(join(project, 'notes/cadence.md'), 'draft\n');
    await pg.add('.');
    await pg.commit('seed');
    writeFileSync(join(project, 'notes/cadence.md'), 'draft\nmore\n');

    const status = await readWorktreeStatus(project, () => true);

    expect(status.notStaged.map((e) => e.open)).toEqual([undefined]);
  });
});

describe('readWorktreeStatus — an unreadable tree is representable', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-unreadable-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a directory that is not a git repo reports readable: false, not a clean tree', async () => {
    const status = await readWorktreeStatus(dir, () => true);

    expect(status.readable).toBe(false);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  test('a real repo reports readable: true', async () => {
    const g = simpleGit(dir);
    await g.init(['--initial-branch=main']);
    await g.raw('config', 'user.email', 't@e.com');
    await g.raw('config', 'user.name', 'T');
    writeFileSync(join(dir, 'a.md'), 'x\n');

    const status = await readWorktreeStatus(dir, () => true);

    expect(status.readable).toBe(true);
    expect(status.untracked.map((e) => e.path)).toContain('a.md');
  });
});

describe('readWorktreeStatus — the panel listing is trustworthy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-worktree-read-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seededRepo(): Promise<string> {
    const project = join(dir, 'project');
    mkdirSync(project, { recursive: true });
    const g = simpleGit(project);
    await g.init(['--initial-branch=main']);
    await g.raw('config', 'user.name', 'Test');
    await g.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(project, 'seed.md'), 'v1\n');
    await g.add('.');
    await g.commit('seed');
    return project;
  }

  test('a brand-new folder is listed as its files, not as one collapsed directory', async () => {
    const project = await seededRepo();
    mkdirSync(join(project, 'newdir'), { recursive: true });
    writeFileSync(join(project, 'newdir/a.md'), 'a\n');
    writeFileSync(join(project, 'newdir/b.md'), 'b\n');

    const status = await readWorktreeStatus(project, () => true);

    expect(status.untracked.map((e) => e.path).sort()).toEqual(['newdir/a.md', 'newdir/b.md']);
  });

  test('reading the listing leaves the git index the sync engine writes untouched', async () => {
    const project = await seededRepo();
    const stale = new Date(Date.now() - 60_000);
    utimesSync(join(project, 'seed.md'), stale, stale);
    const before = statSync(join(project, '.git', 'index'), { bigint: true });

    const status = await readWorktreeStatus(project, () => true);

    const after = statSync(join(project, '.git', 'index'), { bigint: true });
    expect(status.readable).toBe(true);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  test('a real tree full of out-of-scope untracked files still lists the sync-scoped one', async () => {
    const project = await seededRepo();
    mkdirSync(join(project, 'build'), { recursive: true });
    for (let i = 0; i < WORKTREE_STATUS_LIST_CAP + 20; i++) {
      writeFileSync(join(project, 'build', `f${String(i).padStart(3, '0')}.md`), 'x\n');
    }
    mkdirSync(join(project, 'notes'), { recursive: true });
    writeFileSync(join(project, 'notes', 'zzz-mine.md'), 'mine\n');

    const status = await readWorktreeStatus(project, (p) => p.startsWith('notes/'));

    expect(status.untracked).toHaveLength(WORKTREE_STATUS_LIST_CAP);
    expect(status.untracked.map((e) => e.path)).toContain('notes/zzz-mine.md');
    expect(status.truncated).toBe(true);
  });

  test('reading a branch with an upstream also leaves the git index untouched', async () => {
    const project = await seededRepo();
    const bare = join(dir, 'bare.git');
    mkdirSync(bare, { recursive: true });
    await simpleGit(bare).init(true);
    await simpleGit(bare).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    const g = simpleGit(project);
    await g.addRemote('origin', bare);
    await g.push(['--set-upstream', 'origin', 'main']);

    const stale = new Date(Date.now() - 60_000);
    utimesSync(join(project, 'seed.md'), stale, stale);
    const before = statSync(join(project, '.git', 'index'), { bigint: true });

    const status = await readWorktreeStatus(project, () => true);

    const after = statSync(join(project, '.git', 'index'), { bigint: true });
    expect(status.upstream).toBe('origin/main');
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  test.skipIf(process.platform === 'win32')(
    'a git that never answers is cut off by the read timeout and reports an unreadable tree',
    async () => {
      const project = await seededRepo();
      const shimDir = join(dir, 'shim');
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexec sleep 5\n');
      chmodSync(join(shimDir, 'git'), 0o755);
      const realPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${realPath ?? ''}`;

      try {
        const status = await readWorktreeStatus(project, () => true, undefined, {
          timeoutMs: 250,
        });

        expect(status.readable).toBe(false);
        expect(status.staged).toEqual([]);
      } finally {
        process.env.PATH = realPath;
      }
    },
  );

  test('the default read timeout stays far below the sync engine block budget', async () => {
    const project = await seededRepo();
    gitInstanceTimeouts.length = 0;

    await readWorktreeStatus(project, () => true);

    expect(gitInstanceTimeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of gitInstanceTimeouts) {
      expect(typeof timeoutMs).toBe('number');
      expect(timeoutMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        SYNC_ENGINE_GIT_BLOCK_TIMEOUT_MS / 4,
      );
    }
  });

  test('a silently defaulted branch leg is reported at warn, not swallowed', async () => {
    const project = await seededRepo();
    const logger = getLogger('git-worktree-status');
    const warned: { data: Record<string, unknown>; msg: string }[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown, msg?: string) => {
      warned.push({ data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    }) as never);
    rawFailure.matches = (args) => args[0] === 'rev-parse' && args.at(-1) === 'HEAD';

    try {
      const status = await readWorktreeStatus(project, () => true);

      expect(status.readable).toBe(true);
      expect(status.branch).toBeNull();
      const line = warned.find((entry) => entry.data.event === 'worktree-branch-read-failed');
      expect(line?.msg.startsWith('[sync] ')).toBe(true);
      expect(typeof line?.data.elapsedMs).toBe('number');
      expect(line?.data).toHaveProperty('err');
    } finally {
      rawFailure.matches = null;
      spy.mockRestore();
    }
  });

  test('a silently defaulted upstream leg is reported at warn', async () => {
    const project = await seededRepo();
    const logger = getLogger('git-worktree-status');
    const warned: Record<string, unknown>[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown) => {
      warned.push((data ?? {}) as Record<string, unknown>);
    }) as never);
    rawFailure.matches = (args) => args[0] === 'rev-parse' && args.at(-1) === '@{upstream}';

    try {
      const status = await readWorktreeStatus(project, () => true);

      expect(status.readable).toBe(true);
      expect(status.upstream).toBeNull();
      expect(warned.map((d) => d.event)).toContain('worktree-upstream-read-failed');
    } finally {
      rawFailure.matches = null;
      spy.mockRestore();
    }
  });

  test('a silently defaulted incoming leg is reported at warn', async () => {
    const project = await seededRepo();
    const logger = getLogger('git-worktree-status');
    const warned: Record<string, unknown>[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown) => {
      warned.push((data ?? {}) as Record<string, unknown>);
    }) as never);
    rawFailure.matches = (args) => args[0] === 'diff';

    try {
      const status = await readWorktreeStatus(project, () => true);

      expect(status.readable).toBe(true);
      expect(status.incoming).toEqual([]);
      expect(warned.map((d) => d.event)).toContain('worktree-incoming-read-failed');
    } finally {
      rawFailure.matches = null;
      spy.mockRestore();
    }
  });

  test('a repo with no upstream defaults quietly — absence is not a failure', async () => {
    const project = await seededRepo();
    const logger = getLogger('git-worktree-status');
    const warned: Record<string, unknown>[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown) => {
      warned.push((data ?? {}) as Record<string, unknown>);
    }) as never);

    try {
      const status = await readWorktreeStatus(project, () => true);

      expect(status.upstream).toBeNull();
      expect(status.incoming).toEqual([]);
      expect(warned).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a repo with no commits yet defaults quietly and still reads its listing', async () => {
    const project = join(dir, 'unborn');
    mkdirSync(project, { recursive: true });
    const g = simpleGit(project);
    await g.init(['--initial-branch=main']);
    writeFileSync(join(project, 'a.md'), 'x\n');
    const logger = getLogger('git-worktree-status');
    const warned: Record<string, unknown>[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown) => {
      warned.push((data ?? {}) as Record<string, unknown>);
    }) as never);

    try {
      const status = await readWorktreeStatus(project, () => true);

      expect(status.readable).toBe(true);
      expect(status.branch).toBeNull();
      expect(status.untracked.map((e) => e.path)).toContain('a.md');
      expect(warned).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test.skipIf(process.platform === 'win32')(
    'aborting a read that is already spawned kills the git process and stays out of the support grep',
    async () => {
      const project = await seededRepo();
      const shimDir = join(dir, 'abort-shim');
      mkdirSync(shimDir, { recursive: true });
      const pidFile = join(shimDir, 'pids');
      writeFileSync(join(shimDir, 'git'), `#!/bin/sh\necho $$ >> "${pidFile}"\nexec sleep 10\n`);
      chmodSync(join(shimDir, 'git'), 0o755);
      const realPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${realPath ?? ''}`;

      const logger = getLogger('git-worktree-status');
      const reported: string[] = [];
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(((data: unknown) => {
        reported.push(String((data as Record<string, unknown>)?.event ?? ''));
      }) as never);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown) => {
        reported.push(String((data as Record<string, unknown>)?.event ?? ''));
      }) as never);
      gitInstanceAbortSignals.length = 0;
      const controller = new AbortController();
      let spawnedPids: number[] = [];

      try {
        const pending = readWorktreeStatus(project, () => true, undefined, {
          timeoutMs: 30_000,
          abortSignal: controller.signal,
        }).then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        );

        await vi.waitFor(() => {
          spawnedPids = readSpawnedPids(pidFile);
          expect(spawnedPids.length).toBeGreaterThan(0);
        });
        expect(spawnedPids.every(isProcessAlive)).toBe(true);
        expect(controller.signal.aborted).toBe(false);

        controller.abort();
        const settled = await Promise.race([
          pending,
          new Promise<'still-running'>((resolve) =>
            setTimeout(() => resolve('still-running'), 4000),
          ),
        ]);

        expect(settled).not.toBe('still-running');
        expect(settled).toMatchObject({ ok: true, value: { readable: false } });
        expect(gitInstanceAbortSignals.some((s) => s?.aborted === true)).toBe(true);
        expect(reported).toEqual([]);
        await vi.waitFor(() => {
          expect(readSpawnedPids(pidFile).filter(isProcessAlive)).toEqual([]);
        });
      } finally {
        process.env.PATH = realPath;
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    },
    20_000,
  );

  test('a signal already aborted when the read starts never spawns git and stays quiet', async () => {
    const project = await seededRepo();
    const logger = getLogger('git-worktree-status');
    const reported: string[] = [];
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(((data: unknown) => {
      reported.push(String((data as Record<string, unknown>)?.event ?? ''));
    }) as never);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown) => {
      reported.push(String((data as Record<string, unknown>)?.event ?? ''));
    }) as never);
    gitInstanceAbortSignals.length = 0;

    try {
      const status = await readWorktreeStatus(project, () => true, undefined, {
        abortSignal: AbortSignal.abort(),
      });

      expect(status.readable).toBe(false);
      expect(gitInstanceAbortSignals.some((s) => s?.aborted === true)).toBe(true);
      expect(reported).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('an unreadable tree is reported to support with its duration and branch', async () => {
    const project = await seededRepo();
    const logger = getLogger('git-worktree-status');
    const reported: { data: Record<string, unknown>; msg: string }[] = [];
    const spy = vi.spyOn(logger, 'error').mockImplementation(((data: unknown, msg?: string) => {
      reported.push({ data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    }) as never);

    try {
      rmSync(join(project, '.git'), { recursive: true, force: true });
      const status = await readWorktreeStatus(project, () => true);

      expect(status.readable).toBe(false);
      const line = reported.find((entry) => entry.msg.includes('worktree status read failed'));
      expect(line?.msg.startsWith('[sync] ')).toBe(true);
      expect(typeof line?.data.elapsedMs).toBe('number');
      expect(line?.data).toHaveProperty('branch');
      expect(line?.data).toHaveProperty('err');
    } finally {
      spy.mockRestore();
    }
  });
});
