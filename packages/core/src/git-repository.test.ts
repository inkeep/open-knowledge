import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { discoverGitRepository, inspectGitRepository } from './git-repository.ts';

interface RemoteUrlFixture {
  readonly name: string;
  readonly config: string;
  readonly expected: string | null;
}

const REMOTE_URL_FIXTURES: readonly RemoteUrlFixture[] = [
  {
    name: 'canonical HTTPS origin',
    config: '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n',
    expected: 'https://github.com/owner/repo.git',
  },
  {
    name: 'SSH origin',
    config: '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n',
    expected: 'git@github.com:owner/repo.git',
  },
  {
    name: 'whitespace inside the section header',
    config: '[ remote "origin" ]\n\turl = https://github.com/owner/repo.git\n',
    expected: 'https://github.com/owner/repo.git',
  },
  {
    name: 'single-quoted section header',
    config: "[remote 'origin']\n\turl = https://github.com/owner/repo.git\n",
    expected: 'https://github.com/owner/repo.git',
  },
  {
    name: 'inline semicolon comment',
    config: '[remote "origin"]\n\turl = https://github.com/o/r.git ; legacy origin\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'inline hash comment',
    config: '[remote "origin"]\n\turl = https://github.com/o/r.git # primary\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'CRLF line endings',
    config: '[remote "origin"]\r\n\turl = https://github.com/o/r.git\r\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'quoted URL value',
    config: '[remote "origin"]\n\turl = "https://github.com/o/r.git"\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'absent origin section',
    config:
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/forky/spoon.git\n',
    expected: null,
  },
  { name: 'empty config', config: '', expected: null },
  {
    name: 'origin section without a URL',
    config: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    expected: null,
  },
  {
    name: 'empty URL before a configured URL',
    config: '[remote "origin"]\n\turl =\n\turl = https://github.com/owner/repository.git\n',
    expected: 'https://github.com/owner/repository.git',
  },
];

