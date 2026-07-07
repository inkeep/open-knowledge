/**
 * Real-git test substrate for the share freshness (send) and target-status
 * (receive) paths: a sender working tree, a bare origin, and a lazily-cloned
 * receiver, driven through the actual `git` binary.
 *
 * Every git call goes through synchronous `execFileSync`. The async
 * `simple-git`-based sibling fixture (`setupDivergence` in
 * `sync-engine.test.ts`) is skipped on CI because Bun fails to reap async git
 * children on the GHA ubuntu runners (oven-sh/bun#11892); a synchronous
 * subprocess never leaves a child for Bun to reap, so a triangle built this way
 * runs unskipped in the default test tier — the whole point of this helper.
 *
 * The primitives are deliberately small and compose into the freshness drift
 * cells rather than enumerating one method per cell:
 *   - `seedAndPush`         -> the target is on origin and clean (current)
 *   - `writeWorkingTree`    -> unstaged write: a NEW path is absent; overwriting
 *                              a seeded path (or adding a file under a seeded
 *                              folder) is stale
 *   - `commitWithoutPush`   -> a seeded path edited + committed but not pushed
 *                              is stale (origin keeps the old blob)
 * and the receive-side legs (`renameOnOrigin` / `renameFolderOnOrigin` /
 * `deleteOnOrigin`) advance origin so a receiver clone observes the move.
 * `deleteInReceiverWorkingTree` / `renameInReceiverWorkingTree` mutate the
 * receiver's OWN working tree WITHOUT committing — the local-change case a miss
 * verdict must read as `changed-locally`, not "behind — pull".
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface GitTriangle {
  readonly senderDir: string;
  readonly originDir: string;
  readonly branch: string;
  /** Run git in an arbitrary repo dir; returns trimmed stdout, throws on non-zero exit. */
  git(cwd: string, args: string[]): string;
  /** Sender: write + stage + commit + push. The target lands on origin, clean. */
  seedAndPush(relPath: string, content: string): void;
  /**
   * Sender: seed a symlink (`linkRel` -> `targetRel`) plus its target, then
   * push both. The link is stored as a symlink blob (mode 120000), the state a
   * freshness probe must read as `current` when only the link is shared.
   */
  seedSymlinkAndPush(linkRel: string, targetRel: string, targetContent: string): void;
  /**
   * Sender: write to the working tree WITHOUT staging. A path never seeded is
   * absent from origin; overwriting a seeded path, or adding a file beneath a
   * seeded folder, is stale.
   */
  writeWorkingTree(relPath: string, content: string): void;
  /** Sender: overwrite + commit a seeded path but do NOT push (origin keeps the old blob). */
  commitWithoutPush(relPath: string, content: string): void;
  /** Sender -> origin: `git mv` a file + commit + push (origin gains `newRel`, loses `oldRel`). */
  renameOnOrigin(oldRel: string, newRel: string): void;
  /** Sender -> origin: `git mv` a whole folder + commit + push. */
  renameFolderOnOrigin(oldFolderRel: string, newFolderRel: string): void;
  /**
   * Sender -> origin: introduce a rename as part of a MERGE commit (an "evil
   * merge") so `git log -1 -- <oldRel>` returns the merge itself. The merge's
   * bare `diff-tree` is combined-format; this exercises the first-parent diff
   * that keeps the rename readable instead of misclassifying it as deleted.
   */
  mergeRenameOnOrigin(oldRel: string, newRel: string): void;
  /**
   * Sender -> origin: `git mv` several files to DIFFERENT destinations in ONE
   * commit + push. Used to reproduce a split-folder rename (files under one
   * prefix scatter to multiple new prefixes) so the removing commit's diff
   * carries R rows with inconsistent destinations.
   */
  splitRenameOnOrigin(pairs: ReadonlyArray<readonly [string, string]>): void;
  /** Sender -> origin: `git rm` + commit + push. */
  deleteOnOrigin(relPath: string): void;
  /**
   * Receiver working tree: delete a tracked path WITHOUT committing (a local
   * `rm`). The path stays in the receiver's committed HEAD but vanishes from the
   * working tree — the "changed locally" case a share-receive miss must NOT
   * report as "behind — pull". Requires `cloneReceiver()` first.
   */
  deleteInReceiverWorkingTree(relPath: string): void;
  /**
   * Receiver working tree: rename a tracked path WITHOUT committing (a local
   * `mv`). Like `deleteInReceiverWorkingTree`, the OLD path is gone from the
   * working tree but still in HEAD, so a miss on the old path is
   * `changed-locally`. Requires `cloneReceiver()` first.
   */
  renameInReceiverWorkingTree(oldRel: string, newRel: string): void;
  /** Clone origin into a fresh receiver dir (idempotent; returns the same dir on repeat). */
  cloneReceiver(): string;
  /** Remove every temp repo this triangle created. */
  cleanup(): void;
}

