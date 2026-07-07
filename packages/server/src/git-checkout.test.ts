import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  fastForwardBranchToOrigin,
  isBranchInOtherWorktreeError,
  isBranchNotFoundFetchError,
  runCheckoutFlow,
} from './git-checkout.ts';
import { createGitInstance } from './git-handle.ts';
import { createGitTriangle, type GitTriangle } from './share/git-fixture.test-helper.ts';

const execFileAsync = promisify(execFile);

describe('isBranchNotFoundFetchError', () => {
  test('matches the lowercase "couldn\'t find remote ref" message', () => {
    expect(
      isBranchNotFoundFetchError(
        new Error("fatal: couldn't find remote ref refs/heads/feat/missing"),
      ),
    ).toBe(true);
  });

  test('matches the capitalized "Couldn\'t find remote ref" message', () => {
    expect(
      isBranchNotFoundFetchError(
        new Error("fatal: Couldn't find remote ref refs/heads/feat/missing"),
      ),
    ).toBe(true);
  });

  test('matches the older "Remote branch X not found" format', () => {
    expect(
      isBranchNotFoundFetchError(
        new Error('Remote branch missing-branch not found in upstream origin'),
      ),
    ).toBe(true);
  });

  test('rejects unrelated fetch failures (network unreachable)', () => {
    expect(
      isBranchNotFoundFetchError(
        new Error('fatal: unable to access https://example.com: Could not resolve host'),
      ),
    ).toBe(false);
  });

  test('rejects auth-denied failures', () => {
    expect(
      isBranchNotFoundFetchError(new Error('fatal: Authentication failed for https://example.com')),
    ).toBe(false);
  });

  test('rejects a French-locale translation of the branch-not-found message', () => {
    // Without LANG=C/LC_ALL=C on the git env, a receiver on a non-English
    // host locale would see a translated stderr and the classifier would
    // fall through to `fetch-failed`. `createGitInstance` pins LANG=C so
    // git always emits the English variants above; the regex stays narrow.
    expect(
      isBranchNotFoundFetchError(
        new Error("fatal: n'a pas pu trouver de référence distante refs/heads/missing"),
      ),
    ).toBe(false);
    expect(
      isBranchNotFoundFetchError(
        new Error('fatal: konnte Remote-Referenz refs/heads/missing nicht finden'),
      ),
    ).toBe(false);
  });

  test('handles non-Error throwables', () => {
    expect(isBranchNotFoundFetchError("couldn't find remote ref refs/heads/x")).toBe(true);
    expect(isBranchNotFoundFetchError('random string')).toBe(false);
    expect(isBranchNotFoundFetchError(null)).toBe(false);
    expect(isBranchNotFoundFetchError(undefined)).toBe(false);
  });
});

describe('createGitInstance locale stabilization', () => {
  // The classifier above is English-anchored. The fix that makes it work
  // across host locales is the LANG/LC_ALL env on every spawned git
  // process — pin both here so a future refactor doesn't drop them.
  // simple-git's public surface shadows the env getter with the env setter
  // method; we read the underlying executor's stored env to assert the
  // spawned-process environment.
  function readEnv(handle: ReturnType<typeof createGitInstance>): Record<string, string> {
    // biome-ignore lint/suspicious/noExplicitAny: probing internal simple-git executor for spawn-env assertion
    return ((handle.git as any)._executor?.env ?? {}) as Record<string, string>;
  }

  test('spawns git with LANG=C and LC_ALL=C so stderr stays English', () => {
    const handle = createGitInstance('/tmp');
    const env = readEnv(handle);
    expect(env.LANG).toBe('C');
    expect(env.LC_ALL).toBe('C');
  });

  test('preserves LANG/LC_ALL when GIT_INDEX_FILE is set', () => {
    const handle = createGitInstance('/tmp', { gitIndexFile: '.git/custom-index' });
    const env = readEnv(handle);
    expect(env.LANG).toBe('C');
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_INDEX_FILE).toBe('/tmp/.git/custom-index');
  });
});

