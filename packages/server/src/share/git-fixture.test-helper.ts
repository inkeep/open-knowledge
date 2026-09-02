import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface GitTriangle {
  readonly senderDir: string;
  readonly originDir: string;
  readonly branch: string;
  git(cwd: string, args: string[]): string;
  seedAndPush(relPath: string, content: string): void;
  seedSymlinkAndPush(linkRel: string, targetRel: string, targetContent: string): void;
  writeWorkingTree(relPath: string, content: string): void;
  mkdirWorkingTree(relPath: string): void;
  commitWithoutPush(relPath: string, content: string): void;
  renameOnOrigin(oldRel: string, newRel: string): void;
  renameFolderOnOrigin(oldFolderRel: string, newFolderRel: string): void;
  mergeRenameOnOrigin(oldRel: string, newRel: string): void;
  splitRenameOnOrigin(pairs: ReadonlyArray<readonly [string, string]>): void;
  deleteOnOrigin(relPath: string): void;
  deleteInReceiverWorkingTree(relPath: string): void;
  renameInReceiverWorkingTree(oldRel: string, newRel: string): void;
  cloneReceiver(): string;
  cleanup(): void;
}

export function createGitTriangle(opts: { branch?: string } = {}): GitTriangle {
  const branch = opts.branch ?? 'main';
  const senderDir = mkdtempSync(join(tmpdir(), 'ok-share-sender-'));
  const originDir = mkdtempSync(join(tmpdir(), 'ok-share-origin-'));
  let receiverDir: string | null = null;

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  const configure = (dir: string): void => {
    git(dir, ['config', 'user.name', 'Fixture User']);
    git(dir, ['config', 'user.email', 'fixture@example.com']);
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
      symlinkSync(relative(dirname(linkAbs), join(senderDir, targetRel)), linkAbs);
      commitPush([targetRel, linkRel], `seed symlink ${linkRel}`);
    },
    writeWorkingTree(relPath, content) {
      writeFile(senderDir, relPath, content);
    },
    mkdirWorkingTree(relPath) {
      mkdirSync(join(senderDir, relPath), { recursive: true });
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
      git(senderDir, ['checkout', '-b', 'ok-merge-side']);
      writeFile(senderDir, 'SIDE.md', '# side\n');
      git(senderDir, ['add', '--', 'SIDE.md']);
      git(senderDir, ['commit', '-m', 'side: unrelated change']);
      git(senderDir, ['checkout', branch]);
      writeFile(senderDir, 'MAIN.md', '# main\n');
      git(senderDir, ['add', '--', 'MAIN.md']);
      git(senderDir, ['commit', '-m', 'main: unrelated change']);
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
