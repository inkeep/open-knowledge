import { describe, expect, test } from 'bun:test';
import type { BridgeWorktreeEntry } from '../git/worktree-list-parser.ts';
import {
  type Candidate,
  type CandidateBridgeDeps,
  type CandidateSelection,
  type CandidateSelectionPayload,
  selectCandidate,
} from './candidate-selection.ts';
import type { HeadBranchInfo, RecentProjectEntry, ResolvedGitDirKind } from './receive-flow.ts';

function recent(overrides: Partial<RecentProjectEntry> & { path: string }): RecentProjectEntry {
  return {
    path: overrides.path,
    name: overrides.name ?? overrides.path.split('/').filter(Boolean).pop() ?? 'project',
    lastOpenedAt: overrides.lastOpenedAt ?? '2026-05-15T00:00:00.000Z',
    gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    ...overrides,
  };
}

function head(currentBranch: string | null, sha: string | null = 'abc1234'): HeadBranchInfo {
  return { currentBranch, headSha: sha, detached: currentBranch === null && sha !== null };
}

function worktreeEntry(
  overrides: Partial<BridgeWorktreeEntry> & { path: string },
): BridgeWorktreeEntry {
  return {
    path: overrides.path,
    branch: overrides.branch ?? null,
    headSha: overrides.headSha ?? 'abc1234',
    locked: overrides.locked ?? false,
    prunable: overrides.prunable ?? false,
  };
}

interface StubOptions {
  readonly recents?: RecentProjectEntry[];
  readonly worktreesByAnchor?: Record<string, BridgeWorktreeEntry[]>;
  readonly headsByPath?: Record<string, HeadBranchInfo>;
  readonly gitDirKindByPath?: Record<string, ResolvedGitDirKind>;
  readonly okProjectRoots?: ReadonlySet<string>;
  readonly listRecentThrows?: boolean;
  readonly listGitWorktreesThrows?: boolean;
  /**
   * Canonical-path map applied by the `realpath` stub. A path not present
   * maps to itself (identity). Supply entries to simulate `/var` →
   * `/private/var` style symlink collapse.
   */
  readonly realpathByPath?: Record<string, string>;
  readonly realpathThrowsFor?: ReadonlySet<string>;
}

function makeBridge(opts: StubOptions): CandidateBridgeDeps {
  return {
    async listRecent() {
      if (opts.listRecentThrows) throw new Error('synthetic listRecent failure');
      return opts.recents ?? [];
    },
    async listGitWorktrees(anchorPath) {
      if (opts.listGitWorktreesThrows) throw new Error('synthetic listGitWorktrees failure');
      return opts.worktreesByAnchor?.[anchorPath] ?? [];
    },
    async readHeadBranch(projectPath) {
      return (
        opts.headsByPath?.[projectPath] ?? { currentBranch: null, headSha: null, detached: false }
      );
    },
    async readGitDirKind(projectPath) {
      return opts.gitDirKindByPath?.[projectPath] ?? 'absent';
    },
    async isOkProjectRoot(projectPath) {
      return opts.okProjectRoots?.has(projectPath) ?? false;
    },
    async realpath(path) {
      if (opts.realpathThrowsFor?.has(path)) throw new Error('synthetic realpath failure');
      return opts.realpathByPath?.[path] ?? path;
    },
  };
}

const PAYLOAD: CandidateSelectionPayload = {
  owner: 'inkeep',
  repo: 'open-knowledge',
  branch: 'feat-bar',
};