describe('isBranchInOtherWorktreeError', () => {
  test('matches the canonical git stderr signature', () => {
    const result = isBranchInOtherWorktreeError(
      new Error("fatal: 'feat-bar' is already checked out at '/Users/.../wt/feat-bar'"),
    );
    expect(result).toEqual({ held: true, path: '/Users/.../wt/feat-bar' });
  });

  test('matches the newer "used by worktree at" phrasing (git version skew, e.g. Linux CI)', () => {
    // Older git (macOS system git) says "is already checked out at"; newer git
    // (Linux CI image) says "is already used by worktree at". Both must yield
    // the typed branch-in-other-worktree outcome — matching only the former
    // silently degrades to checkout-failed on newer git.
    const result = isBranchInOtherWorktreeError(
      new Error("fatal: 'feat-bar' is already used by worktree at '/tmp/x/wt-feat-bar'"),
    );
    expect(result).toEqual({ held: true, path: '/tmp/x/wt-feat-bar' });
  });

  test('matches slashed branch names like feat/foo/bar (FR11)', () => {
    const result = isBranchInOtherWorktreeError(
      new Error("fatal: 'feat/foo/bar' is already checked out at '/tmp/wt'"),
    );
    expect(result).toEqual({ held: true, path: '/tmp/wt' });
  });

  test('matches paths with spaces in them', () => {
    const result = isBranchInOtherWorktreeError(
      new Error("fatal: 'feat' is already checked out at '/Users/Me/My Repo/wt'"),
    );
    expect(result).toEqual({ held: true, path: '/Users/Me/My Repo/wt' });
  });

  test('truncates a path containing an apostrophe at the first inner quote (known limitation)', () => {
    // The quote-bounded `[^']+` capture stops at the apostrophe inside the
    // path, so the captured path is truncated. This is the documented degrade:
    // realpath then fails (or resolves elsewhere) and the raw truncated path is
    // surfaced. Pinned so a future end-anchor "fix" — which would force a clean
    // miss here but break ordinary paths when git appends a `hint:` line — is a
    // conscious change, not an accident.
    const result = isBranchInOtherWorktreeError(
      new Error("fatal: 'feat' is already checked out at '/Users/me/it's-fine/wt'"),
    );
    expect(result).toEqual({ held: true, path: '/Users/me/it' });
  });

  test('returns held:false on a non-matching error message (fall-through to checkout-failed)', () => {
    expect(isBranchInOtherWorktreeError(new Error('Permission denied'))).toEqual({
      held: false,
    });
  });

  test('returns held:false on the dirty-tree git error', () => {
    expect(
      isBranchInOtherWorktreeError(
        new Error('error: Your local changes to the following files would be overwritten'),
      ),
    ).toEqual({ held: false });
  });

  test('returns held:false on a non-Error throwable', () => {
    expect(isBranchInOtherWorktreeError({ stderr: 'something' })).toEqual({ held: false });
    expect(isBranchInOtherWorktreeError(null)).toEqual({ held: false });
    expect(isBranchInOtherWorktreeError(undefined)).toEqual({ held: false });
  });

  test('returns held:false on empty path between quotes (defensive)', () => {
    expect(
      isBranchInOtherWorktreeError(new Error("fatal: 'feat' is already checked out at ''")),
    ).toEqual({ held: false });
  });
});

