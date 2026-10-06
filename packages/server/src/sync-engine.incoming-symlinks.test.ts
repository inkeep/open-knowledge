import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit, { type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { createTestConflictAuthority } from './conflict-authority.test-helper.ts';
import { classifyGitError } from './error-classification.ts';
import { runCheckoutFlow } from './git-checkout.ts';
import {
  assertIncomingSymlinksSafe,
  resolveIncomingCommit,
  UnsafeIncomingSymlinkError,
} from './incoming-symlink-guard.ts';
import { getLogger } from './logger.ts';
import { SyncEngine } from './sync-engine.ts';

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

let tmpDir = '';
let projectDir = '';
let sisterDir = '';
let sister: SimpleGit;
let project: SimpleGit;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-engine-incoming-symlinks-'));
  projectDir = join(tmpDir, 'project');
  sisterDir = join(tmpDir, 'sister');
  const bareDir = join(tmpDir, 'bare.git');
  mkdirSync(bareDir, { recursive: true });
  await simpleGit(bareDir).init(true);
  configureTestGitRepository(bareDir);
  await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

  mkdirSync(sisterDir, { recursive: true });
  sister = simpleGit(sisterDir);
  await sister.init(['--initial-branch=main']);
  configureTestGitRepository(sisterDir);
  await sister.raw('config', 'user.name', 'Sister');
  await sister.raw('config', 'user.email', 'sister@test.com');
  mkdirSync(join(sisterDir, 'notes'), { recursive: true });
  writeFileSync(join(sisterDir, 'notes', 'real.md'), '# real\n', 'utf-8');
  await sister.add('.');
  await sister.commit('base');
  await sister.addRemote('origin', bareDir);
  await sister.push('origin', 'main');

  await simpleGit(tmpDir).clone(bareDir, projectDir);
  configureTestGitRepository(projectDir);
  mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
  writeFileSync(join(projectDir, '.ok', LOCAL_DIR, 'principal.json'), '{"secret":1}\n', 'utf-8');
  project = simpleGit(projectDir);
  await project.raw('config', 'user.name', 'Project');
  await project.raw('config', 'user.email', 'project@test.com');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function pushSymlinks(links: Record<string, string>, remoteBranch = 'main'): Promise<void> {
  for (const [path, target] of Object.entries(links)) {
    const targetFile = join(tmpDir, 'link-target.txt');
    writeFileSync(targetFile, target, 'utf-8');
    const blob = (await sister.raw('hash-object', '-w', targetFile)).trim();
    await sister.raw('update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
  }
  await sister.commit('add symlinks');
  await sister.push('origin', `HEAD:${remoteBranch}`);
}

async function pushRemoval(paths: string[]): Promise<void> {
  await sister.raw('rm', '-r', '--cached', '--quiet', ...paths);
  await sister.commit('remove paths');
  await sister.push('origin', 'HEAD:main');
}

function makeEngine(
  options: {
    setBatchInProgress?: (value: boolean) => void;
    onAutoDisable?: (reason: 'protected-branch') => void;
    syncEnabled?: boolean;
  } = {},
) {
  return new SyncEngine({
    conflicts: createTestConflictAuthority(projectDir),
    projectDir,
    contentDir: projectDir,
    contentFilter: stubContentFilter,
    syncEnabled: true,
    ...options,
  });
}

function captureSyncLogs(): {
  entries: Array<{ level: 'info' | 'warn'; data: Record<string, unknown>; msg: string }>;
  restore: () => void;
} {
  const entries: Array<{ level: 'info' | 'warn'; data: Record<string, unknown>; msg: string }> = [];
  const logger = getLogger('sync-engine');
  const record =
    (level: 'info' | 'warn') =>
    (data: unknown, msg?: string): void => {
      entries.push({ level, data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    };
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(record('info') as never);
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(record('warn') as never);
  return {
    entries,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

async function commitLocally(relPath: string, content: string): Promise<void> {
  writeFileSync(join(projectDir, relPath), content, 'utf-8');
  await project.add(relPath);
  await project.commit(`local ${relPath}`);
}

function existsAsEntry(relPath: string): boolean {
  try {
    lstatSync(join(projectDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function headSha(): Promise<string> {
  return (await project.revparse(['HEAD'])).trim();
}

function isAncestorOfHead(commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: projectDir });
    return true;
  } catch {
    return false;
  }
}

async function pullWithEngine(): Promise<void> {
  const engine = makeEngine();
  try {
    await engine.start();
    expect(await engine.pullOnce()).toBe('succeeded');
  } finally {
    await engine.destroy();
  }
}

async function expectRefusedPull(linkPaths: string[]): Promise<string[] | undefined> {
  const before = await headSha();
  const engine = makeEngine();
  try {
    await engine.start();
    expect(await engine.pullOnce()).toBe('refused');
    for (const linkPath of linkPaths) expect(existsAsEntry(linkPath)).toBe(false);
    expect(await headSha()).toBe(before);
    const status = engine.getStatus();
    expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
    return status.refusedSymlinkPaths;
  } finally {
    await engine.destroy();
  }
}

describe('SyncEngine refuses incoming symlinks into private state or outside the repository', () => {
  test.each([
    ['explicit pull (fast-forward)', 'explicit'],
    ['background sync (merge)', 'sync'],
  ] as const)('%s keeps an OK local-state symlink off disk', async (_label, invocation) => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    const before = await headSha();

    const engine = makeEngine();
    try {
      await engine.start();
      const outcome = await engine.pullOnce(invocation);

      expect(outcome).toBe('refused');
      expect(existsAsEntry('notes/leak.md')).toBe(false);
      expect(await headSha()).toBe(before);
      expect(engine.getStatus().pausedReason).toBe('unsafe-incoming-symlinks');
    } finally {
      await engine.destroy();
    }
  });

  test.each([
    ['the git dir', 'notes/leak-git.md', '../.git/config'],
    ['a case variant of the OK dir', 'notes/leak-upper.md', '../.OK/local/principal.json'],
    ['the renamed config dir', 'notes/leak-renamed.md', '../.open-knowledge/local/server.lock'],
    ['the OK dir itself', 'notes/ok-dir', '../.ok'],
    ['a parent directory', 'notes/leak-up.md', '../../outside.md'],
    ['an absolute path', 'notes/leak-abs.md', '/etc/hosts'],
    ['a target cut short by a NUL byte', 'notes/nul.md', '../.git/config\0/../../notes/x'],
    ['a target longer than any path', 'notes/long.md', `${'a/'.repeat(2100)}real.md`],
    ['a backslash-separated target', 'notes/bs.md', '..\\.git\\config'],
    ['a trailing-dot spelling of the git dir', 'notes/dot.md', '../.git./config'],
    ['an 8.3 short name of the git dir', 'notes/short.md', '../GIT~1/config'],
    ['an 8.3 short name of the OK dir', 'notes/short-ok.md', '../OK3A7F~1/local/principal.json'],
    [
      'an 8.3 short name of the renamed config dir',
      'notes/short-renamed.md',
      '../OPEN-K~1/local/server.lock',
    ],
    [
      'an 8.3 short name of the dotless config dir',
      'notes/short-dotless.md',
      '../OPENKN~1/local/server.lock',
    ],
    [
      'a hashed 8.3 short name of a long config dir',
      'notes/short-hashed.md',
      '../OPB2C4~5/local/server.lock',
    ],
    ['the dotless config dir', 'notes/dotless.md', '../.openknowledge/local/state.json'],
    ['a nested git dir', 'notes/nested.md', 'sub/.git/config'],
    ['an HFS-ignorable spelling of the git dir', 'notes/zw.md', '../.g\u200cit/config'],
    ["the user home's credential file", 'notes/auth.md', '../.ok/auth.yml'],
    ["the beta product's credential file", 'notes/auth-beta.md', '../.ok-beta/auth.yml'],
    ["the user home's secrets file", 'notes/secrets.md', '../.ok/secrets.yml'],
    ["the beta product's secrets file", 'notes/secrets-beta.md', '../.ok-beta/secrets.yml'],
    [
      "an 8.3 short name of the beta product's user-home dir",
      'notes/short-beta.md',
      '../OK-BET~1/auth.yml',
    ],
    ['a Windows drive-letter target', 'notes/drive.md', 'Q: real.md'],
    ['an 8.3 short name of a credentials file', 'notes/short-cred.md', '../GIT-CR~1'],
    ['an 8.3 short name of an env file', 'notes/short-env.md', '../ENV~1'],
    ['an 8.3 short name inside a secret folder', 'notes/short-aws.md', '../AWS~1/CREDEN~1'],
    ['an 8.3 short name removed again by ..', 'notes/short-up.md', 'LINK~1/../real.md'],
    ['an 8.3 short-name folder inside the OK dir', '.ok/WORKTR~1/x', '../../notes/real.md'],
    ['an NTFS data-stream spelling of a credential file', 'notes/ads.md', '../.ok/auth.yml::$DATA'],
    [
      'an NTFS index-stream spelling of a config dir',
      'notes/ads-dir.md',
      '../.ok-beta::$INDEX_ALLOCATION/secrets.yml',
    ],
    [
      'an NTFS index-stream spelling of the git dir',
      'notes/ads-git.md',
      '../.git::$INDEX_ALLOCATION/config',
    ],
    ['an env file', 'notes/env.md', '../.env'],
    ['a private key', 'notes/key.md', '../id_ed25519'],
    ['a secret-bearing folder', 'notes/aws.md', '../.aws/config'],
    ['a long-s spelling of a private key', 'notes/key-s.md', '../id_r\u017fa'],
    ['a long-s spelling of a secret folder', 'notes/aws-s.md', '../.aw\u017f/config'],
    ['an HFS-ignorable spelling of an env file', 'notes/env-zw.md', '../.e\u200cnv'],
    ['a trailing-dot spelling of a secret file', 'notes/npmrc-dot.md', '../.npmrc.'],
  ])('refuses a symlink into %s', async (_label, linkPath, target) => {
    await pushSymlinks({ [linkPath]: target });
    await expectRefusedPull([linkPath]);
  });

  test.each([
    [
      'a link to the OK dir',
      { x: '.ok', 'notes/leak.md': '../x/local/principal.json' },
      ['notes/leak.md', 'x'],
    ],
    [
      'a link to the repository root',
      { a: '.', 'notes/out.md': '../a/../outside.txt' },
      ['a', 'notes/out.md'],
    ],
    [
      'a link with an NTFS stream spelling',
      { y: '.git::$INDEX_ALLOCATION', 'notes/leak-ads.md': '../y/config' },
      ['notes/leak-ads.md', 'y'],
    ],
  ])('refuses a pair that escapes through %s', async (_label, links, refused) => {
    await pushSymlinks(links);
    expect(await expectRefusedPull(Object.keys(links))).toEqual(refused);
  });

  test.runIf(process.platform !== 'win32')(
    'refuses a link that resolves through an untracked on-disk link named like an 8.3 short name',
    async () => {
      mkdirSync(join(projectDir, 'notes', 'safe'), { recursive: true });
      symlinkSync('safe', join(projectDir, 'notes', 'LINK~1'));
      await pushSymlinks({ 'notes/x.md': 'LINK~1/f.md' });
      expect(await expectRefusedPull(['notes/x.md'])).toEqual(['notes/x.md']);
    },
  );

  test.each([
    ['an 8.3 short name of the git dir', '../GIT~1/config', 'private-state'],
    ['an 8.3 short name of the OK dir', '../OK3A7F~1/local/principal.json', 'private-state'],
    [
      'an 8.3 short name of the renamed config dir',
      '../OPEN-K~1/local/server.lock',
      'private-state',
    ],
    [
      'an 8.3 short name of the dotless config dir',
      '../OPENKN~1/local/server.lock',
      'private-state',
    ],
    [
      'a hashed 8.3 short name of a long config dir',
      '../OPB2C4~5/local/server.lock',
      'private-state',
    ],
    [
      "an 8.3 short name of the beta product's user-home dir",
      '../OK-BET~1/auth.yml',
      'private-state',
    ],
    ['an 8.3 short name of a credentials file', '../GIT-CR~1', 'unverifiable-target'],
    ['an 8.3 short-name folder before a plain name', '../DOCS~1/plain.md', 'unverifiable-target'],
    ['an 8.3 short name with an extension', '../REPORT~1.MD', 'unverifiable-target'],
    ['an 8.3 short name removed again by ..', 'LINK~1/../real.md', 'unverifiable-target'],
  ])('gives %s its own refusal reason', async (_label, target, reason) => {
    await pushSymlinks({ 'notes/alias-reason.md': target });
    await project.fetch('origin', 'main');
    const failure = await assertIncomingSymlinksSafe(
      project,
      'refs/remotes/origin/main',
      'merge',
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(UnsafeIncomingSymlinkError);
    expect((failure as UnsafeIncomingSymlinkError).unsafe).toEqual([
      { path: 'notes/alias-reason.md', reason },
    ]);
  });

  test('a name with a tilde that is not shaped like an 8.3 short name still pulls', async () => {
    await pushSymlinks({
      'notes/near-long.md': 'LONGNAME~1.md',
      'notes/near-word.md': 'notes~draft.md',
    });
    await pullWithEngine();
    expect(readlinkSync(join(projectDir, 'notes', 'near-long.md'))).toBe('LONGNAME~1.md');
    expect(readlinkSync(join(projectDir, 'notes', 'near-word.md'))).toBe('notes~draft.md');
  });

  test('refuses a link that escapes through a link pulled earlier, though its spelling stays inside', async () => {
    await pushSymlinks({ 'notes/sub/a': '..' });
    await pullWithEngine();
    expect(readlinkSync(join(projectDir, 'notes', 'sub', 'a'))).toBe('..');

    await pushSymlinks({ 'notes/out.md': 'sub/a/../../outside.txt' });
    expect(await expectRefusedPull(['notes/out.md'])).toEqual(['notes/out.md']);
  });

  test('pulls a chain of in-repository links like the ones skill linking writes', async () => {
    mkdirSync(join(sisterDir, 'shared', 'foreign'), { recursive: true });
    writeFileSync(join(sisterDir, 'shared', 'foreign', 'SKILL.md'), '# foreign\n', 'utf-8');
    await sister.add('shared/foreign/SKILL.md');
    await pushSymlinks({
      '.agents/skills/foreign': '../../shared/foreign',
      '.codex/skills/foreign': '../../.agents/skills/foreign',
    });

    await pullWithEngine();
    expect(readlinkSync(join(projectDir, '.codex', 'skills', 'foreign'))).toBe(
      '../../.agents/skills/foreign',
    );
  });

  test('refuses a link that escapes through a directory the same change replaces with a link', async () => {
    mkdirSync(join(sisterDir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'sub', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('.');
    await sister.commit('add sub');
    await sister.push('origin', 'HEAD:main');
    await pullWithEngine();
    expect(lstatSync(join(projectDir, 'notes', 'sub')).isDirectory()).toBe(true);

    await sister.raw('rm', '-r', '--cached', '--quiet', 'notes/sub');
    await pushSymlinks({ 'notes/sub': '..', 'notes/leak.md': 'sub/../outside.txt' });
    expect(await expectRefusedPull(['notes/leak.md'])).toEqual(['notes/leak.md', 'notes/sub']);
    expect(lstatSync(join(projectDir, 'notes', 'sub')).isDirectory()).toBe(true);
  });

  test('refuses a tracked file the remote turns into an unsafe symlink', async () => {
    await pushSymlinks({ 'notes/real.md': '../.git/config' });
    const before = await headSha();

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      expect(lstatSync(join(projectDir, 'notes', 'real.md')).isSymbolicLink()).toBe(false);
      expect(await headSha()).toBe(before);
    } finally {
      await engine.destroy();
    }
  });

  test('refuses a safe symlink the remote retargets into private state', async () => {
    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    await pullWithEngine();

    await pushSymlinks({ 'notes/alias.md': '../.git/config' });
    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
    } finally {
      await engine.destroy();
    }
  });

  test('a refused link named after classifier keywords still pauses with the symlink reason', async () => {
    await pushSymlinks({ 'notes/protected branch authentication failed.md': '../.git/config' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      const status = engine.getStatus();
      expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
      expect(status.state).toBe('idle');
    } finally {
      await engine.destroy();
    }
  });

  test('a refusal pauses sync with its own reason across cycles and clears once the remote removes the link', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });

    const engine = makeEngine();
    try {
      await engine.start();
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(await engine.pullOnce('sync')).toBe('refused');
        const status = engine.getStatus();
        expect(status.state).toBe('idle');
        expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
        expect(status.refusedSymlinkPaths).toEqual(['notes/leak.md']);
        expect(status.blockingPaths).toBeUndefined();
        expect(status.pullError).toBeUndefined();
        expect(status.consecutiveFailures).toBe(0);
      }

      await pushRemoval(['notes/leak.md']);
      expect(await engine.pullOnce('sync')).toBe('succeeded');
      const recovered = engine.getStatus();
      expect(recovered.pausedReason).toBeUndefined();
      expect(recovered.refusedSymlinkPaths).toBeUndefined();
      expect(existsAsEntry('notes/leak.md')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('the push retry merge does not merge a tag that shadows the tracking ref', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.git/config' }, 'unchecked');
    await sister.raw('tag', 'origin/main', 'HEAD');
    await sister.push(['origin', 'refs/tags/origin/main']);
    await sister.raw('reset', '--hard', 'HEAD~1');
    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    const remoteBefore = (await sister.revparse(['HEAD'])).trim();
    writeFileSync(join(projectDir, 'notes', 'local.md'), '# local\n', 'utf-8');
    await project.add('notes/local.md');
    await project.commit('local work');

    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      expect((await project.raw('ls-tree', 'HEAD', 'notes/leak.md')).trim()).toBe('');
      expect(existsAsEntry('notes/leak.md')).toBe(false);
      expect((await sister.raw('ls-remote', 'origin', 'refs/heads/main')).split('\t')[0]).toBe(
        remoteBefore,
      );
      expect(engine.getStatus().pullError).toMatch(/shadows it/);
    } finally {
      await engine.destroy();
    }
  });

  test('the push retry merge refuses the same symlinks', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    writeFileSync(join(projectDir, 'notes', 'local.md'), '# local\n', 'utf-8');
    await project.add('notes/local.md');
    await project.commit('local work');

    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      expect(existsAsEntry('notes/leak.md')).toBe(false);
      expect((await project.raw('ls-tree', 'HEAD', 'notes/leak.md')).trim()).toBe('');
      const status = engine.getStatus();
      expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
      expect(status.refusedSymlinkPaths).toEqual(['notes/leak.md']);
    } finally {
      await engine.destroy();
    }
  });

  test('explicit pull (fast-forward) lands exactly the commit the guard inspected', async () => {
    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    const inspected = (await sister.revparse(['HEAD'])).trim();
    await pushSymlinks({ 'notes/leak.md': '../.git/config' }, 'later');
    await project.fetch('origin', 'later');
    const later = (await project.revparse(['origin/later'])).trim();

    let moved = false;
    const engine = makeEngine({
      setBatchInProgress: (value) => {
        if (value && !moved) {
          moved = true;
          execFileSync('git', ['update-ref', 'refs/remotes/origin/main', later], {
            cwd: projectDir,
          });
        }
      },
    });
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('succeeded');
      expect(await headSha()).toBe(inspected);
      expect(existsAsEntry('notes/leak.md')).toBe(false);
      expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
    } finally {
      await engine.destroy();
    }
  });

  test('background sync does not merge a tag that shadows the tracking ref, and says why', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.git/config' }, 'unchecked');
    await sister.raw('tag', 'origin/main', 'HEAD');
    await sister.push(['origin', 'refs/tags/origin/main']);
    await sister.raw('reset', '--hard', 'HEAD~1');
    await pushSymlinks({ 'notes/alias.md': 'real.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('error');
      expect((await project.raw('ls-tree', 'HEAD', 'notes/leak.md')).trim()).toBe('');
      expect(existsAsEntry('notes/leak.md')).toBe(false);
      expect(engine.getStatus().pullError).toMatch(/shadows it/);
    } finally {
      await engine.destroy();
    }
  });

  test.each([['background sync (merge)', 'sync']] as const)(
    '%s lands only the commit the guard inspected',
    async (_label, invocation) => {
      await pushSymlinks({ 'notes/alias.md': 'real.md' });
      const inspected = (await sister.revparse(['HEAD'])).trim();
      await pushSymlinks({ 'notes/leak.md': '../.git/config' }, 'later');
      await project.fetch('origin', 'later');
      const later = (await project.revparse(['origin/later'])).trim();

      let moved = false;
      const engine = makeEngine({
        setBatchInProgress: (value) => {
          if (value && !moved) {
            moved = true;
            execFileSync('git', ['update-ref', 'refs/remotes/origin/main', later], {
              cwd: projectDir,
            });
          }
        },
      });
      try {
        await engine.start();
        expect(await engine.pullOnce(invocation)).toBe('refused');
        expect(existsAsEntry('notes/leak.md')).toBe(false);
        expect(isAncestorOfHead(later)).toBe(false);

        expect(await engine.pullOnce(invocation)).toBe('succeeded');
        expect(existsAsEntry('notes/leak.md')).toBe(false);
        expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
        expect(isAncestorOfHead(inspected)).toBe(true);
        expect(isAncestorOfHead(later)).toBe(false);
      } finally {
        await engine.destroy();
      }
    },
  );

  test('refuses a later pull that redirects an accepted link through a directory turned into a link', async () => {
    mkdirSync(join(sisterDir, 'notes', 'd'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'd', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('.');
    await pushSymlinks({ 'notes/l': 'd/../outside.txt' });
    await pullWithEngine();

    await sister.raw('rm', '-r', '--cached', '--quiet', 'notes/d');
    await pushSymlinks({ 'notes/d': '..' });
    expect(await expectRefusedPull([])).toEqual(['notes/d', 'notes/l']);
    expect(lstatSync(join(projectDir, 'notes', 'd')).isDirectory()).toBe(true);
  });

  test('refuses a later pull that redirects an accepted link into OK machine-local state', async () => {
    mkdirSync(join(sisterDir, 'd'), { recursive: true });
    writeFileSync(join(sisterDir, 'd', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('.');
    await pushSymlinks({ l: 'd/../local/principal.json' });
    await pullWithEngine();

    await sister.raw('rm', '-r', '--cached', '--quiet', 'd');
    await pushSymlinks({ d: '.ok/skills' });
    expect(await expectRefusedPull([])).toEqual(['l']);
  });

  test('a link that was already unsafe before a pull does not block it', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: projectDir,
      input: '../.git/config',
      encoding: 'utf-8',
    }).trim();
    await project.raw('update-index', '--add', '--cacheinfo', `120000,${blob},notes/bad`);
    await project.commit('local unsafe link');
    await project.push('origin', 'HEAD:main');
    await sister.pull('origin', 'main');

    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    await pullWithEngine();
    expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
  });

  test.each([
    [
      'a canonically equivalent spelling of a link',
      { 'caf\u00e9': '.', 'notes/leak.md': '../cafe\u0301/../outside.txt' },
      ['notes/leak.md'],
    ],
    [
      'a case variant of a link',
      { X: '.', 'notes/leak.md': '../x/../outside.txt' },
      ['notes/leak.md'],
    ],
    [
      'a long-s spelling of a machine-local file',
      { 'notes/leak.md': '../.ok/principal.j\u017fon' },
      ['notes/leak.md'],
    ],
  ])('refuses a symlink that escapes through %s', async (_label, links, refused) => {
    await pushSymlinks(links);
    expect(await expectRefusedPull(['notes/leak.md'])).toEqual(expect.arrayContaining(refused));
  });

  test('a link that collides with a directory under case folding is treated as a link', async () => {
    mkdirSync(join(sisterDir, 'notes', 'sub', 'X'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'sub', 'X', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('notes/sub/X/keep.md');
    await pushSymlinks({
      'notes/sub/x': '..',
      'notes/leak.md': 'sub/X/../../../outside.txt',
    });
    expect(await expectRefusedPull(['notes/leak.md'])).toEqual(['notes/leak.md']);
  });

  test('refuses an acyclic chain of more symlinks than the kernel follows', async () => {
    const chain: Record<string, string> = { 'notes/c41': 'real.md' };
    for (let index = 0; index < 41; index++) chain[`notes/c${index}`] = `c${index + 1}`;
    await pushSymlinks(chain);
    expect(await expectRefusedPull(['notes/c0'])).toContain('notes/c0');
  });

  test('refuses incoming links whose resolution exceeds the inspection budget', async () => {
    const links: Record<string, string> = {};
    for (let index = 0; index < 100; index++) {
      links[`notes/deep${index}`] = `${'sub/../'.repeat(120)}real.md`;
    }
    await pushSymlinks(links);
    const refused = await expectRefusedPull(['notes/deep0']);
    expect(refused?.length).toBe(50);
  }, 60_000);

  test('a keyword-bearing component the filesystem cannot inspect pauses without disabling sync', async () => {
    const onAutoDisable = vi.fn();
    await pushSymlinks({
      'notes/leak.md': `../${'protected branch '.repeat(16)}/../outside.txt`,
    });

    const engine = makeEngine({ onAutoDisable });
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      const status = engine.getStatus();
      expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
      expect(status.refusedSymlinkPaths).toEqual(['notes/leak.md']);
      expect(status.syncMode).toBe('full');
      expect(status.syncEnabled).toBe(true);
      expect(onAutoDisable).not.toHaveBeenCalled();
    } finally {
      await engine.destroy();
    }
  });

  test('follows an untracked local link and re-inspects once it is removed', async () => {
    symlinkSync('..', join(projectDir, 'u'));
    await pushSymlinks({ 'notes/leak.md': '../u/outside.txt' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      expect(existsAsEntry('notes/leak.md')).toBe(false);

      unlinkSync(join(projectDir, 'u'));
      expect(await engine.pullOnce()).toBe('succeeded');
      expect(readlinkSync(join(projectDir, 'notes', 'leak.md'))).toBe('../u/outside.txt');
    } finally {
      await engine.destroy();
    }
  });

  test('logs a standing refusal once, even after a local commit', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      await commitLocally('notes/local.md', '# local\n');
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(
        logs.entries.filter((entry) => entry.data.event === 'unsafe-incoming-symlinks'),
      ).toHaveLength(1);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('the push leg does not attempt a push while the refusal stands', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      await commitLocally('notes/local.md', '# local\n');

      const logs = captureSyncLogs();
      try {
        await engine.pushOnce();
        expect(logs.entries.some((entry) => entry.msg.includes('push rejected'))).toBe(false);
      } finally {
        logs.restore();
      }
      expect(engine.getStatus().pausedReason).toBe('unsafe-incoming-symlinks');
    } finally {
      await engine.destroy();
    }
  });

  test('a Manual one-shot pull keeps the refusal visible', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    const engine = makeEngine({ syncEnabled: false });
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      const status = engine.getStatus();
      expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
      expect(status.refusedSymlinkPaths).toEqual(['notes/leak.md']);
    } finally {
      await engine.destroy();
    }
  });

  test('a refusal is recomputed after a restart rather than restored', async () => {
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    const first = makeEngine();
    try {
      await first.start();
      expect(await first.pullOnce()).toBe('refused');
    } finally {
      await first.destroy();
    }

    const second = makeEngine();
    try {
      await second.start();
      expect(second.getStatus().pausedReason).toBeUndefined();
    } finally {
      await second.destroy();
    }
  });

  test('a force-push that removes the incoming commit clears the refusal', async () => {
    const base = (await sister.revparse(['HEAD'])).trim();
    await pushSymlinks({ 'notes/leak.md': '../.ok/local/principal.json' });
    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');

      await sister.push(['--force', 'origin', `${base}:main`]);
      expect(await engine.pullOnce()).toBe('up-to-date');
      const status = engine.getStatus();
      expect(status.pausedReason).toBeUndefined();
      expect(status.refusedSymlinkPaths).toBeUndefined();
    } finally {
      await engine.destroy();
    }
  });

  test('in-repository symlinks, including legacy skill links, still pull', async () => {
    await pushSymlinks({
      'notes/alias.md': 'real.md',
      '.claude/skills/demo': '../../.ok/skills/demo',
    });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('succeeded');
      expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
      expect(readlinkSync(join(projectDir, '.claude', 'skills', 'demo'))).toBe(
        '../../.ok/skills/demo',
      );
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine incoming symlink edge shapes', () => {
  test.each([
    ['a case pair', { 'notes/A': '../.git/config', 'notes/a': 'real.md' }, 'notes/A'],
    ['a trailing-dot pair', { 'notes/x': '../.git/config', 'notes/x.': 'real.md' }, 'notes/x'],
    [
      'a composed and decomposed pair',
      { 'notes/cafe\u0301': '../.git/config', 'notes/caf\u00e9': 'real.md' },
      'notes/cafe\u0301',
    ],
  ])('judges every link in %s under its own path', async (_label, links, unsafePath) => {
    await sister.raw('config', 'core.precomposeUnicode', 'false');
    await pushSymlinks(links);
    expect(
      (await sister.raw('ls-tree', '-z', '--name-only', 'HEAD', 'notes/')).split('\0'),
    ).toEqual(expect.arrayContaining(Object.keys(links)));
    expect(await expectRefusedPull([])).toContain(unsafePath);
  });

  test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'a component the filesystem refuses to inspect pauses without disabling sync',
    async () => {
      const locked = join(projectDir, 'locked');
      mkdirSync(join(locked, 'inner'), { recursive: true });
      execFileSync('chmod', ['000', locked]);
      try {
        await pushSymlinks({ 'notes/protected branch.md': '../locked/inner/real.md' });
        const autoDisabled: string[] = [];
        const engine = makeEngine({ onAutoDisable: (reason) => autoDisabled.push(reason) });
        try {
          await engine.start();
          const modeBefore = engine.getStatus().syncMode;
          expect(await engine.pullOnce('sync')).toBe('refused');
          const status = engine.getStatus();
          expect(status.pausedReason).toBe('unsafe-incoming-symlinks');
          expect(status.syncMode).toBe(modeBefore);
          expect(autoDisabled).toEqual([]);
        } finally {
          await engine.destroy();
        }
      } finally {
        execFileSync('chmod', ['755', locked]);
      }
    },
  );

  test.each([
    ['the machine-local dir itself', '.ok/local', '../notes'],
    ['a machine-local file', '.ok/local/principal.json', '../../notes/real.md'],
  ])('refuses a link placed at %s', async (_label, linkPath, target) => {
    await pushSymlinks({ [linkPath]: target });
    expect(await expectRefusedPull([])).toEqual([linkPath]);
    expect(lstatSync(join(projectDir, '.ok', LOCAL_DIR, 'principal.json')).isFile()).toBe(true);
  });

  test('refuses a pull that deletes a link an existing link resolves through', async () => {
    mkdirSync(join(projectDir, 'notes', 'sub', 'deeper'), { recursive: true });
    writeFileSync(join(projectDir, 'notes', 'sub', 'deeper', 'keep.md'), '# keep\n', 'utf-8');
    symlinkSync('sub/deeper', join(projectDir, 'notes', 'd'));
    symlinkSync('d/../../../outside.txt', join(projectDir, 'notes', 'l'));
    await project.add(['notes/sub/deeper/keep.md', 'notes/d', 'notes/l']);
    await project.commit('existing chain');
    await project.push('origin', 'HEAD:main');
    await sister.pull('origin', 'main');

    await sister.raw('rm', '--cached', '--quiet', 'notes/d');
    rmSync(join(sisterDir, 'notes', 'd'), { force: true });
    mkdirSync(join(sisterDir, 'notes', 'd'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'd', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('notes/d/keep.md');
    await sister.commit('turn the link into a directory');
    await sister.push('origin', 'HEAD:main');

    expect(await expectRefusedPull([])).toEqual(['notes/l']);
  });

  test('judges an incoming link at the path a local directory rename moves it to', async () => {
    mkdirSync(join(sisterDir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'sub', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('notes/sub/keep.md');
    await sister.commit('add sub folder');
    await sister.push('origin', 'HEAD:main');
    await project.pull('origin', 'main');
    mkdirSync(join(projectDir, 'top'), { recursive: true });
    await project.raw('mv', 'notes/sub/keep.md', 'top/keep.md');
    await project.commit('move the folder up locally');
    await pushSymlinks({ 'notes/sub/new.md': '../../x.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toEqual(['top/new.md']);
      expect(existsAsEntry('notes/sub/new.md')).toBe(false);
      expect(existsAsEntry('top/new.md')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test.each([
    ['safe in both versions does not pause sync', '../notes/real.md', false],
    ['unsafe in the incoming version is refused', '../.git/config', true],
  ])('a link both sides changed and that is %s', async (_label, incomingTarget, refused) => {
    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    await pullWithEngine();
    writeFileSync(join(projectDir, 'notes', 'other.md'), '# other\n', 'utf-8');
    rmSync(join(projectDir, 'notes', 'alias.md'));
    symlinkSync('other.md', join(projectDir, 'notes', 'alias.md'));
    await project.add(['notes/other.md', 'notes/alias.md']);
    await project.commit('retarget locally');
    await pushSymlinks({ 'notes/alias.md': incomingTarget });

    const engine = makeEngine();
    try {
      await engine.start();
      const outcome = await engine.pullOnce('sync');
      const status = engine.getStatus();
      if (refused) {
        expect(outcome).toBe('refused');
        expect(status.refusedSymlinkPaths).toEqual(['notes/alias.md']);
        expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('other.md');
      } else {
        expect(['succeeded', 'conflict']).toContain(outcome);
        expect(status.pausedReason).not.toBe('unsafe-incoming-symlinks');
      }
    } finally {
      await engine.destroy();
    }
  });

  test('a document link both sides changed is refused when the local version is unsafe', async () => {
    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    await pullWithEngine();
    rmSync(join(projectDir, 'notes', 'alias.md'));
    symlinkSync('../.git/config', join(projectDir, 'notes', 'alias.md'));
    await project.add('notes/alias.md');
    await project.commit('local unsafe document link');
    writeFileSync(join(sisterDir, 'notes', 'other.md'), '# other\n', 'utf-8');
    await sister.add('notes/other.md');
    await pushSymlinks({ 'notes/alias.md': 'other.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toEqual(['notes/alias.md']);
    } finally {
      await engine.destroy();
    }
  });

  test('a non-document link both sides changed is refused when either version that could land is unsafe', async () => {
    writeFileSync(join(sisterDir, 'notes', 'data.json'), '{}\n', 'utf-8');
    writeFileSync(join(sisterDir, 'notes', 'safe.json'), '{}\n', 'utf-8');
    await sister.add(['notes/data.json', 'notes/safe.json']);
    await sister.commit('add data files');
    await sister.push('origin', 'HEAD:main');
    await project.pull('origin', 'main');

    rmSync(join(projectDir, 'notes', 'data.json'));
    symlinkSync('../.git/config', join(projectDir, 'notes', 'data.json'));
    await project.add('notes/data.json');
    await project.commit('local unsafe link');

    rmSync(join(sisterDir, 'notes', 'data.json'));
    symlinkSync('safe.json', join(sisterDir, 'notes', 'data.json'));
    await sister.add('notes/data.json');
    await sister.commit('remote safe link');
    await sister.push('origin', 'HEAD:main');

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toEqual(['notes/data.json']);
      expect(readlinkSync(join(projectDir, 'notes', 'data.json'))).toBe('../.git/config');
    } finally {
      await engine.destroy();
    }
  });

  test('refuses an existing link whose walk is cut short before it reaches a changed link', async () => {
    for (const dir of [
      ['notes', 'sub'],
      ['notes', 'd', 'e'],
      ['notes', 'e'],
    ]) {
      mkdirSync(join(projectDir, ...dir), { recursive: true });
      writeFileSync(join(projectDir, ...dir, 'keep.md'), '# keep\n', 'utf-8');
    }
    symlinkSync(`${'sub/../'.repeat(130)}d/e/../../../x.md`, join(projectDir, 'notes', 'l'));
    await project.add('notes');
    await project.commit('existing long link');
    await project.push('origin', 'HEAD:main');
    await sister.pull('origin', 'main');

    await sister.raw('rm', '-r', '--cached', '--quiet', 'notes/d');
    await pushSymlinks({ 'notes/d': '.' });
    expect(await expectRefusedPull([])).toContain('notes/l');
    expect(lstatSync(join(projectDir, 'notes', 'd')).isDirectory()).toBe(true);
  });

  test.runIf(process.platform !== 'win32')(
    'refuses an existing link through a config-dir short name when a later link on its path changes',
    async () => {
      mkdirSync(join(projectDir, 'OK3A7F~1'), { recursive: true });
      writeFileSync(join(projectDir, 'OK3A7F~1', 'p.md'), '# p\n', 'utf-8');
      mkdirSync(join(projectDir, 'notes', 'sub'), { recursive: true });
      writeFileSync(join(projectDir, 'notes', 'sub', 'keep.md'), '# keep\n', 'utf-8');
      symlinkSync('sub', join(projectDir, 'notes', 'c'));
      symlinkSync('../OK3A7F~1/../notes/c/../.git/config', join(projectDir, 'notes', 'x.md'));
      await project.add(['OK3A7F~1', 'notes']);
      await project.commit('existing link through a short name');
      await project.push('origin', 'HEAD:main');
      await sister.pull('origin', 'main');

      await pushSymlinks({ 'notes/c': '../top' });
      expect(await expectRefusedPull([])).toContain('notes/x.md');
    },
  );

  test.runIf(process.platform !== 'win32')(
    'refuses a link that leaves through an outside alias even when it lands somewhere safe inside',
    async () => {
      symlinkSync(join(projectDir, 'notes'), join(tmpDir, 'notes-alias'));
      await pushSymlinks({ 'notes/z.md': '../../notes-alias/real.md' });
      expect(await expectRefusedPull(['notes/z.md'])).toEqual(['notes/z.md']);
    },
  );

  test('an existing link outside the repository does not block a pull that changes links', async () => {
    mkdirSync(join(projectDir, 'notes'), { recursive: true });
    symlinkSync('../../elsewhere/shared.md', join(projectDir, 'notes', 'shared.md'));
    symlinkSync('/etc/hosts', join(projectDir, 'notes', 'hosts.md'));
    await project.add('notes');
    await project.commit('existing links outside the repository');
    await project.push('origin', 'HEAD:main');
    await sister.pull('origin', 'main');

    await pushSymlinks({ 'notes/other.md': 'real.md' });
    await pullWithEngine();
    expect(readlinkSync(join(projectDir, 'notes', 'other.md'))).toBe('real.md');
  });

  test.runIf(process.platform !== 'win32')(
    'refuses an existing link through a generic short name on any pull that changes links',
    async () => {
      mkdirSync(join(projectDir, 'notes'), { recursive: true });
      symlinkSync('LINK~1/f.md', join(projectDir, 'notes', 'e.md'));
      await project.add('notes');
      await project.commit('existing link through a short name');
      await project.push('origin', 'HEAD:main');
      await sister.pull('origin', 'main');

      await pushSymlinks({ 'notes/other.md': 'real.md' });
      expect(await expectRefusedPull(['notes/other.md'])).toContain('notes/e.md');
    },
  );

  test('judges links that resolve through a conflicted link against the version that lands', async () => {
    for (const dir of [
      ['notes', 'sub', 'e'],
      ['notes', 'sub2', 'e'],
      ['notes', 'e'],
    ]) {
      mkdirSync(join(sisterDir, ...dir), { recursive: true });
      writeFileSync(join(sisterDir, ...dir, 'keep.md'), '# keep\n', 'utf-8');
    }
    await sister.add('.');
    await pushSymlinks({ 'notes/d': 'sub' });
    await pullWithEngine();

    rmSync(join(projectDir, 'notes', 'd'));
    symlinkSync('sub2', join(projectDir, 'notes', 'd'));
    await project.add('notes/d');
    await project.commit('retarget locally');
    await pushSymlinks({ 'notes/d': '.', 'notes/l': 'd/e/../../../x.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toContain('notes/l');
      expect(existsAsEntry('notes/l')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('refuses a link that resolves through the relocated spelling of a conflicted folder', async () => {
    mkdirSync(join(sisterDir, 'notes', 'd', 'e'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'd', 'e', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('notes/d/e/keep.md');
    await sister.commit('add folder');
    await sister.push('origin', 'HEAD:main');
    await project.pull('origin', 'main');

    writeFileSync(join(projectDir, 'notes', 'd', 'e', 'keep.md'), '# local edit\n', 'utf-8');
    await project.add('notes/d/e/keep.md');
    await project.commit('edit inside the folder locally');
    await sister.raw('rm', '-r', '--cached', '--quiet', 'notes/d');
    await pushSymlinks({ 'notes/d': '.', 'notes/l': 'd~origin_main/e/../../../x.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toContain('notes/l');
      expect(existsAsEntry('notes/l')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('refuses a link that resolves through a conflicted link outside any document folder', async () => {
    for (const dir of [
      ['vendor', 'sub', 'e'],
      ['vendor', 'sub2', 'e'],
      ['vendor', 'e'],
    ]) {
      mkdirSync(join(sisterDir, ...dir), { recursive: true });
      writeFileSync(join(sisterDir, ...dir, 'keep.txt'), 'keep\n', 'utf-8');
    }
    await sister.add('.');
    await pushSymlinks({ 'vendor/d.md': 'sub' });
    await pullWithEngine();

    rmSync(join(projectDir, 'vendor', 'd.md'));
    symlinkSync('sub2', join(projectDir, 'vendor', 'd.md'));
    await project.add('vendor/d.md');
    await project.commit('retarget locally');
    await pushSymlinks({ 'vendor/d.md': '.', 'vendor/l': 'd.md/e/../../../x.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toContain('vendor/l');
    } finally {
      await engine.destroy();
    }
  });

  test('refuses a link whose walk exceeds the step cap', async () => {
    await pushSymlinks({ 'notes/steps.md': `${'x/../'.repeat(130)}real.md` });
    expect(await expectRefusedPull([])).toEqual(['notes/steps.md']);
  });

  test('follows a link spelled with a capital sharp s', async () => {
    mkdirSync(join(sisterDir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'sub', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('notes/sub/keep.md');
    await pushSymlinks({
      'notes/sub/\u00df': '..',
      'notes/l': 'sub/\u1e9e/../../outside.txt',
    });
    expect(await expectRefusedPull([])).toContain('notes/l');
  });

  test('a safe link a local rename relocates still merges', async () => {
    mkdirSync(join(projectDir, 'moved'), { recursive: true });
    await project.raw('mv', 'notes/real.md', 'moved/real.md');
    await project.commit('move locally');
    await pushSymlinks({ 'notes/new.md': 'real.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(['succeeded', 'conflict']).toContain(await engine.pullOnce('sync'));
      expect(engine.getStatus().pausedReason).not.toBe('unsafe-incoming-symlinks');
    } finally {
      await engine.destroy();
    }
  });

  test('judges the tree the merge produces, not the incoming tree', async () => {
    mkdirSync(join(sisterDir, 'notes', 'sub', 'deeper'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'sub', 'deeper', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add('notes/sub/deeper/keep.md');
    await pushSymlinks({ 'notes/d': 'sub/deeper' });
    await pullWithEngine();

    await project.raw('rm', '--cached', '--quiet', 'notes/d');
    rmSync(join(projectDir, 'notes', 'd'), { force: true });
    mkdirSync(join(projectDir, 'notes', 'd'), { recursive: true });
    writeFileSync(join(projectDir, 'notes', 'd', 'keep.md'), '# local\n', 'utf-8');
    await project.add('notes/d/keep.md');
    await project.commit('replace the link with a folder locally');
    await pushSymlinks({ 'notes/l': 'd/../../../outside.txt' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toEqual(['notes/l']);
      expect(existsAsEntry('notes/l')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('treats a name the filesystem could resolve to either a link or a folder as unverifiable', async () => {
    mkdirSync(join(sisterDir, 'notes', 'sub', 'X'), { recursive: true });
    mkdirSync(join(sisterDir, 'notes', 'sub', 'deeper', 'er'), { recursive: true });
    writeFileSync(join(sisterDir, 'notes', 'sub', 'X', 'keep.md'), '# keep\n', 'utf-8');
    writeFileSync(join(sisterDir, 'notes', 'sub', 'deeper', 'er', 'keep.md'), '# keep\n', 'utf-8');
    await sister.add(['notes/sub/X/keep.md', 'notes/sub/deeper/er/keep.md']);
    await pushSymlinks({
      'notes/sub/x': 'deeper/er',
      'notes/leak.md': 'sub/X/../../../../outside.txt',
    });
    expect(await expectRefusedPull([])).toContain('notes/leak.md');
  });

  test('a local rename elsewhere does not block a safe incoming link', async () => {
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'old.md'), '# old\n', 'utf-8');
    await project.add('docs/old.md');
    await project.commit('add docs');
    await project.raw('mv', 'docs/old.md', 'docs/new.md');
    await project.commit('rename locally');
    await pushSymlinks({ 'notes/alias.md': 'real.md' });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('succeeded');
      expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
    } finally {
      await engine.destroy();
    }
  });

  test('re-inspects after committing an uncommitted folder move before merging', async () => {
    mkdirSync(join(sisterDir, 'deep', 'er', 'a'), { recursive: true });
    writeFileSync(join(sisterDir, 'deep', 'er', 'a', 'f.md'), '# f\n', 'utf-8');
    await sister.add('deep/er/a/f.md');
    await sister.commit('add deep folder');
    await sister.push('origin', 'HEAD:main');
    await project.pull('origin', 'main');

    await pushSymlinks({ 'deep/er/a/l': '../../../x.md' });
    mkdirSync(join(projectDir, 'a'), { recursive: true });
    execFileSync('git', ['mv', 'deep/er/a/f.md', 'a/f.md'], { cwd: projectDir });
    execFileSync('git', ['reset', '--quiet'], { cwd: projectDir });

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('refused');
      expect(engine.getStatus().pausedReason).toBe('unsafe-incoming-symlinks');
      expect(existsAsEntry('a/l')).toBe(false);
      expect(existsAsEntry('deep/er/a/l')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('guards a project that lives below the git root', async () => {
    mkdirSync(join(sisterDir, 'sub', 'notes'), { recursive: true });
    writeFileSync(join(sisterDir, 'sub', 'notes', 'real.md'), '# real\n', 'utf-8');
    await sister.add('sub/notes/real.md');
    await sister.commit('add sub project');
    await sister.push('origin', 'HEAD:main');
    await project.pull('origin', 'main');
    const subProject = join(projectDir, 'sub');
    mkdirSync(join(subProject, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(join(subProject, '.ok', LOCAL_DIR, 'principal.json'), '{"secret":1}\n', 'utf-8');
    await pushSymlinks({ 'sub/notes/leak.md': '../.ok/local/principal.json' });

    const engine = new SyncEngine({
      conflicts: createTestConflictAuthority(subProject),
      projectDir: subProject,
      contentDir: subProject,
      contentFilter: stubContentFilter,
      syncEnabled: true,
    });
    try {
      await engine.start();
      expect(await engine.pullOnce()).toBe('refused');
      expect(engine.getStatus().refusedSymlinkPaths).toEqual(['sub/notes/leak.md']);
      expect(existsAsEntry('sub/notes/leak.md')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('fails closed on an unsafe link arriving on unrelated history', async () => {
    await sister.raw('checkout', '--quiet', '--orphan', 'unrelated');
    await sister.raw('rm', '-r', '--cached', '--quiet', '.');
    await pushSymlinks({ 'notes/leak.md': '../.git/config' }, 'unrelated-main');
    await sister.push(['--force', 'origin', 'unrelated:main']);

    const engine = makeEngine();
    try {
      await engine.start();
      expect(await engine.pullOnce('sync')).toBe('error');
      expect(existsAsEntry('notes/leak.md')).toBe(false);
    } finally {
      await engine.destroy();
    }
  });

  test('publishes refused paths with invisible characters escaped', async () => {
    await pushSymlinks({ 'notes/\u202egnp.md': '../.git/config' });
    expect(await expectRefusedPull([])).toEqual(['notes/\\u202egnp.md']);
  });
});

describe('share-link branch switch', () => {
  test.each([
    ['refuses a branch that carries an unsafe link', '../.git/config', false],
    ['switches to a branch whose links are safe', 'real.md', true],
  ])('%s', async (_label, target, switched) => {
    await pushSymlinks({ 'notes/link.md': target }, 'shared');
    await sister.raw('reset', '--hard', 'HEAD~1');

    const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

    expect(outcome).toEqual(
      switched
        ? { ok: true }
        : { ok: false, reason: 'unsafe-symlinks', refusedSymlinkPaths: ['notes/link.md'] },
    );
    expect(existsAsEntry('notes/link.md')).toBe(switched);
    expect((await project.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(
      switched ? 'shared' : 'main',
    );
  });

  test('lands the inspected branch tip, not a tag that shares its name', async () => {
    await pushSymlinks({ 'notes/link.md': '../.git/config' }, 'unchecked');
    await sister.raw('tag', 'shared', 'HEAD');
    await sister.push(['origin', 'refs/tags/shared']);
    await sister.raw('reset', '--hard', 'HEAD~1');
    await pushSymlinks({ 'notes/link.md': 'real.md' }, 'refs/heads/shared');
    const tip = (await sister.revparse(['HEAD'])).trim();
    await sister.raw('reset', '--hard', 'HEAD~1');
    await project.fetch('origin');

    const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

    expect(outcome.ok).toBe(true);
    expect(await headSha()).toBe(tip);
    expect((await project.raw('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/shared');
    expect(readlinkSync(join(projectDir, 'notes', 'link.md'))).toBe('real.md');
    expect((await project.raw('rev-parse', '--symbolic-full-name', '@{upstream}')).trim()).toBe(
      'refs/remotes/origin/shared',
    );
  });

  async function divergedTargetKeepingALinkHeadDeleted(): Promise<string> {
    const targetFile = join(tmpDir, 'link-target.txt');
    writeFileSync(targetFile, '../.git/config', 'utf-8');
    const blob = (await project.raw('hash-object', '-w', targetFile)).trim();
    await project.raw('update-index', '--add', '--cacheinfo', `120000,${blob},notes/leak.md`);
    await project.commit('base with link');
    const base = await headSha();
    await project.raw('rm', '--cached', '--quiet', 'notes/leak.md');
    await project.commit('drop link');
    const target = (
      await project.raw('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'shared work')
    ).trim();
    await project.push('origin', `${target}:refs/heads/shared`);
    return target;
  }

  test.each([
    [
      'the upstream write',
      () => writeFileSync(join(projectDir, '.git', 'config.lock'), '', 'utf-8'),
    ],
    ['the checkout', () => writeFileSync(join(projectDir, 'newdir'), 'untracked\n', 'utf-8')],
  ])('a switch that fails at %s leaves no new branch behind', async (_label, breakStep) => {
    const pageFile = join(tmpDir, 'page.txt');
    writeFileSync(pageFile, '# page\n', 'utf-8');
    const blob = (await sister.raw('hash-object', '-w', pageFile)).trim();
    await sister.raw('update-index', '--add', '--cacheinfo', `100644,${blob},newdir/page.md`);
    await sister.commit('add folder');
    await sister.push('origin', 'HEAD:shared');
    await sister.raw('reset', '--hard', 'HEAD~1');
    const head = await headSha();
    breakStep();

    try {
      const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

      expect(outcome).toEqual({ ok: false, reason: 'checkout-failed' });
      expect(await headSha()).toBe(head);
      expect((await project.raw('branch', '--list', 'shared')).trim()).toBe('');
    } finally {
      rmSync(join(projectDir, '.git', 'config.lock'), { force: true });
    }
  });

  test('a failed switch to an existing local branch leaves that branch where it was', async () => {
    const pageFile = join(tmpDir, 'page.txt');
    writeFileSync(pageFile, '# page\n', 'utf-8');
    const blob = (await project.raw('hash-object', '-w', pageFile)).trim();
    const head = await headSha();
    await project.raw('update-index', '--add', '--cacheinfo', `100644,${blob},newdir/page.md`);
    const withFolder = (await project.raw('write-tree')).trim();
    await project.raw('rm', '--cached', '--quiet', 'newdir/page.md');
    const local = (
      await project.raw('commit-tree', withFolder, '-p', head, '-m', 'local branch work')
    ).trim();
    await project.raw('branch', 'shared', local);
    writeFileSync(join(projectDir, 'newdir'), 'untracked\n', 'utf-8');

    const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

    expect(outcome).toEqual({ ok: false, reason: 'checkout-failed' });
    expect(await headSha()).toBe(head);
    expect((await project.revparse(['refs/heads/shared'])).trim()).toBe(local);
  });

  test('refuses an existing local branch fast-forwarded to an unsafe remote tip', async () => {
    const head = await headSha();
    await project.raw('branch', 'shared', head);
    await pushSymlinks({ 'notes/link.md': '../.git/config' }, 'shared');
    await sister.raw('reset', '--hard', 'HEAD~1');

    const outcome = await runCheckoutFlow(projectDir, 'shared', {
      fastForward: true,
      credentialConfig: [],
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'unsafe-symlinks',
      refusedSymlinkPaths: ['notes/link.md'],
    });
    expect(await headSha()).toBe(head);
    expect((await project.raw('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/main');
    expect(existsAsEntry('notes/link.md')).toBe(false);
  });

  test('refuses an existing local branch whose own tip is unsafe though its remote is safe', async () => {
    await pushSymlinks({ 'notes/link.md': 'real.md' }, 'shared');
    await sister.raw('reset', '--hard', 'HEAD~1');
    await project.fetch('origin');
    const head = await headSha();
    const targetFile = join(tmpDir, 'link-target.txt');
    writeFileSync(targetFile, '../.git/config', 'utf-8');
    const blob = (await project.raw('hash-object', '-w', targetFile)).trim();
    await project.raw('update-index', '--add', '--cacheinfo', `120000,${blob},notes/link.md`);
    const unsafeTree = (await project.raw('write-tree')).trim();
    await project.raw('rm', '--cached', '--quiet', 'notes/link.md');
    const local = (
      await project.raw('commit-tree', unsafeTree, '-p', head, '-m', 'unsafe local branch')
    ).trim();
    await project.raw('branch', 'shared', local);
    await project.raw('branch', '--set-upstream-to=origin/shared', 'shared');

    const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

    expect(outcome).toEqual({
      ok: false,
      reason: 'unsafe-symlinks',
      refusedSymlinkPaths: ['notes/link.md'],
    });
    expect(await headSha()).toBe(head);
    expect((await project.raw('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/main');
    expect(existsAsEntry('notes/link.md')).toBe(false);
  });

  function installFailingPostCheckoutHook(): string {
    const hooksDir = join(tmpDir, 'checkout-hooks');
    const ranMarker = join(tmpDir, 'post-checkout-ran');
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${ranMarker}'\nexit 1\n`, 'utf-8');
    execFileSync('chmod', ['755', hook]);
    execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: projectDir });
    return ranMarker;
  }

  test.runIf(process.platform !== 'win32')(
    'a post-checkout hook that fails after the switch reports the switch it made',
    async () => {
      await pushSymlinks({ 'notes/link.md': 'real.md' }, 'shared');
      await sister.raw('reset', '--hard', 'HEAD~1');
      const ranMarker = installFailingPostCheckoutHook();

      const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

      expect(existsSync(ranMarker)).toBe(true);
      expect(outcome).toEqual({ ok: true });
      expect((await project.raw('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/shared');
      expect(readlinkSync(join(projectDir, 'notes', 'link.md'))).toBe('real.md');
    },
  );

  test.runIf(process.platform !== 'win32')(
    'a failed checkout of the branch HEAD is already on is not credited to a hook',
    async () => {
      await project.raw('checkout', '-b', 'shared');
      const head = await headSha();
      const ranMarker = installFailingPostCheckoutHook();

      const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

      expect(existsSync(ranMarker)).toBe(true);
      expect(outcome).toEqual({ ok: false, reason: 'checkout-failed' });
      expect((await project.raw('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/shared');
      expect(await headSha()).toBe(head);
    },
  );

  test('judges the tree a switch lands, not what a merge of it would keep', async () => {
    await divergedTargetKeepingALinkHeadDeleted();
    const head = await headSha();

    const outcome = await runCheckoutFlow(projectDir, 'shared', { credentialConfig: [] });

    expect(outcome).toEqual({
      ok: false,
      reason: 'unsafe-symlinks',
      refusedSymlinkPaths: ['notes/leak.md'],
    });
    expect(await headSha()).toBe(head);
    expect((await project.raw('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/main');
    expect(existsAsEntry('notes/leak.md')).toBe(false);
  });

  test.each([
    ['merge first', ['merge', 'checkout']],
    ['checkout first', ['checkout', 'merge']],
  ] as const)('keeps merge and checkout verdicts apart (%s)', async (_label, order) => {
    const target = await divergedTargetKeepingALinkHeadDeleted();
    const verdicts: Record<string, boolean> = {};
    for (const landing of order) {
      verdicts[landing] = await assertIncomingSymlinksSafe(project, target, landing).then(
        () => true,
        () => false,
      );
    }
    expect(verdicts).toEqual({ merge: true, checkout: false });
  });
});

describe('incoming symlink inspection', () => {
  function gitReportingVersion(versionLine: string): SimpleGit {
    const binary = join(tmpDir, 'fake-git');
    writeFileSync(
      binary,
      `#!/bin/sh\nif [ "$1" = version ]; then echo "${versionLine}"; exit 0; fi\nexec git "$@"\n`,
      'utf-8',
    );
    execFileSync('chmod', ['755', binary]);
    return simpleGit({ baseDir: projectDir, binary });
  }

  async function divergeWith(remote: () => Promise<void>): Promise<string> {
    await commitLocally('notes/local.md', '# local\n');
    await remote();
    await project.fetch('origin', 'main');
    return (await project.revparse(['refs/remotes/origin/main'])).trim();
  }

  test.runIf(process.platform !== 'win32')(
    'below the merge-tree Git floor, a three-way pull that changes a link is refused',
    async () => {
      const incoming = await divergeWith(() => pushSymlinks({ 'notes/alias.md': 'real.md' }));
      const failure = await assertIncomingSymlinksSafe(
        gitReportingVersion('git version 2.34.1'),
        incoming,
        'merge',
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(failure).toBeInstanceOf(UnsafeIncomingSymlinkError);
      expect((failure as UnsafeIncomingSymlinkError).unsafe).toEqual([
        { path: 'notes/alias.md', reason: 'requires-newer-git' },
      ]);
    },
  );

  test.runIf(process.platform !== 'win32')(
    'below the merge-tree Git floor, a link changed only locally does not refuse the pull',
    async () => {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: projectDir,
        input: 'real.md',
        encoding: 'utf-8',
      }).trim();
      await project.raw('update-index', '--add', '--cacheinfo', `120000,${blob},notes/mine.md`);
      await project.commit('local link');
      const incoming = await divergeWith(async () => {
        writeFileSync(join(sisterDir, 'notes', 'remote.md'), '# remote\n', 'utf-8');
        await sister.add('notes/remote.md');
        await sister.commit('remote doc');
        await sister.push('origin', 'HEAD:main');
      });
      await expect(
        assertIncomingSymlinksSafe(gitReportingVersion('git version 2.34.1'), incoming, 'merge'),
      ).resolves.toBeUndefined();
    },
  );

  test.runIf(process.platform !== 'win32')(
    'an unparseable git version still checks through merge-tree',
    async () => {
      const incoming = await divergeWith(() => pushSymlinks({ 'notes/leak.md': '../.git/config' }));
      const failure = await assertIncomingSymlinksSafe(
        gitReportingVersion('git version unknown-build'),
        incoming,
        'merge',
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect((failure as UnsafeIncomingSymlinkError).unsafe).toEqual([
        { path: 'notes/leak.md', reason: 'private-state' },
      ]);
    },
  );

  test.runIf(process.platform !== 'win32')(
    'fails closed on a merge-tree conflict record it cannot parse',
    async () => {
      const binary = join(tmpDir, 'stageless-git');
      writeFileSync(
        binary,
        '#!/bin/sh\nif [ "$1" = merge-tree ]; then git "$@" | perl -0pe \'s/ [123]\\t/\\t/g\'; exit 0; fi\nexec git "$@"\n',
        'utf-8',
      );
      execFileSync('chmod', ['755', binary]);
      await pushSymlinks({ 'notes/alias.md': 'real.md' });
      await pullWithEngine();
      rmSync(join(projectDir, 'notes', 'alias.md'));
      symlinkSync('../.git/config', join(projectDir, 'notes', 'alias.md'));
      await project.add('notes/alias.md');
      await project.commit('local link');
      const incoming = await divergeWith(() => pushSymlinks({ 'notes/alias.md': 'other.md' }));

      await expect(
        assertIncomingSymlinksSafe(simpleGit({ baseDir: projectDir, binary }), incoming, 'merge'),
      ).rejects.toThrow('unparseable git merge-tree record while inspecting incoming symlinks');
    },
  );

  test('refuses to resolve an incoming ref that does not exist', async () => {
    await expect(resolveIncomingCommit(project, 'origin/missing')).rejects.toThrow(
      /cannot resolve the incoming commit/,
    );
  });

  test('a branch name never reaches the error text the engine classifies', async () => {
    const failure = await resolveIncomingCommit(project, 'refs/remotes/origin/fix-403').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(classifyGitError(failure).class).not.toBe('auth');
  });

  test('refuses to vouch for a commit it cannot inspect', async () => {
    await expect(assertIncomingSymlinksSafe(project, '0'.repeat(40), 'merge')).rejects.toThrow();
  });

  test('fails closed with the cause attached when link targets cannot be read', async () => {
    await pushSymlinks({ 'notes/alias.md': 'real.md' });
    await project.fetch('origin', 'main');

    const failure = await assertIncomingSymlinksSafe(project, 'refs/remotes/origin/main', 'merge', {
      PATH: join(tmpDir, 'no-git-here'),
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'could not read incoming symlink targets from git (spawn)',
    );
    expect(failure).toMatchObject({ failure: 'spawn', detail: 'ENOENT', stderr: '' });
    expect(classifyGitError(failure).class).toBe('local');
  });
});

describe('UnsafeIncomingSymlinkError', () => {
  test('keeps remote-controlled paths out of the message', () => {
    const error = new UnsafeIncomingSymlinkError([
      { path: 'notes/connection refused.md', reason: 'private-state' },
    ]);
    expect(error.message).not.toContain('connection refused');
    expect(error.describeLinks()).toContain('"notes/connection refused.md"');
  });

  test('escapes control, C1, and bidirectional formatting characters in described paths', () => {
    const error = new UnsafeIncomingSymlinkError([
      {
        path: 'notes/\u001b]0;pwned\u0007\u007f\u009b31m\u202egnp.md\u2066.md',
        reason: 'outside-repository',
      },
    ]);
    const described = error.describeLinks();
    for (const raw of ['\u001b', '\u0007', '\u007f', '\u009b', '\u202e', '\u2066']) {
      expect(described).not.toContain(raw);
    }
    expect(described).toContain('\\u007f');
    expect(described).toContain('\\u009b');
    expect(described).toContain('\\u202e');
    expect(described).toContain('\\u2066');
  });
});