describe('selectCandidate', () => {
  test('no Recents match → kind:miss', async () => {
    const bridge = makeBridge({ recents: [] });
    await expect(selectCandidate(PAYLOAD, bridge)).resolves.toEqual({ kind: 'miss' });
  });

  test('listRecent throws → kind:miss (graceful)', async () => {
    const bridge = makeBridge({ listRecentThrows: true });
    await expect(selectCandidate(PAYLOAD, bridge)).resolves.toEqual({ kind: 'miss' });
  });

  test('branch-match in non-most-recent Recent wins over most-recent recency', async () => {
    const main = recent({ path: '/main' });
    const featBar = recent({ path: '/wt/feat-bar' });
    const bridge = makeBridge({
      recents: [main, featBar],
      headsByPath: {
        '/main': head('main'),
        '/wt/feat-bar': head('feat-bar'),
      },
      gitDirKindByPath: {
        '/main': 'directory',
        '/wt/feat-bar': 'linked',
      },
      okProjectRoots: new Set(['/main', '/wt/feat-bar']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/wt/feat-bar');
      expect(result.candidate.locked).toBe(false);
    }
  });

  test('branch-match in worktree-enum but not in Recents (CLI-managed worktree)', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/feat-bar', branch: 'feat-bar' }),
        ],
      },
      headsByPath: { '/main': head('main') },
      // The worktree-enum path pre-populates HEAD from `git worktree list`,
      // so readHeadBranch is not consulted for /wt/feat-bar.
      gitDirKindByPath: {
        '/main': 'directory',
        '/wt/feat-bar': 'linked',
      },
      // /wt/feat-bar lacks .ok/config.yml — the CLI-managed-worktree consent case.
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-non-ok');
    if (result.kind === 'branch-match-non-ok') {
      expect(result.candidate.path).toBe('/wt/feat-bar');
      expect(result.candidate.hasOkConfig).toBe(false);
      expect(result.candidate.source).toBe('worktree-enum');
    }
  });

  test('no branch match prefers main checkout over linked worktree', async () => {
    const main = recent({ path: '/main' });
    const featFoo = recent({ path: '/wt/feat-foo' });
    const bridge = makeBridge({
      // Share is for feat-baz; neither candidate has feat-baz checked out.
      recents: [main, featFoo],
      headsByPath: {
        '/main': head('main'),
        '/wt/feat-foo': head('feat-foo'),
      },
      gitDirKindByPath: {
        '/main': 'directory',
        '/wt/feat-foo': 'linked',
      },
      okProjectRoots: new Set(['/main', '/wt/feat-foo']),
    });
    const result = await selectCandidate({ ...PAYLOAD, branch: 'feat-baz' }, bridge);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.anchor.path).toBe('/main');
      expect(result.reason).toBe('main-checkout');
    }
  });

  test('no main checkout, only linked worktrees → reason:only-worktrees', async () => {
    const featFoo = recent({ path: '/wt/feat-foo' });
    const bridge = makeBridge({
      recents: [featFoo],
      headsByPath: { '/wt/feat-foo': head('feat-foo') },
      gitDirKindByPath: { '/wt/feat-foo': 'linked' },
      okProjectRoots: new Set(['/wt/feat-foo']),
    });
    const result = await selectCandidate({ ...PAYLOAD, branch: 'feat-baz' }, bridge);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.anchor.path).toBe('/wt/feat-foo');
      expect(result.reason).toBe('only-worktrees');
    }
  });

  test('all Recents matches missing → kind:miss (graceful degradation)', async () => {
    const bridge = makeBridge({
      recents: [
        recent({ path: '/missing-a', missing: true }),
        recent({ path: '/missing-b', missing: true }),
      ],
    });
    await expect(selectCandidate(PAYLOAD, bridge)).resolves.toEqual({ kind: 'miss' });
  });

  test('locked worktree is a first-class candidate (locked flag preserved)', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({
            path: '/wt/agent-spawn',
            branch: 'feat-bar',
            locked: true,
            headSha: 'deadbe',
          }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: {
        '/main': 'directory',
        '/wt/agent-spawn': 'linked',
      },
      okProjectRoots: new Set(['/main', '/wt/agent-spawn']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/wt/agent-spawn');
      expect(result.candidate.locked).toBe(true);
    }
  });

  test('slashed branch name round-trips through selection', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/foo-bar', branch: 'feat/foo/bar' }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory', '/wt/foo-bar': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/foo-bar']),
    });
    const result = await selectCandidate({ ...PAYLOAD, branch: 'feat/foo/bar' }, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/wt/foo-bar');
    }
  });

  test('Recents entry and worktree-enum entry at same path collapse to one Candidate', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          // worktree-enum also lists /main — should NOT produce a duplicate
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/feat-bar', branch: 'feat-bar' }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory', '/wt/feat-bar': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/feat-bar']),
    });
    // Branch-match goes to /wt/feat-bar. No duplicate emission for /main.
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/wt/feat-bar');
    }
  });

  test('locked flag adopted from worktree-enum when Recents path matches', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [worktreeEntry({ path: '/main', branch: 'feat-bar', locked: true })],
      },
      headsByPath: { '/main': head('feat-bar') },
      gitDirKindByPath: { '/main': 'directory' },
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/main');
      // Adopted from worktree-enum even though Recents has no notion of locked.
      expect(result.candidate.locked).toBe(true);
    }
  });

  test('multiple branch-match candidates log q1_ambiguous_branch_match (quiet tiebreak)', async () => {
    const a = recent({ path: '/main' });
    const b = recent({ path: '/wt/copy' });
    // Fixture-induced impossibility — git's rules say at most one worktree per
    // branch, but the algorithm must still produce a deterministic outcome.
    const bridge = makeBridge({
      recents: [a, b],
      headsByPath: {
        '/main': head('feat-bar'),
        '/wt/copy': head('feat-bar'),
      },
      gitDirKindByPath: { '/main': 'directory', '/wt/copy': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/copy']),
    });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const result = await selectCandidate(PAYLOAD, bridge);
      expect(result.kind).toBe('branch-match-ok');
      // Recents tiebreak: /main appears first.
      if (result.kind === 'branch-match-ok') expect(result.candidate.path).toBe('/main');
      expect(
        warnings.some((w) => w.includes('q1_ambiguous_branch_match') && w.includes('chosen=/main')),
      ).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test('listGitWorktrees throws → still produces a Candidate from Recents alone', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      listGitWorktreesThrows: true,
      headsByPath: { '/main': head('feat-bar') },
      gitDirKindByPath: { '/main': 'directory' },
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') expect(result.candidate.path).toBe('/main');
  });

  test('worktree-enum non-OK candidate without Recents counterpart routes to branch-match-non-ok', async () => {
    const main = recent({ path: '/main', name: 'host-checkout' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/cli-managed', branch: 'feat-bar' }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory', '/wt/cli-managed': 'linked' },
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-non-ok');
    if (result.kind === 'branch-match-non-ok') {
      expect(result.candidate.path).toBe('/wt/cli-managed');
      expect(result.candidate.hasOkConfig).toBe(false);
      // The candidate's OWN Recents entry is null because the CLI-managed
      // worktree has never been opened in OK. The anchorRecent surfaces a
      // meaningful "a worktree of <name>" context line.
      expect(result.candidate.recent).toBeNull();
      expect(result.anchorRecent).not.toBeNull();
      expect(result.anchorRecent?.name).toBe('host-checkout');
      expect(result.anchorRecent?.path).toBe('/main');
    }
  });

  test('no usable candidate at all → kind:miss', async () => {
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      // No branch-match, no main checkout (gitDirKind is absent), no linked worktree.
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'absent' },
      okProjectRoots: new Set(),
    });
    const result = await selectCandidate({ ...PAYLOAD, branch: 'feat-baz' }, bridge);
    expect(result.kind).toBe('miss');
  });

  test('strict branch-match: unreadable HEAD does NOT compete with a true branch match', async () => {
    // Multi-candidate scenario where one candidate has an unreadable HEAD
    // (graceful-fail sentinel: currentBranch=null, headSha=null,
    // detached=false) and another has a true `feat-bar` match. Strict
    // matching must exclude the unreadable candidate from the branch-match
    // partition — otherwise pickByRecency could surface it over the true
    // match.
    const recent1 = recent({
      path: '/main',
      // Most recent — would beat /wt/feat on recency if the soft match
      // semantics returned 'true' for unreadable HEAD.
      lastOpenedAt: '2026-05-20T00:00:00.000Z',
    });
    const recent2 = recent({
      path: '/wt/feat',
      lastOpenedAt: '2026-05-10T00:00:00.000Z',
    });
    const bridge = makeBridge({
      recents: [recent1, recent2],
      headsByPath: {
        '/main': { currentBranch: null, headSha: null, detached: false },
        '/wt/feat': head('feat-bar'),
      },
      gitDirKindByPath: { '/main': 'directory', '/wt/feat': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/feat']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      // True branch match wins over the unreadable-HEAD candidate even
      // though the unreadable one is more recent.
      expect(result.candidate.path).toBe('/wt/feat');
    }
  });

  test('strict branch-match: detached HEAD does NOT count as a branch match', async () => {
    // Detached HEAD has `currentBranch: null` but `headSha: <sha>` and
    // `detached: true`. It must fall through to fallback even with a single
    // candidate — silent dispatch onto a detached HEAD would surprise the
    // user.
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      headsByPath: { '/main': { currentBranch: null, headSha: 'abc1234', detached: true } },
      gitDirKindByPath: { '/main': 'directory' },
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.anchor.path).toBe('/main');
      expect(result.reason).toBe('main-checkout');
    }
  });

  test('strict branch-match: empty share-branch with multi-candidate falls through to fallback', async () => {
    // With MULTIPLE candidates, strict matching applies and an empty
    // share-branch never strictly matches any candidate — fall through to
    // fallback (main-checkout) instead of letting an unreadable-HEAD
    // candidate compete on recency.
    const main = recent({ path: '/main' });
    const wt = recent({ path: '/wt/feat' });
    const bridge = makeBridge({
      recents: [main, wt],
      headsByPath: {
        '/main': { currentBranch: null, headSha: null, detached: false },
        '/wt/feat': head('feat-bar'),
      },
      gitDirKindByPath: { '/main': 'directory', '/wt/feat': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/feat']),
    });
    const result = await selectCandidate({ ...PAYLOAD, branch: '' }, bridge);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.reason).toBe('main-checkout');
      expect(result.anchor.path).toBe('/main');
    }
  });

  test('legacy soft-match: single-Recent + empty share-branch silent-dispatches (legacy URL)', async () => {
    // Single-Recent scenario, empty payload.branch (legacy share URL with
    // no `?branch=`). Soft-match falls through and the candidate is
    // selected for silent dispatch.
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory' },
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate({ ...PAYLOAD, branch: '' }, bridge);
    // Soft-match for the lone candidate — classifyBranchMatch returns
    // 'true' on empty share-branch, so the single candidate is selected.
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/main');
    }
  });

  test('legacy soft-match: single-Recent + unreadable HEAD silent-dispatches', async () => {
    // Single-Recent scenario, unreadable HEAD — graceful degradation.
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      headsByPath: { '/main': { currentBranch: null, headSha: null, detached: false } },
      gitDirKindByPath: { '/main': 'directory' },
      okProjectRoots: new Set(['/main']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/main');
    }
  });

  test('prunable worktree-enum entry on the share branch is NOT selected', async () => {
    // A prunable worktree (stale gitdir pointer, dir still on disk) reports a
    // matching `branch` via porcelain and would strict-match the share
    // branch — but git considers it dead, so selecting it fails later in
    // bridge.open.
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          // Prunable AND on the share branch — must be excluded.
          worktreeEntry({ path: '/wt/stale', branch: 'feat-bar', prunable: true }),
          // Healthy candidate on the share branch — should win.
          worktreeEntry({ path: '/wt/live', branch: 'feat-bar' }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: {
        '/main': 'directory',
        '/wt/stale': 'linked',
        '/wt/live': 'linked',
      },
      okProjectRoots: new Set(['/main', '/wt/stale', '/wt/live']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      // The prunable /wt/stale was excluded; the healthy /wt/live wins.
      expect(result.candidate.path).toBe('/wt/live');
    }
  });

  test('prunable is the ONLY branch match → falls through to fallback (not selected)', async () => {
    // With the prunable entry excluded, no candidate's HEAD matches the
    // share branch — selection routes to fallback (main checkout) rather
    // than dispatching onto the dead worktree.
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/stale', branch: 'feat-bar', prunable: true }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory', '/wt/stale': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/stale']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.anchor.path).toBe('/main');
      expect(result.reason).toBe('main-checkout');
    }
  });

  test('locked (but not prunable) worktree on the share branch is still selected', async () => {
    // Guard against over-filtering: the prunable skip must NOT catch locked
    // worktrees. A locked worktree on the share branch remains a first-class
    // candidate and wins on branch match.
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/locked', branch: 'feat-bar', locked: true, prunable: false }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory', '/wt/locked': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/locked']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      expect(result.candidate.path).toBe('/wt/locked');
      expect(result.candidate.locked).toBe(true);
    }
  });

  test('Recents /var path collapses onto worktree-enum /private/var via realpath (one candidate)', async () => {
    // macOS symlink case: a Recents entry stored as the user opened it
    // (`/var/folders/.../wt`) and a worktree-enum entry git emits
    // realpath-collapsed (`/private/var/folders/.../wt`) are the SAME
    // physical dir. Canonicalizing the Recents path through bridge.realpath
    // makes them collapse to ONE Candidate.
    const varPath = '/var/folders/abc/wt';
    const privateVarPath = '/private/var/folders/abc/wt';
    const main = recent({ path: varPath });
    const bridge = makeBridge({
      recents: [main],
      realpathByPath: { [varPath]: privateVarPath },
      worktreesByAnchor: {
        // listGitWorktrees is anchored on the RAW Recents path (the anchor is
        // selected before realpath collapse); git emits the realpath-collapsed
        // /private/var spelling for the entry itself.
        [varPath]: [worktreeEntry({ path: privateVarPath, branch: 'feat-bar' })],
      },
      headsByPath: { [privateVarPath]: head('feat-bar') },
      gitDirKindByPath: { [privateVarPath]: 'linked' },
      okProjectRoots: new Set([privateVarPath]),
    });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let result: CandidateSelection;
    try {
      result = await selectCandidate(PAYLOAD, bridge);
    } finally {
      console.warn = origWarn;
    }
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      // The single physical dir surfaces once — no spurious second row.
      expect(result.candidate.path).toBe(privateVarPath);
      // multiCandidate must be false: only one candidate exists after collapse.
      expect(result.multiCandidate).toBe(false);
    }
    // No ambiguous-branch-match diagnostic — the collapse means a single match.
    expect(warnings.some((w) => w.includes('q1_ambiguous_branch_match'))).toBe(false);
  });

  test('tiebreak: identical recencyIndex falls through to path lex (stable)', async () => {
    // Both candidates from worktree-enum (no Recents recency) with the
    // same branch match. Sorted by worktreeOrder (b comes before a → /wt/b wins).
    const main = recent({ path: '/main' });
    const bridge = makeBridge({
      recents: [main],
      worktreesByAnchor: {
        '/main': [
          worktreeEntry({ path: '/main', branch: 'main' }),
          worktreeEntry({ path: '/wt/b', branch: 'feat-bar' }),
          worktreeEntry({ path: '/wt/a', branch: 'feat-bar' }),
        ],
      },
      headsByPath: { '/main': head('main') },
      gitDirKindByPath: { '/main': 'directory', '/wt/a': 'linked', '/wt/b': 'linked' },
      okProjectRoots: new Set(['/main', '/wt/a', '/wt/b']),
    });
    const result = await selectCandidate(PAYLOAD, bridge);
    expect(result.kind).toBe('branch-match-ok');
    if (result.kind === 'branch-match-ok') {
      // /wt/b has worktreeOrder=1, /wt/a has worktreeOrder=2 → /wt/b wins.
      expect(result.candidate.path).toBe('/wt/b');
    }
  });
});

// satisfies-style compile check that the public types are exposed
const _typeChecks: { c: Candidate; s: CandidateSelection } | null = null;
void _typeChecks;
