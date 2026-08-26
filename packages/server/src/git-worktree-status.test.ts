/**
 * Partition rules for `git status --porcelain -z` records.
 *
 * Pure given parsed records, so these pin the rules without spawning git; the
 * real-git path is exercised through the API-level suites.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitWorktreeOpenTarget } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PorcelainEntry } from './git-paths.ts';
import { parsePorcelainEntries } from './git-paths.ts';
import {
  partitionPorcelainEntries,
  readIncomingEntries,
  readWorktreeStatus,
  WORKTREE_STATUS_LIST_CAP,
} from './git-worktree-status.ts';

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
    // `XY<space>NEW\0OLD\0` — reading the origin as its own record would
    // surface the pre-rename name as a phantom changed path.
    const out = parsePorcelainEntries('R  new.md\0old.md\0M  other.md\0');
    expect(out).toEqual([
      { x: 'R', y: ' ', path: 'new.md', origPath: 'old.md' },
      { x: 'M', y: ' ', path: 'other.md' },
    ]);
  });

  test('preserves non-ASCII path bytes', () => {
    // The whole point of `-z`: git would C-quote this in its default output.
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
    // The predicate is the sync engine's own admission check — the UI dims what
    // Push would skip, so a wrong answer here is a file the user watches not move.
    const out = partition(parsePorcelainEntries('M  docs/a.md\0 M src/main.ts\0'), (p) =>
      p.startsWith('docs/'),
    );
    expect(out.staged[0]).toMatchObject({ path: 'docs/a.md', syncScoped: true });
    expect(out.notStaged[0]).toMatchObject({ path: 'src/main.ts', syncScoped: false });
  });

  test('caps each list independently and reports the truncation', () => {
    // Per-list so a huge untracked set cannot crowd out the staged entries the
    // user actually acted on.
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

  test('a listing within the cap is not marked truncated', () => {
    const out = partition(parsePorcelainEntries('M  a.md\0'));
    expect(out.truncated).toBe(false);
  });

  test('an unrecognized status letter degrades to M rather than escaping the enum', () => {
    // The wire enum is bounded so the UI letter to label map stays total.
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

  /** A project tracking a bare origin that a sister has already advanced. */
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
    // Regression: two-dot (`HEAD..@{upstream}`) is a symmetric tree diff, so a
    // local-only commit rendered as an incoming DELETION — a file you just
    // added showed under "Pull brings in" with a destructive "Deleted" badge,
    // for a pull that would touch nothing. It also poisoned `clean`, so
    // "working tree clean" could never render while ahead. Being ahead is the
    // steady state for a follower and after any failed push, so this was not a
    // corner case. Three-dot asks merge-base..upstream, which is the real set.
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
    // Pull is unscoped — git merges whatever the remote carries — so the
    // "would Push send this" flag is meaningless and never marks a row skipped.
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
    // A local-only branch is a normal state, not an error the panel should show.
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

describe('readWorktreeStatus open-target stamping', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-worktree-doc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Stand-in for the real resolver: markdown under `notes/` is a doc, any other
   * json is an asset, everything else opens nowhere.
   */
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
    // A config file is not a document, but the asset viewer still renders it —
    // the same thing clicking it in the Files sidebar does.
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
    // Regression: the rejected branch returned all-empty lists, which is
    // byte-identical on the wire to a genuinely clean tree — so the popover
    // stated "Nothing to commit, working tree clean" about a tree it could not
    // read. The lists being empty is NOT the signal; `readable` is.
    const status = await readWorktreeStatus(dir, () => true);

    expect(status.readable).toBe(false);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  test('a real repo reports readable: true', async () => {
    // The control: without it the assertion above passes on a function that
    // always returns false.
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
