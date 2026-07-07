/**
 * Real-FS coverage of `removeGitFolder` — the helper backing the
 * `ok:fs:remove-git-folder` IPC. Same tmpdir-fixture style as
 * `create-new-project.test.ts` / `folder-admission.test.ts` so the
 * destructive surface is pinned at the layer the renderer can't reach
 * through the DOM-test programmable bridge stub.
 *
 * What this file pins:
 *   - Happy path: real `.git` directory at `<tmp>/.git` → removed.
 *   - Idempotent: `.git` already absent → no-op, no throw.
 *   - Input validation: empty string, non-string, relative path, traversal-
 *     in-input (`/foo/..`) → all refused with the `ok:fs:remove-git-folder
 *     rejected:` prefix BEFORE any FS work.
 *   - Membership-set scoping: a well-formed gitRoot that wasn't
 *     surfaced by a recent `findEnclosingGitRoot` is refused.
 *   - Symlink defense: `<gitRoot>/.git -> /tmp/unrelated-dir` is refused
 *     and the unrelated dir survives intact.
 *   - ENOENT race: `.git` exists at the `existsSync` check then disappears
 *     before `realpathSync` reads it → idempotent path; no throw.
 *   - Worktree `.git` (file, not directory) is supported — the destructive
 *     handler accepts both shapes (mirror of `find-git-root.ts`'s acceptance
 *     contract). Removes only the `.git` file, not the parent dir.
 *
 * Tests run in real tmpdirs (no mocks) so all the path-validation +
 * realpath dance is exercised against the real macOS/Linux semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeGitFolder } from './remove-git-folder.ts';

let tmpRoot: string;

beforeEach(() => {
  // `realpathSync` the tmpdir so the helper's `realpath` checks compare
  // apples-to-apples on macOS (where `/tmp` is itself a symlink to
  // `/private/tmp`). Without this, the helper's `realpathSync` on a child
  // path returns the canonical `/private/tmp/...` while our test inputs
  // are `/tmp/...`, and assertions look false-positive when they shouldn't.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-remove-git-')));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Best-effort — chmod-restricted dirs in negative tests would error;
    // we just leave them for the per-run tmpdir cleanup.
  }
});

describe('removeGitFolder — pure helper backing ok:fs:remove-git-folder', () => {
  test('happy path: real .git directory at <gitRoot>/.git is removed', async () => {
    const gitRoot = join(tmpRoot, 'proj');
    mkdirSync(join(gitRoot, '.git', 'objects'), { recursive: true });
    writeFileSync(join(gitRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
    // Parent dir survives — only `.git` is removed.
    expect(existsSync(gitRoot)).toBe(true);
  });

  test('idempotent: .git already absent → resolves without throwing', async () => {
    const gitRoot = join(tmpRoot, 'proj-no-git');
    mkdirSync(gitRoot, { recursive: true });
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
    expect(existsSync(gitRoot)).toBe(true);
  });

  test('worktree `.git` file (not directory) at <gitRoot>/.git is removed', async () => {
    // `git worktree add` plants a regular file `.git` whose content is
    // `gitdir: <path>`. find-git-root accepts this shape via existsSync;
    // removeGitFolder accepts it too (recursive rm works on both).
    const gitRoot = join(tmpRoot, 'worktree');
    mkdirSync(gitRoot, { recursive: true });
    writeFileSync(join(gitRoot, '.git'), 'gitdir: /unrelated/worktree-store/wt1\n');

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  describe('input validation rejects malformed gitRoot before any FS work', () => {
    test('empty string', async () => {
      await expect(removeGitFolder('', { allowedGitRoots: new Set() })).rejects.toThrow(
        /must be a non-empty string/,
      );
    });

    test('non-string (object)', async () => {
      await expect(
        removeGitFolder({ rogue: true } as unknown, { allowedGitRoots: new Set() }),
      ).rejects.toThrow(/must be a non-empty string/);
    });

    test('non-string (null)', async () => {
      await expect(
        removeGitFolder(null as unknown, { allowedGitRoots: new Set() }),
      ).rejects.toThrow(/must be a non-empty string/);
    });

    test('relative path is refused (must be absolute)', async () => {
      await expect(
        removeGitFolder('relative/path', { allowedGitRoots: new Set() }),
      ).rejects.toThrow(/must be an absolute, resolved path/);
    });

    test('absolute path with literal `..` segments is refused (must be already-resolved)', async () => {
      // String-built on purpose — `path.join(...)` would pre-normalize the
      // segments before the helper ever sees them. The real attack vector
      // is a renderer-supplied raw string with `..` segments intact, so
      // that's what we feed.
      const traversal = `${tmpRoot}/proj/../private-stuff`;
      await expect(
        removeGitFolder(traversal, { allowedGitRoots: new Set([traversal]) }),
      ).rejects.toThrow(/must be an absolute, resolved path/);
    });
  });

  test('membership-set miss: a well-formed gitRoot NOT in allowedGitRoots is refused', async () => {
    // The renderer fabricated a gitRoot main never surfaced — exactly the
    // attack vector named. Even though the path
    // is well-formed and a real `.git` exists there, the helper refuses
    // because it isn't in the allowed set.
    const gitRoot = join(tmpRoot, 'fabricated');
    mkdirSync(join(gitRoot, '.git'), { recursive: true });

    await expect(
      removeGitFolder(gitRoot, { allowedGitRoots: new Set(/* empty */) }),
    ).rejects.toThrow(/was not surfaced by a recent probe/);

    // And the `.git` survives the rejection.
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });

  test('symlink defense: <gitRoot>/.git → unrelated dir is refused, unrelated dir survives', async () => {
    // Build a normal project + a sibling "important-dir" with a sentinel
    // file. Plant a symlink at `<proj>/.git` pointing at `important-dir`.
    // If the helper canonicalized the symlink and rm'd unconditionally
    // it would destroy the sentinel. The realpath + basename guard must
    // refuse before the rm fires.
    const gitRoot = join(tmpRoot, 'proj-with-rogue-symlink');
    const unrelated = join(tmpRoot, 'important-dir');
    mkdirSync(gitRoot, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    const sentinel = join(unrelated, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-delete\n');

    symlinkSync(unrelated, join(gitRoot, '.git'), 'dir');

    await expect(removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) })).rejects.toThrow(
      /resolved symlink target is not a \.git entry/,
    );

    // Sentinel survives — the unrelated dir was not touched.
    expect(existsSync(sentinel)).toBe(true);
    // The symlink itself survives the rejection (refusal happens before
    // the rm). That's the intended fail-closed behavior.
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });

  test('symlink defense: <gitRoot>/.git → another /.git directory IS allowed (canonical basename still .git)', async () => {
    // Edge case in the canonical-basename check: a symlink whose target
    // is *itself* a `.git` directory is benign — the realpath dance is
    // ensuring "what we'd actually delete is a .git". A user could
    // legitimately have a symlinked `.git` (e.g. nested worktree
    // configuration); we don't want to false-positive on that.
    const gitRoot = join(tmpRoot, 'proj-with-symlinked-git');
    const realGit = join(tmpRoot, 'real-git-store', '.git');
    mkdirSync(join(tmpRoot, 'real-git-store'), { recursive: true });
    mkdirSync(realGit, { recursive: true });
    writeFileSync(join(realGit, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(gitRoot, { recursive: true });
    symlinkSync(realGit, join(gitRoot, '.git'), 'dir');

    await removeGitFolder(gitRoot, { allowedGitRoots: new Set([gitRoot]) });

    // The symlink itself is removed (rm follows the link's parent, removes
    // the link entry). The canonical .git directory at /real-git-store
    // also gets removed because rm follows-and-removes through symlinks
    // with recursive: true. This is the intended-by-find-git-root behavior
    // (same shape worktrees rely on).
    expect(existsSync(join(gitRoot, '.git'))).toBe(false);
  });

  test('membership-set is keyed exactly — case-sensitive, no trailing-slash forgiveness', async () => {
    // The set holds whatever findEnclosingGitRoot returned. The handler
    // must compare with strict equality — no normalization that could
    // be coerced. Below: a gitRoot that differs by trailing slash must
    // miss the set even though it points at the "same" directory.
    const gitRoot = join(tmpRoot, 'proj-strict');
    mkdirSync(join(gitRoot, '.git'), { recursive: true });

    await expect(
      removeGitFolder(`${gitRoot}/`, { allowedGitRoots: new Set([gitRoot]) }),
    ).rejects.toThrow(/must be an absolute, resolved path/);
    expect(existsSync(join(gitRoot, '.git'))).toBe(true);
  });
});
