import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertMergeNameResolvesTo,
  type Config,
  UnsafeIncomingSymlinkError,
} from '@inkeep/open-knowledge-server';
import simpleGit, { type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { FileBackend } from '../auth/token-store.ts';
import { runSync, syncFailureMessage } from './sync.ts';

const CLI_ENTRY = fileURLToPath(new URL('../cli.ts', import.meta.url));

let tmpDir = '';
let projectDir = '';
let sister: SimpleGit;
let project: SimpleGit;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-pull-incoming-symlinks-'));
  const bareDir = join(tmpDir, 'bare.git');
  const sisterDir = join(tmpDir, 'sister');
  projectDir = join(tmpDir, 'project');
  mkdirSync(bareDir, { recursive: true });
  await simpleGit(bareDir).init(true);
  configureTestGitRepository(bareDir);
  await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

  mkdirSync(join(sisterDir, 'notes'), { recursive: true });
  sister = simpleGit(sisterDir);
  await sister.init(['--initial-branch=main']);
  configureTestGitRepository(sisterDir);
  await sister.raw('config', 'user.name', 'Sister');
  await sister.raw('config', 'user.email', 'sister@test.com');
  writeFileSync(join(sisterDir, 'notes', 'real.md'), '# real\n', 'utf-8');
  await sister.add('.');
  await sister.commit('base');
  await sister.addRemote('origin', bareDir);
  await sister.push('origin', 'main');

  await simpleGit(tmpDir).clone(bareDir, projectDir);
  configureTestGitRepository(projectDir);
  project = simpleGit(projectDir);
  await project.raw('config', 'user.name', 'Project');
  await project.raw('config', 'user.email', 'project@test.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function pushSymlink(path: string, target: string, remoteBranch = 'main'): Promise<void> {
  const targetFile = join(tmpDir, 'link-target.txt');
  writeFileSync(targetFile, target, 'utf-8');
  const blob = (await sister.raw('hash-object', '-w', targetFile)).trim();
  await sister.raw('update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
  await sister.commit('add symlink');
  await sister.push('origin', `HEAD:${remoteBranch}`);
}

async function narrowFetchToMain(): Promise<void> {
  await project.raw('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
}

function pullWithoutServer(): Promise<void> {
  return runSync(
    {
      json: true,
      op: 'pull',
      tokenStore: new FileBackend(join(tmpDir, 'auth.yml')),
      _detectGhFn: () => ({ available: false }),
    },
    {} as Config,
    projectDir,
  );
}

function existsAsEntry(relPath: string): boolean {
  try {
    lstatSync(join(projectDir, relPath));
    return true;
  } catch {
    return false;
  }
}

describe('ok pull refusal remedies', () => {
  test.each([
    [
      [{ path: 'a', reason: 'requires-newer-git' }],
      'Update Git to 2.38 or newer. Then pull again.',
    ],
    [
      [{ path: 'a', reason: 'unverifiable-target' }],
      'If a folder on the way is unreadable on this machine, make it readable. Remove or fix these links on the remote, or fix your own local change to them, then pull again.',
    ],
    [
      [{ path: 'a', reason: 'secret-file' }],
      'Remove or fix these links on the remote, or fix your own local change to them, then pull again.',
    ],
    [
      [
        { path: 'a', reason: 'requires-newer-git' },
        { path: 'b', reason: 'outside-repository' },
      ],
      'Update Git to 2.38 or newer. Remove or fix these links on the remote, or fix your own local change to them, then pull again.',
    ],
  ] as const)('names the remedy for %j', (unsafe, remedy) => {
    expect(syncFailureMessage(new UnsafeIncomingSymlinkError(unsafe)).endsWith(remedy)).toBe(true);
  });
});

describe('ok pull without a running server', () => {
  test('refuses a remote symlink into private state, naming it only when rendered', async () => {
    await pushSymlink('notes/leak.md', '../.git/config');

    const error = await pullWithoutServer().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnsafeIncomingSymlinkError);
    expect((error as Error).message).not.toContain('leak');
    expect(syncFailureMessage(error)).toBe(
      'incoming symlinks are unsafe to check out: "notes/leak.md" (points into private .git or OpenKnowledge state). Remove or fix these links on the remote, or fix your own local change to them, then pull again.',
    );
    expect(existsAsEntry('notes/leak.md')).toBe(false);
  });

  test("leaves git's own error for a branch with no upstream, without merging anything", async () => {
    await narrowFetchToMain();
    await project.raw('checkout', '-b', 'no-upstream');
    await pushSymlink('notes/leak.md', '../.git/config');

    await expect(pullWithoutServer()).rejects.toThrow(
      /no upstream configured for branch "no-upstream".*git branch --set-upstream-to=origin\/no-upstream no-upstream/,
    );
    expect(existsAsEntry('notes/leak.md')).toBe(false);
  });

  test('names the remedy on a detached HEAD, without merging anything', async () => {
    await project.raw('checkout', '--detach');
    await pushSymlink('notes/leak.md', '../.git/config');

    await expect(pullWithoutServer()).rejects.toThrow(/not on a branch.*git switch/);
    expect(existsAsEntry('notes/leak.md')).toBe(false);
  });

  test('pulls the inspected tracking ref by its full name, never a shadowable short name', async () => {
    await pushSymlink('notes/alias.md', 'real.md');
    const traceFile = join(tmpDir, 'git-trace.log');
    vi.stubEnv('GIT_TRACE', traceFile);

    await pullWithoutServer();
    const commands = readFileSync(traceFile, 'utf-8')
      .split('\n')
      .filter((line) => line.includes('trace: built-in: git '))
      .map((line) => line.slice(line.indexOf('git ')));
    expect(commands.filter((command) => command.startsWith('git pull'))).toEqual([
      'git pull . refs/remotes/origin/main',
    ]);
  });

  test('refuses to pull when the tracking ref moves after inspection', async () => {
    await pushSymlink('notes/alias.md', 'real.md');
    const inspected = (await sister.revparse(['HEAD'])).trim();
    await pushSymlink('notes/leak.md', '../.git/config', 'later');
    await project.fetch('origin', 'later');
    const later = (await project.revparse(['origin/later'])).trim();
    await project.fetch('origin', 'main');

    await expect(
      assertMergeNameResolvesTo(project, {
        name: 'refs/remotes/origin/main',
        trackingRef: 'refs/remotes/origin/main',
        commit: later,
      }),
    ).rejects.toThrow(/moved after its incoming symlinks were inspected/);
    await assertMergeNameResolvesTo(project, {
      name: 'refs/remotes/origin/main',
      trackingRef: 'refs/remotes/origin/main',
      commit: inspected,
    });
  });

  test('refuses to merge a short name that a tag shadows', async () => {
    await pushSymlink('notes/alias.md', 'real.md');
    await project.fetch('origin', 'main');
    const tracked = (await project.revparse(['refs/remotes/origin/main'])).trim();
    await project.raw('tag', 'origin/main', `${tracked}~1`);

    await expect(
      assertMergeNameResolvesTo(project, {
        name: 'origin/main',
        trackingRef: 'refs/remotes/origin/main',
        commit: tracked,
      }),
    ).rejects.toThrow(/shadows it/);
  });

  test('guards an upstream that is configured but not stored as a remote-tracking ref', async () => {
    await narrowFetchToMain();
    await sister.push('origin', 'main:feature');
    await project.raw('checkout', '-b', 'feature');
    await project.raw('config', 'branch.feature.remote', 'origin');
    await project.raw('config', 'branch.feature.merge', 'refs/heads/feature');
    await pushSymlink('notes/leak.md', '../.git/config', 'feature');

    await expect(pullWithoutServer()).rejects.toBeInstanceOf(UnsafeIncomingSymlinkError);
    expect(existsAsEntry('notes/leak.md')).toBe(false);
  });

  test('pulls a safe link through an upstream that is configured but not stored as a remote-tracking ref', async () => {
    await narrowFetchToMain();
    await sister.push('origin', 'main:feature');
    await project.raw('checkout', '-b', 'feature');
    await project.raw('config', 'branch.feature.remote', 'origin');
    await project.raw('config', 'branch.feature.merge', 'refs/heads/feature');
    await pushSymlink('notes/alias.md', 'real.md', 'feature');

    await pullWithoutServer();
    expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
  });

  test('still pulls an in-repository symlink', async () => {
    await pushSymlink('notes/alias.md', 'real.md');

    await pullWithoutServer();
    expect(readlinkSync(join(projectDir, 'notes', 'alias.md'))).toBe('real.md');
  });

  test('ok pull --json keeps stdout to JSON lines and reports the refused path in its error record', async () => {
    await pushSymlink('notes/leak.md', '../.git/config');
    const env = { ...process.env };
    for (const variable of ['NODE_ENV', 'LOG_LEVEL', 'OK_CONSOLE_LEVEL', 'OK_FILE_LEVEL']) {
      delete env[variable];
    }

    const result = spawnSync(
      process.execPath,
      ['--conditions=@inkeep/source', CLI_ENTRY, 'pull', '--json'],
      { cwd: projectDir, encoding: 'utf-8', env },
    );

    expect(result.status).toBe(1);
    const records = result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toEqual({
      type: 'error',
      message: expect.stringMatching(/"notes\/leak\.md" \(points into private.*on the remote/),
    });
    expect(existsAsEntry('notes/leak.md')).toBe(false);
  }, 60_000);
});