describe('inspectGitRepository', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'ok-git-repository-'));
    temporaryDirectories.push(path);
    return path;
  }

  test('reads worktree HEAD from the git dir and origin from the common dir', async () => {
    const root = await makeTemporaryDirectory();

    const projectRoot = join(root, 'worktree');
    const commonDir = join(root, 'main', '.git');
    const gitDir = join(commonDir, 'worktrees', 'feature');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(projectRoot, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/deep-inspection\n');
    writeFileSync(
      join(commonDir, 'config'),
      '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
    );

    const result = inspectGitRepository(projectRoot);

    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    expect(result.repository.kind).toBe('linked');
    expect(result.repository.gitDir).toBe(gitDir);
    expect(result.repository.readCommonDir()).toEqual({
      kind: 'resolved',
      path: resolve(gitDir, '../..'),
    });
    expect(result.repository.readHead()).toEqual({
      kind: 'branch',
      branch: 'feature/deep-inspection',
      ref: 'refs/heads/feature/deep-inspection',
    });
    expect(result.repository.readRemoteUrl('origin')).toEqual({
      kind: 'configured',
      url: 'git@github.com:inkeep/open-knowledge.git',
    });
  });

  test.runIf(process.platform !== 'win32')(
    'reports an unreadable common-dir pointer without falling back to the worktree git dir',
    async () => {
      const root = await makeTemporaryDirectory();
      const projectRoot = join(root, 'worktree');
      const gitDir = join(root, 'worktree-state');
      mkdirSync(projectRoot);
      mkdirSync(gitDir);
      writeFileSync(join(projectRoot, '.git'), `gitdir: ${gitDir}\n`);
      symlinkSync('commondir', join(gitDir, 'commondir'));

      const result = inspectGitRepository(projectRoot);

      expect(result.kind).toBe('repository');
      if (result.kind !== 'repository') return;
      expect(result.repository.readCommonDir().kind).toBe('unreadable');
      expect(result.repository.readRemoteUrl('origin').kind).toBe('unreadable');
      expect(result.repository.readRef('refs/heads/main').kind).toBe('unreadable');

      const commonDir = join(root, 'common');
      rmSync(join(gitDir, 'commondir'));
      mkdirSync(commonDir);
      writeFileSync(join(gitDir, 'commondir'), `${commonDir}\n`);
      expect(result.repository.readCommonDir()).toEqual({ kind: 'resolved', path: commonDir });
    },
  );

  test('keeps exact-root inspection distinct from enclosing-working-tree discovery', async () => {
    const root = await makeTemporaryDirectory();

    const projectRoot = join(root, 'repo', 'docs', 'handbook');
    const repositoryRoot = join(root, 'repo');
    mkdirSync(join(repositoryRoot, '.git'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    expect(inspectGitRepository(projectRoot)).toEqual({ kind: 'absent' });

    const discovered = discoverGitRepository(projectRoot);
    expect(discovered.kind).toBe('repository');
    if (discovered.kind !== 'repository') return;
    expect(discovered.repository.projectRoot).toBe(repositoryRoot);
    expect(discovered.repository.projectSubPath).toBe(join('docs', 'handbook'));
  });

  test('rejects a linked-worktree pointer whose target no longer exists', async () => {
    const root = await makeTemporaryDirectory();
    writeFileSync(join(root, '.git'), 'gitdir: ../missing-worktree-state\n');

    const result = inspectGitRepository(root);

    expect(result.kind).toBe('malformed-pointer');
    if (result.kind !== 'malformed-pointer') return;
    expect(result.gitPath).toBe(join(root, '.git'));
    expect(result.target).toBe(resolve(root, '../missing-worktree-state'));
  });

  test('rejects a worktree pointer with extra lines around the gitdir', async () => {
    const root = await makeTemporaryDirectory();
    const gitDir = join(root, 'worktree-state');
    mkdirSync(gitDir);
    for (const contents of [`unexpected\ngitdir: ${gitDir}\n`, `gitdir:\n${gitDir}\n`]) {
      writeFileSync(join(root, '.git'), contents);
      expect(inspectGitRepository(root)).toMatchObject({
        kind: 'malformed-pointer',
        gitPath: join(root, '.git'),
        target: '',
      });
    }
  });

  test('does not discover a repository rooted at the home directory', async () => {
    const root = await makeTemporaryDirectory();
    mkdirSync(join(root, '.git'));

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(inspectGitRepository(root).kind).toBe('repository');
      expect(discoverGitRepository(root)).toEqual({ kind: 'absent' });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test.runIf(process.platform !== 'win32')(
    'stops at an inaccessible ancestor instead of selecting a repository above it',
    async () => {
      const root = await makeTemporaryDirectory();
      const repositoryRoot = join(root, 'repository');
      const inaccessibleAncestor = join(repositoryRoot, 'inaccessible');
      const projectRoot = join(inaccessibleAncestor, 'project');
      mkdirSync(join(repositoryRoot, '.git'), { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      symlinkSync('.git', join(inaccessibleAncestor, '.git'));

      const result = discoverGitRepository(projectRoot);

      expect(result.kind).toBe('inaccessible');
      if (result.kind !== 'inaccessible') return;
      expect(result.gitPath).toBe(join(inaccessibleAncestor, '.git'));
    },
  );

  test('accepts a SHA-256 object id for detached HEAD', async () => {
    const root = await makeTemporaryDirectory();
    const gitDir = join(root, '.git');
    const oid = '0123456789abcdef'.repeat(4);
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), `${oid}\n`);

    const result = inspectGitRepository(root);

    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    expect(result.repository.readHead()).toEqual({ kind: 'detached', oid });
  });

  test('resolves packed refs from the common directory', async () => {
    const root = await makeTemporaryDirectory();

    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'packed-refs'),
      '0123456789abcdef0123456789abcdef01234567 refs/remotes/origin/feature/deep-inspection\n',
    );

    const result = inspectGitRepository(root);
    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    expect(result.repository.readRef('refs/remotes/origin/feature/deep-inspection')).toEqual({
      kind: 'present',
      storage: 'packed',
      value: {
        kind: 'oid',
        oid: '0123456789abcdef0123456789abcdef01234567',
      },
    });
  });

  test('reads the oid stored in a loose ref', async () => {
    const root = await makeTemporaryDirectory();

    const gitDir = join(root, '.git');
    const refDir = join(gitDir, 'refs', 'heads');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'main'), 'fedcba9876543210fedcba9876543210fedcba98\n');

    const result = inspectGitRepository(root);
    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    expect(result.repository.readRef('refs/heads/main')).toEqual({
      kind: 'present',
      storage: 'loose',
      value: {
        kind: 'oid',
        oid: 'fedcba9876543210fedcba9876543210fedcba98',
      },
    });
  });

  test('reports malformed loose and packed object ids', async () => {
    const root = await makeTemporaryDirectory();

    const gitDir = join(root, '.git');
    const refDir = join(gitDir, 'refs', 'heads');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'main'), 'not-an-object-id\n');

    const result = inspectGitRepository(root);
    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    expect(result.repository.readRef('refs/heads/main')).toEqual({
      kind: 'malformed',
      raw: 'not-an-object-id',
    });

    rmSync(join(refDir, 'main'));
    writeFileSync(join(gitDir, 'packed-refs'), 'not-an-object-id refs/heads/main\n');
    expect(result.repository.readRef('refs/heads/main')).toEqual({
      kind: 'malformed',
      raw: 'not-an-object-id refs/heads/main',
    });
  });

  test('ref inspection rejects unsafe paths before filesystem access', async () => {
    const root = await makeTemporaryDirectory();
    mkdirSync(join(root, '.git'), { recursive: true });

    const result = inspectGitRepository(root);
    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    for (const ref of [
      'refs/remotes/origin/../../config',
      'heads/main',
      'refs/heads/ma\0in',
      'refs/heads/ma\\in',
      'refs/heads//main',
      'refs/heads/main/',
    ]) {
      expect(result.repository.readRef(ref)).toEqual({ kind: 'invalid' });
    }
  });

  describe('readRemoteUrl', () => {
    for (const fixture of REMOTE_URL_FIXTURES) {
      test(fixture.name, async () => {
        const root = await makeTemporaryDirectory();
        const gitDir = join(root, '.git');
        mkdirSync(gitDir, { recursive: true });
        writeFileSync(join(gitDir, 'config'), fixture.config);

        const result = inspectGitRepository(root);
        expect(result.kind).toBe('repository');
        if (result.kind !== 'repository') return;

        const remote = result.repository.readRemoteUrl('origin');
        expect(remote).toEqual(
          fixture.expected === null
            ? { kind: 'absent', reason: 'remote-missing' }
            : { kind: 'configured', url: fixture.expected },
        );
      });
    }
  });
});
