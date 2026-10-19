import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import { REFUSED_LOOPBACK_ORIGIN } from '../../../../../test-support/refused-loopback.test-helper.ts';
import {
  fetchSource,
  fetchSourceListing,
  SkillFetchError,
  SkillSubpathNotFoundError,
} from './fetch.ts';
import { discoverSkillDirs, parseSkillDir, readSkillDirMeta } from './parse.ts';

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

function gitWithInput(cwd: string, args: readonly string[], input: string): string {
  return execFileSync('git', args, { cwd, input, env: hermeticGitEnv }).toString().trim();
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

function listedSkills(dir: string): Array<{ folder: string; name: string; description: string }> {
  return discoverSkillDirs(dir).map((d) => {
    const meta = readSkillDirMeta(d.dir);
    return {
      folder: relative(dir, d.dir).split(sep).join('/'),
      name: meta?.name ?? d.name,
      description: meta?.description ?? '',
    };
  });
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
  writeRepoFile(
    source,
    'skills/beta/upstream/SKILL.md',
    '---\nname: nested\ndescription: n\n---\n',
  );
  writeRepoFile(
    source,
    'tools/scripts/helper/SKILL.md',
    '---\nname: helper\ndescription: h\n---\n',
  );
  writeRepoFile(source, 'assets/blob.bin', randomBytes(OUTSIDE_SUBPATH_BLOB_BYTES));
  if (POSIX_NAMES) {
    symlinkSync('/etc/passwd', join(source, 'skills/alpha/link'));
    writeRepoFile(source, '"quoted"/SKILL.md', '---\nname: quoted\ndescription: q\n---\n');
    mkdirSync(join(source, 'linked'));
    symlinkSync('/etc/passwd', join(source, 'linked/SKILL.md'));
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
  vi.stubEnv('LC_ALL', 'C');
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

async function wholeCloneSkills(): Promise<ReturnType<typeof listedSkills>> {
  const whole = await fetchSource({ kind: 'git', url: servedUrl('filtering') });
  try {
    return listedSkills(whole.dir);
  } finally {
    whole.cleanup();
    bytesServed = 0;
  }
}

describe('fetchSourceListing from a git server', () => {
  test('a repository listing finds the same skills as a whole clone but downloads only their SKILL.md files', async () => {
    const expected = await wholeCloneSkills();
    expect(expected.map((s) => s.folder).sort()).toEqual(
      [...(POSIX_NAMES ? ['"quoted"', 'linked'] : []), 'skills/alpha', 'skills/beta'].sort(),
    );
    const listing = await fetchSourceListing({ kind: 'git', url: servedUrl('filtering') });
    try {
      expect(listedSkills(listing.dir)).toEqual(expected);
      expect(existsSync(join(listing.dir, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(listing.dir, 'skills', 'alpha', 'references', 'guide.md'))).toBe(
        false,
      );
      expect(bytesServed).toBeLessThan(OUTSIDE_SUBPATH_BLOB_BYTES);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      listing.cleanup();
    }
  });

  test('a listing from a server that ignores the blob filter finds the same skills', async () => {
    const expected = await wholeCloneSkills();
    const listing = await fetchSourceListing({ kind: 'git', url: servedUrl('non-filtering') });
    try {
      expect(bytesServed).toBeGreaterThan(OUTSIDE_SUBPATH_BLOB_BYTES);
      expect(listedSkills(listing.dir)).toEqual(expected);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      listing.cleanup();
    }
  });

  test('a listing from a server that cannot send SKILL.md files on demand falls back to the whole repository', async () => {
    const expected = await wholeCloneSkills();
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.version');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '0');
    const listing = await fetchSourceListing({ kind: 'git', url: servedUrl('filtering') });
    try {
      expect(warn).toHaveBeenCalledWith(
        '[skills-catalog] skill listing clone failed, cloning the whole repository',
        expect.objectContaining({ err: expect.any(Error) }),
      );
      expect(listing.fetchFolders).toBeUndefined();
      expect(listedSkills(listing.dir)).toEqual(expected);
      expect(existsSync(join(listing.dir, 'skills', 'alpha', 'references', 'guide.md'))).toBe(true);
    } finally {
      listing.cleanup();
    }
  });

  test.runIf(POSIX_NAMES)('a symlinked SKILL.md in a listing arrives as a plain file', async () => {
    const listing = await fetchSourceListing({ kind: 'git', url: servedUrl('filtering') });
    try {
      expect(existsSync(join(listing.dir, 'linked', 'SKILL.md'))).toBe(true);
      expect(lstatSync(join(listing.dir, 'linked', 'SKILL.md')).isSymbolicLink()).toBe(false);
    } finally {
      listing.cleanup();
    }
  });

  test('a listing refuses a transport outside the allow-list without running git', async () => {
    const marker = join(root, 'ext-transport-ran');
    await expect(
      fetchSourceListing({ kind: 'git', url: `ext::sh -c touch% ${marker}` }),
    ).rejects.toThrow('Unsupported git transport');
    expect(existsSync(marker)).toBe(false);
  });

  test('a source that names a folder is fetched exactly as fetchSource fetches it', async () => {
    const listing = await fetchSourceListing({
      kind: 'git',
      url: servedUrl('filtering'),
      subpath: 'skills/alpha',
    });
    try {
      expect(listing.fetchFolders).toBeUndefined();
      expect(parseSkillDir(listing.dir)?.name).toBe('alpha');
      expect(existsSync(join(listing.dir, 'references', 'guide.md'))).toBe(true);
      expect(existsSync(join(listing.dir, '..', 'beta'))).toBe(false);
      expect(bytesServed).toBeLessThan(OUTSIDE_SUBPATH_BLOB_BYTES);
    } finally {
      listing.cleanup();
    }
  });

  test('fetchFolders checks out only the chosen skill folders, whole, without downloading the rest', async () => {
    const listing = await fetchSourceListing({ kind: 'git', url: servedUrl('filtering') });
    const fetchFolders = listing.fetchFolders;
    if (fetchFolders === undefined) throw new Error('expected a partial listing');
    try {
      const content = await fetchFolders(['skills/alpha', 'skills/beta']);
      try {
        expect(parseSkillDir(join(content.dir, 'skills', 'alpha'))?.name).toBe('alpha');
        expect(existsSync(join(content.dir, 'skills', 'alpha', 'references', 'guide.md'))).toBe(
          true,
        );
        expect(parseSkillDir(join(content.dir, 'skills', 'beta'))?.name).toBe('beta');
        expect(existsSync(join(content.dir, 'assets', 'blob.bin'))).toBe(false);
        expect(bytesServed).toBeLessThan(OUTSIDE_SUBPATH_BLOB_BYTES);
        expect(content.ref).toBe(listing.ref);
        if (POSIX_NAMES) {
          expect(lstatSync(join(content.dir, 'skills', 'alpha', 'link')).isSymbolicLink()).toBe(
            false,
          );
        }
      } finally {
        content.cleanup();
      }
    } finally {
      listing.cleanup();
    }
  });

  test('fetchFolders refuses a folder that escapes the repository before contacting the server', async () => {
    const listing = await fetchSourceListing({ kind: 'git', url: servedUrl('filtering') });
    const fetchFolders = listing.fetchFolders;
    if (fetchFolders === undefined) throw new Error('expected a partial listing');
    try {
      const served = bytesServed;
      await expect(fetchFolders(['skills/alpha', '../../../etc'])).rejects.toThrow(
        'subpath escapes the clone: ../../../etc',
      );
      expect(bytesServed).toBe(served);
    } finally {
      listing.cleanup();
    }
  });

  test('fetchFolders reports a listed folder removed upstream since the listing as not found and keeps no clone', async () => {
    const name = `changing-${randomBytes(6).toString('hex')}`;
    const bare = join(root, 'served', `${name}.git`);
    git(root, ['clone', '-q', '--bare', join(root, 'source'), bare]);
    configureTestGitRepository(bare);
    git(bare, ['config', 'uploadpack.allowFilter', 'true']);
    const listing = await fetchSourceListing({
      kind: 'git',
      url: `git://127.0.0.1:${port}/${name}.git`,
    });
    const fetchFolders = listing.fetchFolders;
    if (fetchFolders === undefined) throw new Error('expected a partial listing');
    try {
      expect(listedSkills(listing.dir).map((s) => s.folder)).toContain('skills/beta');
      const work = join(root, `${name}-work`);
      git(root, ['clone', '-q', bare, work]);
      configureTestGitRepository(work);
      git(work, ['rm', '-q', '-r', 'skills/beta']);
      git(work, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'drop beta']);
      git(work, ['push', '-q', 'origin', 'HEAD']);

      const scratch = mkdtempSync(join(root, 'fetch-folders-tmp-'));
      vi.stubEnv('TMPDIR', scratch);
      vi.stubEnv('TMP', scratch);
      vi.stubEnv('TEMP', scratch);
      const present = await fetchFolders(['skills/alpha']);
      try {
        expect(dirname(present.dir)).toBe(scratch);
        expect(parseSkillDir(join(present.dir, 'skills', 'alpha'))?.name).toBe('alpha');
      } finally {
        present.cleanup();
      }
      expect(readdirSync(scratch)).toEqual([]);

      const failure = await fetchFolders(['skills/alpha', 'skills/beta']).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(SkillSubpathNotFoundError);
      expect(failure).toMatchObject({ message: 'subpath not found in repo: skills/beta' });
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      listing.cleanup();
    }
  });
});

describe('git fetch errors', () => {
  test('a missing subpath is reported with its own error type', async () => {
    await expect(
      fetchSource({ kind: 'git', url: servedUrl('filtering'), subpath: 'skills/missing' }),
    ).rejects.toBeInstanceOf(SkillSubpathNotFoundError);
  });

  test('a whole-repository clone failure gives the reason git printed once, without the git command line or temporary folder', async () => {
    const missing = `git://127.0.0.1:${port}/missing.git`;
    for (const attempt of [
      () => fetchSource({ kind: 'git', url: missing, subpath: 'skills/alpha' }),
      () => fetchSourceListing({ kind: 'git', url: missing }),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SkillFetchError);
      const message = (error as Error).message;
      expect(message).toMatch(
        /^git clone failed for git:\/\/127\.0\.0\.1:\d+\/missing\.git: fatal: remote error: [^\n]*\/missing\.git$/,
      );
      expect(message.match(/fatal: remote error/g)).toHaveLength(1);
      expect(message).not.toContain('Fetching only part of the repository');
      expect(message).not.toContain('Command failed');
      expect(message).not.toContain('ok-skill-import-');
    }
  });

  test('when the whole-repository clone fails for another reason, the error also says why the partial fetch failed first', async () => {
    const name = `unsafe-path-${randomBytes(6).toString('hex')}`;
    const bare = join(root, 'served', `${name}.git`);
    git(root, ['init', '-q', '--bare', bare]);
    configureTestGitRepository(bare);
    git(bare, ['config', 'uploadpack.allowFilter', 'true']);
    const skill = gitWithInput(
      bare,
      ['hash-object', '-w', '--stdin'],
      '---\nname: unsafe\ndescription: u\n---\n',
    );
    const folder = gitWithInput(bare, ['mktree'], `100644 blob ${skill}\tSKILL.md\n`);
    const reserved = gitWithInput(bare, ['mktree'], `040000 tree ${folder}\tGIT~1\n`);
    const top = gitWithInput(bare, ['mktree'], `040000 tree ${reserved}\tunsafe\n`);
    const commit = gitWithInput(
      bare,
      ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit-tree', '-m', 'init', top],
      '',
    );
    git(bare, ['update-ref', 'refs/heads/main', commit]);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const url = `git://127.0.0.1:${port}/${name}.git`;

    const error = await fetchSourceListing({ kind: 'git', url }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SkillFetchError);
    const message = (error as Error).message;
    const partialReason = "error: invalid path 'unsafe/GIT~1/SKILL.md'";
    const opening = `git clone failed for ${url}: ${partialReason}\n`;
    expect(message.slice(0, opening.length)).toBe(opening);
    expect(message).toContain('fatal: unable to checkout working tree');
    const closing = `. Fetching only part of the repository had failed first: ${partialReason}`;
    expect(message.slice(-closing.length)).toBe(closing);
    expect(message).not.toContain('Command failed');
    expect(message).not.toContain('ok-skill-import-');
  });

  test('a fetch that runs out of time says it hit the 60-second limit instead of listing git arguments', async () => {
    for (const attempt of [
      () => fetchSource({ kind: 'git', url: servedUrl('filtering') }),
      () => fetchSource({ kind: 'git', url: servedUrl('filtering'), subpath: 'skills/alpha' }),
      () => fetchSourceListing({ kind: 'git', url: servedUrl('filtering') }),
    ]) {
      const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(61_000);
      onTestFinished(() => clock.mockRestore());
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      clock.mockRestore();
      expect(error).toBeInstanceOf(SkillFetchError);
      expect((error as Error).message).toBe(
        `Fetching ${servedUrl('filtering')} hit the 60-second limit.`,
      );
    }
    expect(bytesServed).toBe(0);
  });

  test('credentials in a source URL stay out of errors and warnings', async () => {
    const url = `${REFUSED_LOOPBACK_ORIGIN.replace('http://', 'http://someone:hunter2-secret@')}/team/skills.git`;
    for (const attempt of [
      () => fetchSource({ kind: 'git', url, subpath: 'skills/alpha' }),
      () => fetchSourceListing({ kind: 'git', url }),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SkillFetchError);
      expect((error as Error).message).toContain('http://***@127.0.0.1:4/team/skills.git');
      expect((error as Error).message).not.toContain('hunter2-secret');
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(warn.mock.calls, (_k, v) => (v instanceof Error ? v.message : v)),
    ).not.toContain('hunter2-secret');
  });
});