export function createGitTriangle(opts: { branch?: string } = {}): GitTriangle {
  const branch = opts.branch ?? 'main';
  const senderDir = mkdtempSync(join(tmpdir(), 'ok-share-sender-'));
  const originDir = mkdtempSync(join(tmpdir(), 'ok-share-origin-'));
  let receiverDir: string | null = null;

  const git = (cwd: string, args: string[]): string =>
    // Capture stderr (push/clone progress) instead of inheriting it, so a
    // passing run leaves the test log clean; a failure still surfaces it on the
    // thrown error's `.stderr`.
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  const configure = (dir: string): void => {
    git(dir, ['config', 'user.name', 'Fixture User']);
    git(dir, ['config', 'user.email', 'fixture@example.com']);
    // gpg signing from a host/global config would make commits fail in the fixture.
    git(dir, ['config', 'commit.gpgsign', 'false']);
  };

  const writeFile = (dir: string, relPath: string, content: string): void => {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  };

  const commitPush = (relPaths: string[], message: string): void => {
    git(senderDir, ['add', '--', ...relPaths]);
    git(senderDir, ['commit', '-m', message]);
    git(senderDir, ['push', 'origin', branch]);
  };

  // Bare origin + sender with one base commit so origin/<branch> exists and the
  // branch-on-origin gate upstream of every probe passes.
  git(originDir, ['init', '--bare', '-b', branch]);
  git(senderDir, ['init', '-b', branch]);
  configure(senderDir);
  writeFile(senderDir, '.ok/config.yml', '');
  writeFile(senderDir, 'README.md', '# base\n');
  git(senderDir, ['add', '-A']);
  git(senderDir, ['commit', '-m', 'seed base']);
  git(senderDir, ['remote', 'add', 'origin', originDir]);
  git(senderDir, ['push', '--set-upstream', 'origin', branch]);

  return {
    senderDir,
    originDir,
    branch,
    git,
    seedAndPush(relPath, content) {
      writeFile(senderDir, relPath, content);
      commitPush([relPath], `seed ${relPath}`);
    },
    seedSymlinkAndPush(linkRel, targetRel, targetContent) {
      writeFile(senderDir, targetRel, targetContent);
      const linkAbs = join(senderDir, linkRel);
      mkdirSync(dirname(linkAbs), { recursive: true });
      // Relative target so the symlink resolves regardless of where the tmp
      // repo lives, and git stores the link-target string verbatim.
      symlinkSync(relative(dirname(linkAbs), join(senderDir, targetRel)), linkAbs);
      commitPush([targetRel, linkRel], `seed symlink ${linkRel}`);
    },
    writeWorkingTree(relPath, content) {
      writeFile(senderDir, relPath, content);
    },
    commitWithoutPush(relPath, content) {
      writeFile(senderDir, relPath, content);
      git(senderDir, ['add', '--', relPath]);
      git(senderDir, ['commit', '-m', `edit ${relPath} (unpushed)`]);
    },
    renameOnOrigin(oldRel, newRel) {
      mkdirSync(dirname(join(senderDir, newRel)), { recursive: true });
      git(senderDir, ['mv', oldRel, newRel]);
      git(senderDir, ['commit', '-m', `rename ${oldRel} -> ${newRel}`]);
      git(senderDir, ['push', 'origin', branch]);
    },
    renameFolderOnOrigin(oldFolderRel, newFolderRel) {
      mkdirSync(dirname(join(senderDir, newFolderRel)), { recursive: true });
      git(senderDir, ['mv', oldFolderRel, newFolderRel]);
      git(senderDir, ['commit', '-m', `rename folder ${oldFolderRel} -> ${newFolderRel}`]);
      git(senderDir, ['push', 'origin', branch]);
    },
    mergeRenameOnOrigin(oldRel, newRel) {
      // Side branch gets an unrelated commit so the merge can't fast-forward.
      git(senderDir, ['checkout', '-b', 'ok-merge-side']);
      writeFile(senderDir, 'SIDE.md', '# side\n');
      git(senderDir, ['add', '--', 'SIDE.md']);
      git(senderDir, ['commit', '-m', 'side: unrelated change']);
      // Main also diverges, forcing a real (--no-ff) merge commit.
      git(senderDir, ['checkout', branch]);
      writeFile(senderDir, 'MAIN.md', '# main\n');
      git(senderDir, ['add', '--', 'MAIN.md']);
      git(senderDir, ['commit', '-m', 'main: unrelated change']);
      // Stage the merge, then rename the shared path INSIDE the merge before
      // committing: the rename belongs to the merge commit, not either parent,
      // so history simplification returns the merge for `git log -- <oldRel>`.
      git(senderDir, ['merge', '--no-ff', '--no-commit', 'ok-merge-side']);
      mkdirSync(dirname(join(senderDir, newRel)), { recursive: true });
      git(senderDir, ['mv', oldRel, newRel]);
      git(senderDir, ['commit', '--no-edit']);
      git(senderDir, ['push', 'origin', branch]);
    },
    splitRenameOnOrigin(pairs) {
      for (const [oldRel, newRel] of pairs) {
        mkdirSync(dirname(join(senderDir, newRel)), { recursive: true });
        git(senderDir, ['mv', oldRel, newRel]);
      }
      git(senderDir, ['commit', '-m', `split rename ${pairs.map(([o]) => o).join(', ')}`]);
      git(senderDir, ['push', 'origin', branch]);
    },
    deleteOnOrigin(relPath) {
      git(senderDir, ['rm', '--', relPath]);
      git(senderDir, ['commit', '-m', `delete ${relPath}`]);
      git(senderDir, ['push', 'origin', branch]);
    },
    deleteInReceiverWorkingTree(relPath) {
      if (!receiverDir)
        throw new Error('cloneReceiver() must run before deleteInReceiverWorkingTree');
      rmSync(join(receiverDir, relPath), { force: true });
    },
    renameInReceiverWorkingTree(oldRel, newRel) {
      if (!receiverDir)
        throw new Error('cloneReceiver() must run before renameInReceiverWorkingTree');
      mkdirSync(dirname(join(receiverDir, newRel)), { recursive: true });
      renameSync(join(receiverDir, oldRel), join(receiverDir, newRel));
    },
    cloneReceiver() {
      if (receiverDir) return receiverDir;
      const dir = mkdtempSync(join(tmpdir(), 'ok-share-receiver-'));
      git(dir, ['clone', originDir, '.']);
      configure(dir);
      receiverDir = dir;
      return dir;
    },
    cleanup() {
      rmSync(senderDir, { recursive: true, force: true });
      rmSync(originDir, { recursive: true, force: true });
      if (receiverDir) rmSync(receiverDir, { recursive: true, force: true });
    },
  };
}
