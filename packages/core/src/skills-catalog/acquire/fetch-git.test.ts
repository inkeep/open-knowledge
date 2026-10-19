import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import { fetchSource } from './fetch.ts';
import { parseSkillDir } from './parse.ts';

const OUTSIDE_SUBPATH_BLOB_BYTES = 2_000_000;
const POSIX_NAMES = process.platform !== 'win32';

const hermeticGitEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

let root: string;
let server: Server;
let port: number;
let bytesServed = 0;
let sparseCloneUsesCone: boolean;
let warn: MockInstance<typeof console.warn>;
const daemons = new Set<ChildProcess>();

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: hermeticGitEnv });
}

function writeRepoFile(repo: string, path: string, body: string | Buffer): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function sparseCloneSetsConeMode(repo: string): boolean {
  const probe = join(root, 'cone-probe');
  git(root, ['clone', '-q', '--sparse', '--no-checkout', repo, probe]);
  const cone = spawnSync('git', ['-C', probe, 'config', '--get', 'core.sparseCheckoutCone'], {
    env: hermeticGitEnv,
    encoding: 'utf8',
  });
  if (cone.status === 1) return false;
  if (cone.status !== 0) {
    throw new Error(
      `git config --get core.sparseCheckoutCone exited ${cone.status}: ${cone.stderr}`,
    );
  }
  return cone.stdout.trim() === 'true';
}

function servedUrl(repo: 'filtering' | 'non-filtering'): string {
  return `git://127.0.0.1:${port}/${repo}.git`;
}