describe('runCheckoutFlow against real git', () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  }

  test('returns branch-in-other-worktree with otherWorktreePath when the branch is held in a linked worktree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-bow-')));
    try {
      const main = join(root, 'main');
      mkdirSync(main);
      await git(main, 'init', '--initial-branch=main', '.');
      await git(main, 'config', 'user.email', 'test@example.com');
      await git(main, 'config', 'user.name', 'Test');
      writeFileSync(join(main, 'README.md'), '# main\n');
      await git(main, 'add', 'README.md');
      await git(main, 'commit', '-m', 'initial');
      // Create feat-bar on a linked worktree; main is on `main`.
      const wt = join(root, 'wt-feat-bar');
      await git(main, 'worktree', 'add', '-b', 'feat-bar', wt);

      // Now attempt to check out feat-bar from main — git refuses.
      const outcome = await runCheckoutFlow(main, 'feat-bar');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('branch-in-other-worktree');
        expect(outcome.otherWorktreePath).toBe(wt);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns ok:true on a happy-path checkout (no regression)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-ok-')));
    try {
      const main = root;
      await git(main, 'init', '--initial-branch=main', '.');
      await git(main, 'config', 'user.email', 'test@example.com');
      await git(main, 'config', 'user.name', 'Test');
      writeFileSync(join(main, 'README.md'), '# main\n');
      await git(main, 'add', 'README.md');
      await git(main, 'commit', '-m', 'initial');
      await git(main, 'branch', 'feat-bar');

      const outcome = await runCheckoutFlow(main, 'feat-bar');
      expect(outcome.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fastForwardBranchToOrigin (FR9 FF-only pre-checkout update)', () => {
  const triangles: GitTriangle[] = [];
  function newTriangle(): GitTriangle {
    const t = createGitTriangle();
    triangles.push(t);
    return t;
  }
  afterEach(() => {
    for (const t of triangles.splice(0)) t.cleanup();
  });

  // Push a `feature` branch to origin, then create a LOCAL feature ref on the
  // receiver pointing at origin's initial tip — WITHOUT checking it out (the
  // receiver stays on main, so the FF must never touch the working tree).
  function setupReceiverWithLocalFeature(t: GitTriangle): string {
    t.git(t.senderDir, ['checkout', '-b', 'feature']);
    writeFileSync(join(t.senderDir, 'feat.md'), '# v1\n', 'utf-8');
    t.git(t.senderDir, ['add', '-A']);
    t.git(t.senderDir, ['commit', '-m', 'feature v1']);
    t.git(t.senderDir, ['push', 'origin', 'feature']);
    t.git(t.senderDir, ['checkout', 'main']);
    const receiver = t.cloneReceiver();
    t.git(receiver, ['branch', 'feature', 'origin/feature']);
    return receiver;
  }

  function advanceOriginFeature(t: GitTriangle): void {
    t.git(t.senderDir, ['checkout', 'feature']);
    writeFileSync(join(t.senderDir, 'feat.md'), '# v2\n', 'utf-8');
    t.git(t.senderDir, ['add', '-A']);
    t.git(t.senderDir, ['commit', '-m', 'feature v2']);
    t.git(t.senderDir, ['push', 'origin', 'feature']);
    t.git(t.senderDir, ['checkout', 'main']);
  }

  test('fast-forwardable: the local branch advances to origin, working tree untouched', async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    advanceOriginFeature(t);

    const outcome = await fastForwardBranchToOrigin(receiver, 'feature');
    expect(outcome).toBe('advanced');
    // The local feature ref now points at origin's advanced tip.
    expect(t.git(receiver, ['rev-parse', 'refs/heads/feature'])).toBe(
      t.git(receiver, ['rev-parse', 'refs/remotes/origin/feature']),
    );
    // The receiver never left main — the FF is a pure ref move.
    expect(t.git(receiver, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  test('diverged: refused, the local ref is untouched, no merge', async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    // Receiver commits its own change on feature, diverging its local history.
    t.git(receiver, ['checkout', 'feature']);
    writeFileSync(join(receiver, 'feat.md'), '# receiver-only change\n', 'utf-8');
    t.git(receiver, ['add', '-A']);
    t.git(receiver, ['commit', '-m', 'receiver diverging commit']);
    t.git(receiver, ['checkout', 'main']);
    const localBefore = t.git(receiver, ['rev-parse', 'refs/heads/feature']);
    advanceOriginFeature(t);

    const outcome = await fastForwardBranchToOrigin(receiver, 'feature');
    expect(outcome).toBe('diverged');
    // Nothing mutated — the divergent local ref stands, untouched.
    expect(t.git(receiver, ['rev-parse', 'refs/heads/feature'])).toBe(localBefore);
  });

  test('already up to date: local branch equals origin, no-op', async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    const outcome = await fastForwardBranchToOrigin(receiver, 'feature');
    expect(outcome).toBe('up-to-date');
  });

  test('branch not local yet: up-to-date (checkout creates it at origin tip)', async () => {
    const t = newTriangle();
    t.git(t.senderDir, ['checkout', '-b', 'feature']);
    writeFileSync(join(t.senderDir, 'feat.md'), '# v1\n', 'utf-8');
    t.git(t.senderDir, ['add', '-A']);
    t.git(t.senderDir, ['commit', '-m', 'feature v1']);
    t.git(t.senderDir, ['push', 'origin', 'feature']);
    t.git(t.senderDir, ['checkout', 'main']);
    const receiver = t.cloneReceiver();
    const outcome = await fastForwardBranchToOrigin(receiver, 'feature');
    expect(outcome).toBe('up-to-date');
  });

  test('offline: the fetch fails, unavailable, nothing mutated', async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    const localBefore = t.git(receiver, ['rev-parse', 'refs/heads/feature']);
    t.git(receiver, ['remote', 'remove', 'origin']);
    const outcome = await fastForwardBranchToOrigin(receiver, 'feature');
    expect(outcome).toBe('unavailable');
    expect(t.git(receiver, ['rev-parse', 'refs/heads/feature'])).toBe(localBefore);
  });

  test("fastForward:true lands the checkout on origin's advanced tip with the fresh doc", async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    advanceOriginFeature(t);

    const outcome = await runCheckoutFlow(receiver, 'feature', { fastForward: true });
    expect(outcome.ok).toBe(true);
    // HEAD switched to feature AND the working tree carries origin's v2 — the
    // FF advanced the stale local ref before the checkout landed on it.
    expect(t.git(receiver, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature');
    expect(readFileSync(join(receiver, 'feat.md'), 'utf-8')).toBe('# v2\n');
  });

  test('fastForward:true on a diverged branch returns ff-diverged and never checks out', async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    t.git(receiver, ['checkout', 'feature']);
    writeFileSync(join(receiver, 'feat.md'), '# receiver-only change\n', 'utf-8');
    t.git(receiver, ['add', '-A']);
    t.git(receiver, ['commit', '-m', 'receiver diverging commit']);
    t.git(receiver, ['checkout', 'main']);
    advanceOriginFeature(t);

    const outcome = await runCheckoutFlow(receiver, 'feature', { fastForward: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ff-diverged');
    // Checkout was NOT attempted — the receiver is still on main.
    expect(t.git(receiver, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  test('fastForward omitted does NOT advance the ref (plain checkout lands on the stale local tip)', async () => {
    const t = newTriangle();
    const receiver = setupReceiverWithLocalFeature(t);
    advanceOriginFeature(t);

    const outcome = await runCheckoutFlow(receiver, 'feature');
    expect(outcome.ok).toBe(true);
    // Without the flag the branch is not fast-forwarded, so the checkout lands
    // on the receiver's stale local tip (v1), not origin's v2.
    expect(readFileSync(join(receiver, 'feat.md'), 'utf-8')).toBe('# v1\n');
  });
});
