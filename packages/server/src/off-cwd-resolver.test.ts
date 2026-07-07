import { describe, expect, test } from 'bun:test';
import {
  type OffCwdCandidate,
  type OffCwdResolverDeps,
  projectDirOfLockDir,
  resolveOffCwdTarget,
} from './off-cwd-resolver.ts';

/** Build deps from a fixed candidate list + an optional symlink realpath map. */
function makeDeps(
  candidates: OffCwdCandidate[],
  realpathMap: Record<string, string> = {},
): OffCwdResolverDeps {
  return {
    discover: async () => candidates.map((c) => c.lockDir),
    inspect: async (lockDir) => candidates.find((c) => c.lockDir === lockDir) ?? null,
    realpath: async (p) => realpathMap[p] ?? p,
  };
}

function candidate(contentDir: string, port: number, alive = true): OffCwdCandidate {
  return {
    lockDir: `${contentDir}/.ok/local`,
    contentDir,
    baseUrl: `http://127.0.0.1:${port}`,
    alive,
  };
}

describe('resolveOffCwdTarget', () => {
  test('matches a target to the one server whose contentDir contains it', async () => {
    const deps = makeDeps([candidate('/repo/feat-a', 5101), candidate('/repo/feat-b', 5102)]);
    const r = await resolveOffCwdTarget('/repo/feat-b/specs/foo.md', deps);
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:5102', docName: 'specs/foo' });
  });

  test('longest-prefix wins: nested worktree beats its parent checkout', async () => {
    const deps = makeDeps([
      candidate('/repo', 5100), // main checkout
      candidate('/repo/.claude/worktrees/b', 5102), // nested worktree
    ]);
    const r = await resolveOffCwdTarget('/repo/.claude/worktrees/b/docs/x.md', deps);
    expect(r?.baseUrl).toBe('http://127.0.0.1:5102');
    expect(r?.docName).toBe('docs/x');
  });

  test('contentDir != projectDir: matches the config-derived content subdir', async () => {
    // Server's content.dir is "docs", so contentDir is a subdir of the project root.
    const deps = makeDeps([candidate('/proj/docs', 5103)]);
    const r = await resolveOffCwdTarget('/proj/docs/guide.mdx', deps);
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:5103', docName: 'guide' });
  });

  test('dead servers are skipped (liveness gate)', async () => {
    const deps = makeDeps([
      candidate('/repo/feat-b', 5102, /* alive */ false),
      candidate('/repo/feat-a', 5101, true),
    ]);
    // target lives under feat-b (dead) → no live match, not feat-a
    const r = await resolveOffCwdTarget('/repo/feat-b/specs/foo.md', deps);
    expect(r).toBeNull();
  });

  test('live shorter-prefix wins over a dead longer-prefix match (liveness gates before longest-prefix)', async () => {
    const deps = makeDeps([
      candidate('/repo', 5101, /* alive */ true), // shorter prefix, live
      candidate('/repo/feat-b', 5102, /* alive */ false), // longer prefix, dead
    ]);
    // Target is inside both, but the more-specific match is dead — the live
    // parent must win, not null and not the dead longer match.
    const r = await resolveOffCwdTarget('/repo/feat-b/specs/foo.md', deps);
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:5101', docName: 'feat-b/specs/foo' });
  });

  test('no server contains the target → null (caller ensures/refuses)', async () => {
    const deps = makeDeps([candidate('/repo/feat-a', 5101)]);
    const r = await resolveOffCwdTarget('/somewhere/else/notes.md', deps);
    expect(r).toBeNull();
  });

  test('symlinked target is realpath-resolved before matching', async () => {
    const deps = makeDeps([candidate('/repo/feat-b', 5102)], {
      '/link/notes.md': '/repo/feat-b/notes.md',
    });
    const r = await resolveOffCwdTarget('/link/notes.md', deps);
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:5102', docName: 'notes' });
  });

  test('a doc at the contentDir root resolves to its bare name', async () => {
    const deps = makeDeps([candidate('/proj', 5104)]);
    const r = await resolveOffCwdTarget('/proj/README.md', deps);
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:5104', docName: 'README' });
  });

  test('an inspect failure on one candidate does not sink the resolution', async () => {
    const good = candidate('/repo/feat-b', 5102);
    const deps: OffCwdResolverDeps = {
      discover: async () => ['/bad/.ok/local', good.lockDir],
      inspect: async (d) => {
        if (d === '/bad/.ok/local') throw new Error('stat failed');
        return good;
      },
      realpath: async (p) => p,
    };
    const r = await resolveOffCwdTarget('/repo/feat-b/x.md', deps);
    expect(r?.baseUrl).toBe('http://127.0.0.1:5102');
  });
});

describe('projectDirOfLockDir', () => {
  test('walks up from <projectDir>/.ok/local to <projectDir>', () => {
    expect(projectDirOfLockDir('/repo/feat-a/.ok/local')).toBe('/repo/feat-a');
  });
});