function untilClosed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-fetch-git-'));
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, ['init', '-q']);
  configureTestGitRepository(source);
  writeRepoFile(source, 'skills/alpha/SKILL.md', '---\nname: alpha\ndescription: a\n---\n');
  writeRepoFile(source, 'skills/alpha/references/guide.md', 'guide\n');
  writeRepoFile(source, 'skills/beta/SKILL.md', '---\nname: beta\ndescription: b\n---\n');
  writeRepoFile(source, 'assets/blob.bin', randomBytes(OUTSIDE_SUBPATH_BLOB_BYTES));
  if (POSIX_NAMES) {
    symlinkSync('/etc/passwd', join(source, 'skills/alpha/link'));
    writeRepoFile(source, '"quoted"/SKILL.md', '---\nname: quoted\ndescription: q\n---\n');
  }
  git(source, ['add', '-A']);
  git(source, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

  const served = join(root, 'served');
  for (const [name, allowFilter] of [
    ['filtering', 'true'],
    ['non-filtering', 'false'],
  ] as const) {
    const bare = join(served, `${name}.git`);
    git(root, ['clone', '-q', '--bare', source, bare]);
    configureTestGitRepository(bare);
    git(bare, ['config', 'uploadpack.allowFilter', allowFilter]);
    git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'false']);
    git(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'false']);
  }
  sparseCloneUsesCone = sparseCloneSetsConeMode(join(served, 'filtering.git'));

  server = createServer((socket) => {
    const daemon = spawn(
      'git',
      ['daemon', '--inetd', `--base-path=${served}`, '--export-all', served],
      { env: hermeticGitEnv, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    daemons.add(daemon);
    daemon.once('close', () => {
      daemons.delete(daemon);
      socket.end();
    });
    daemon.stdout.on('data', (chunk: Buffer) => {
      bytesServed += chunk.length;
    });
    socket.on('error', () => daemon.stdin.destroy());
    daemon.stdin.on('error', () => {});
    socket.pipe(daemon.stdin);
    daemon.stdout.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const daemon of daemons) daemon.kill();
  await Promise.all([...daemons].map(untilClosed));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  bytesServed = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  warn.mockRestore();
  await Promise.all([...daemons].map(untilClosed));
});

describe('fetchSource from a git server', () => {
  test('a subpath import neither checks out nor downloads the other folders', async () => {
    const fetched = await fetchSource({
      kind: 'git',
      url: servedUrl('filtering'),
      subpath: 'skills/alpha',
    });
    try {
      expect(parseSkillDir(fetched.dir)?.name).toBe('alpha');
      expect(existsSync(join(fetched.dir, 'references', 'guide.md'))).toBe(true);
      expect(existsSync(join(fetched.dir, '..', 'beta'))).toBe(false);
      expect(bytesServed).toBeLessThan(OUTSIDE_SUBPATH_BLOB_BYTES);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      fetched.cleanup();
    }
  });

  test('an import without a subpath still checks out and downloads the whole repository', async () => {
    const fetched = await fetchSource({ kind: 'git', url: servedUrl('filtering') });
    try {
      expect(parseSkillDir(join(fetched.dir, 'skills', 'alpha'))?.name).toBe('alpha');
      expect(parseSkillDir(join(fetched.dir, 'skills', 'beta'))?.name).toBe('beta');
      expect(statSync(join(fetched.dir, 'assets', 'blob.bin')).size).toBe(
        OUTSIDE_SUBPATH_BLOB_BYTES,
      );
      expect(bytesServed).toBeGreaterThan(OUTSIDE_SUBPATH_BLOB_BYTES);
    } finally {
      fetched.cleanup();
    }
  });

  test('a subpath missing from the repository is still reported as not found', async () => {
    await expect(
      fetchSource({ kind: 'git', url: servedUrl('filtering'), subpath: 'skills/missing' }),
    ).rejects.toThrow('subpath not found in repo: skills/missing');
    expect(bytesServed).toBeGreaterThan(0);
    expect(bytesServed).toBeLessThan(OUTSIDE_SUBPATH_BLOB_BYTES);
  });

  test('a subpath that escapes the repository is still refused', async () => {
    await expect(
      fetchSource({ kind: 'git', url: servedUrl('filtering'), subpath: '../../../etc' }),
    ).rejects.toThrow('subpath escapes the clone: ../../../etc');
  });

  test.runIf(POSIX_NAMES)('a symlink inside the subpath arrives as a plain file', async () => {
    const fetched = await fetchSource({
      kind: 'git',
      url: servedUrl('filtering'),
      subpath: 'skills/alpha',
    });
    try {
      expect(existsSync(join(fetched.dir, 'link'))).toBe(true);
      expect(lstatSync(join(fetched.dir, 'link')).isSymbolicLink()).toBe(false);
    } finally {
      fetched.cleanup();
    }
  });

  test('a server that ignores the blob filter still yields the subpath', async () => {
    const fetched = await fetchSource({
      kind: 'git',
      url: servedUrl('non-filtering'),
      subpath: 'skills/alpha',
    });
    try {
      expect(bytesServed).toBeGreaterThan(OUTSIDE_SUBPATH_BLOB_BYTES);
      expect(parseSkillDir(fetched.dir)?.name).toBe('alpha');
      expect(existsSync(join(fetched.dir, 'references', 'guide.md'))).toBe(true);
    } finally {
      fetched.cleanup();
    }
  });

  test('a server that cannot send the subpath on demand falls back to the whole repository', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.version');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '0');
    const fetched = await fetchSource({
      kind: 'git',
      url: servedUrl('filtering'),
      subpath: 'skills/alpha',
    });
    try {
      expect(bytesServed).toBeGreaterThan(OUTSIDE_SUBPATH_BLOB_BYTES);
      expect(warn).toHaveBeenCalledWith(
        '[skills-catalog] sparse clone failed, cloning the whole repository',
        expect.objectContaining({ subpath: 'skills/alpha', err: expect.any(Error) }),
      );
      expect(parseSkillDir(fetched.dir)?.name).toBe('alpha');
      expect(existsSync(join(fetched.dir, 'references', 'guide.md'))).toBe(true);
    } finally {
      fetched.cleanup();
    }
  });

  test.runIf(POSIX_NAMES)(
    'a quoted subpath is imported, falling back to the whole repository where cone mode cannot select it',
    async () => {
      const fetched = await fetchSource({
        kind: 'git',
        url: servedUrl('filtering'),
        subpath: '"quoted"',
      });
      try {
        expect(parseSkillDir(fetched.dir)?.name).toBe('quoted');
        if (sparseCloneUsesCone) {
          expect(bytesServed).toBeGreaterThan(OUTSIDE_SUBPATH_BLOB_BYTES);
          expect(warn).toHaveBeenCalledWith(
            '[skills-catalog] sparse checkout left the subpath unselected, cloning the whole repository',
            expect.objectContaining({ subpath: '"quoted"' }),
          );
        } else {
          expect(bytesServed).toBeLessThan(OUTSIDE_SUBPATH_BLOB_BYTES);
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        fetched.cleanup();
      }
    },
  );
});
