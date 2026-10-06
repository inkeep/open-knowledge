import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { shellSingleQuote } from '@inkeep/open-knowledge-core';
import { UnsafeIncomingSymlinkError } from '@inkeep/open-knowledge-server';
import simpleGit, { GitPluginError, type SimpleGitOptions } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { startGitHubStandIn } from '../../tests/support/github-stand-in.test-helper.ts';
import type { GhDetectResult } from '../auth/gh-detect.ts';
import { FileBackend } from '../auth/token-store.ts';
import {
  buildCloneArgs,
  buildCloneAuthEnv,
  buildCloneEnv,
  buildCloneGitOptions,
  handleCloneFailure,
  resolveCloneAuth,
  runClone as runCloneProduct,
} from './clone.ts';

async function runClone(...args: Parameters<typeof runCloneProduct>) {
  const target = await runCloneProduct(...args);
  configureTestGitRepository(target);
  return target;
}

const relayTokenGh = (): GhDetectResult => ({ available: true, token: 'ghs_relay_probe' });

const agentHarnessGitConfig = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.interactive',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'credential.guiPrompt',
  GIT_CONFIG_VALUE_1: 'false',
};

function seedBareRepo(bareDir: string, readme: string): void {
  const seedDir = `${bareDir}.seed`;
  mkdirSync(seedDir, { recursive: true });
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(seedDir, ['init', '--initial-branch=main']);
  configureTestGitRepository(seedDir);
  writeFileSync(join(seedDir, 'README.md'), readme, 'utf-8');
  git(seedDir, ['add', 'README.md']);
  git(seedDir, [
    '-c',
    'user.name=Seed',
    '-c',
    'user.email=seed@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'seed',
  ]);
  git(dirname(bareDir), ['clone', '--bare', seedDir, bareDir]);
  configureTestGitRepository(bareDir);
}

function writeCredentialHelper(helperPath: string, reply: string): string {
  writeFileSync(
    helperPath,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      'readFileSync(0);',
      'const call = { argv: process.argv.slice(2), relayToken: process.env.OK_GH_TOKEN ?? null };',
      "appendFileSync(process.argv[1] + '.calls', JSON.stringify(call) + '\\n');",
      `if (process.argv.at(-1) === 'get') process.stdout.write(${JSON.stringify(`username=${reply}\npassword=${reply}-secret\n`)});`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return helperPath;
}

function helperCalls(helperPath: string): unknown[] {
  const callLog = `${helperPath}.calls`;
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

function helperConfigValue(helperPath: string): string {
  return `!${shellSingleQuote(process.execPath)} ${shellSingleQuote(helperPath)}`;
}

const TOKEN_HOST = 'git.example.test';

async function startHttpsTokenHost(root: string): Promise<{
  url: string;
  gitConfig: Array<[string, string]>;
  close: () => Promise<void>;
}> {
  mkdirSync(root, { recursive: true });
  const standIn = await startGitHubStandIn({
    root,
    acceptedPassword: 'stand-in-only',
    repositories: [],
    enterpriseHosts: { [TOKEN_HOST]: ['stand-in-only'] },
  });
  return {
    url: `https://${TOKEN_HOST}/o/r.git`,
    gitConfig: [
      ['http.proxy', standIn.proxyUrl],
      ['http.sslCAInfo', standIn.caFile],
      ['http.curloptResolve', `${TOKEN_HOST}:443:127.0.0.1`],
    ],
    close: standIn.close,
  };
}

function commandScopeConfig(entries: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

describe('clone honours the environment command-scope git config (GIT_CONFIG_COUNT)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ok-clone-envcfg-')));
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    vi.stubEnv('XDG_CONFIG_HOME', join(workspace, '.config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  test('runClone clones through an environment url rewrite and names the remote from the environment', async () => {
    seedBareRepo(join(workspace, 'o', 'r.git'), '# seeded through the environment\n');
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'url../.insteadOf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://127.0.0.1:1/');
    vi.stubEnv('GIT_CONFIG_KEY_1', 'clone.defaultRemoteName');
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'ok-env-remote');
    const targetDir = join(workspace, 'target');

    await expect(
      runClone(
        'https://127.0.0.1:1/o/r.git',
        { json: true, dir: 'target', _detectGhFn: relayTokenGh },
        {} as never,
        workspace,
      ),
    ).resolves.toBe(targetDir);

    expect(readFileSync(join(targetDir, 'README.md'), 'utf-8')).toBe(
      '# seeded through the environment\n',
    );
    expect(execFileSync('git', ['remote'], { cwd: targetDir, encoding: 'utf-8' }).trim()).toBe(
      'ok-env-remote',
    );
  });

  test("runClone asks the CLI's own credential helper and never an environment-configured one", async () => {
    const okHelper = writeCredentialHelper(join(workspace, 'ok-cli.mjs'), 'ok');
    const envHelper = writeCredentialHelper(join(workspace, 'env-helper.mjs'), 'env');
    const server = await startHttpsTokenHost(join(workspace, 'stand-in'));
    for (const [name, value] of Object.entries(
      commandScopeConfig([
        ['credential.helper', helperConfigValue(envHelper)],
        ...server.gitConfig,
      ]),
    )) {
      vi.stubEnv(name, value);
    }
    const cliEntry = process.argv[1];
    process.argv[1] = okHelper;
    try {
      await expect(
        runClone(
          server.url,
          { json: true, dir: 'target', _detectGhFn: relayTokenGh },
          {} as never,
          workspace,
        ),
      ).rejects.toThrow('Authentication failed');
    } finally {
      process.argv[1] = cliEntry;
      await server.close();
    }

    expect(helperCalls(okHelper)).toContainEqual({
      argv: ['auth', 'git-credential', 'get'],
      relayToken: 'ghs_relay_probe',
    });
    expect(helperCalls(envHelper)).toEqual([]);
  });

  test('the stored-token tier asks its own credential helper and never an environment-configured one', async () => {
    const okHelper = writeCredentialHelper(join(workspace, 'ok-cli.mjs'), 'ok');
    const envHelper = writeCredentialHelper(join(workspace, 'env-helper.mjs'), 'env');
    const tokenStore = new FileBackend(join(workspace, 'auth.yml'));
    await tokenStore.set(TOKEN_HOST, 'alice', 'ghp_stored_probe', { gitProtocol: 'https' });
    const server = await startHttpsTokenHost(join(workspace, 'stand-in'));
    try {
      const url = server.url;
      const { auth } = await resolveCloneAuth(url, tokenStore, {
        selfCliArgs: [process.execPath, okHelper],
        cwd: workspace,
        _detectGhFn: () => ({ available: false }),
      });
      expect(auth.tier).toBe('B');
      const git = simpleGit(
        buildCloneGitOptions(workspace, auth.gitConfig) as Partial<SimpleGitOptions>,
      ).env(
        buildCloneAuthEnv(auth, {
          PATH: process.env.PATH ?? '',
          HOME: workspace,
          GIT_CONFIG_NOSYSTEM: '1',
          ...commandScopeConfig([
            ['credential.helper', helperConfigValue(envHelper)],
            ...server.gitConfig,
          ]),
        }),
      );

      await expect(git.clone(url, join(workspace, 'target'), buildCloneArgs(null))).rejects.toThrow(
        'Authentication failed',
      );
    } finally {
      await server.close();
    }

    expect(helperCalls(okHelper)).toContainEqual({
      argv: ['auth', 'git-credential', 'get'],
      relayToken: null,
    });
    expect(helperCalls(envHelper)).toEqual([]);
  });

  test.each([
    {
      pair: 'share publish pair',
      open: async (dir: string, sourceEnv: NodeJS.ProcessEnv) =>
        simpleGit(buildCloneGitOptions(dir, []) as Partial<SimpleGitOptions>).env(
          buildCloneEnv(sourceEnv),
        ),
    },
    {
      pair: 'ok clone pair',
      open: async (dir: string, sourceEnv: NodeJS.ProcessEnv) => {
        const { auth } = await resolveCloneAuth(
          'https://github.com/o/r',
          new FileBackend(join(dir, 'auth.yml')),
          { selfCliArgs: ['open-knowledge'], cwd: dir, _detectGhFn: relayTokenGh },
        );
        return simpleGit(
          buildCloneGitOptions(dir, auth.gitConfig) as Partial<SimpleGitOptions>,
        ).env(buildCloneAuthEnv(auth, sourceEnv));
      },
    },
  ])(
    '$pair: git reads the environment credential.interactive at command scope',
    async ({ open }) => {
      const git = await open(workspace, {
        PATH: process.env.PATH ?? '',
        HOME: workspace,
        GIT_CONFIG_NOSYSTEM: '1',
        ...agentHarnessGitConfig,
      });

      await expect(
        git
          .raw(['config', '--show-scope', '--get', 'credential.interactive'])
          .then((out) => out.trim()),
      ).resolves.toBe('command\tfalse');
    },
  );

  test.each([
    { key: 'core.hooksPath', value: 'hooks', category: 'allowUnsafeHooksPath' },
    { key: 'core.fsmonitor', value: 'true', category: 'allowUnsafeFsMonitor' },
    { key: 'protocol.file.allow', value: 'always', category: 'allowUnsafeProtocolOverride' },
  ])('an environment $key stays refused under $category', async ({ key, value, category }) => {
    const git = simpleGit(buildCloneGitOptions(workspace, []) as Partial<SimpleGitOptions>).env(
      buildCloneEnv({
        PATH: process.env.PATH ?? '',
        HOME: workspace,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: key,
        GIT_CONFIG_VALUE_0: value,
      }),
    );

    await expect(git.raw(['--version'])).rejects.toThrow(category);
  });

  test('runClone refuses an environment core.hooksPath under allowUnsafeHooksPath', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath');
    vi.stubEnv('GIT_CONFIG_VALUE_0', join(workspace, 'hooks'));

    await expect(
      runClone(
        'https://127.0.0.1:1/o/r.git',
        { json: true, dir: 'target', _detectGhFn: relayTokenGh },
        {} as never,
        workspace,
      ),
    ).rejects.toThrow('allowUnsafeHooksPath');
  });

  test("ok clone's failure message names the GIT_CONFIG_* variables that passed a refused setting", async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath');
    vi.stubEnv('GIT_CONFIG_VALUE_0', join(workspace, 'hooks'));
    const url = 'https://127.0.0.1:1/o/r.git';
    const error = await runClone(
      url,
      { json: true, dir: 'target', _detectGhFn: relayTokenGh },
      {} as never,
      workspace,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitPluginError);
    const refusal = (error as GitPluginError).message;
    const emitted: Record<string, unknown>[] = [];
    const stderr: string[] = [];
    const report = (json: boolean) =>
      handleCloneFailure({
        error,
        url,
        branch: null,
        json,
        emit: (event) => emitted.push(event),
        printStderr: (text) => stderr.push(text),
      });

    await report(true);
    await report(false);

    expect(emitted).toEqual([{ type: 'error', message: refusal }]);
    const out = stderr.join('');
    expect(out).toContain('GIT_CONFIG_KEY_<n>');
    expect(out).toContain(refusal);
  });

  test("ok clone's failure message does not blame GIT_CONFIG_KEY_<n> for a variable refused by name", async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(workspace, 'global.gitconfig'));
    const url = 'https://127.0.0.1:1/o/r.git';
    const error = await runClone(
      url,
      { json: true, dir: 'target', _detectGhFn: relayTokenGh },
      {} as never,
      workspace,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitPluginError);
    const stderr: string[] = [];

    await handleCloneFailure({
      error,
      url,
      branch: null,
      json: false,
      emit: () => undefined,
      printStderr: (text) => stderr.push(text),
    });

    const out = stderr.join('');
    expect(out).toContain('GIT_CONFIG_GLOBAL');
    expect(out).not.toContain('GIT_CONFIG_KEY_<n>');
  });
});

describe('ok clone checks symlinks before checking anything out', () => {
  let workspace: string;

  function seedBareRepoWithLinks(bareDir: string, links: Record<string, string>): void {
    const seedDir = `${bareDir}.seed`;
    mkdirSync(seedDir, { recursive: true });
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, { cwd: seedDir, input, encoding: 'utf-8' });
    git(['init', '--initial-branch=main']);
    configureTestGitRepository(seedDir);
    writeFileSync(join(seedDir, 'README.md'), '# seeded\n', 'utf-8');
    git(['add', 'README.md']);
    for (const [path, target] of Object.entries(links)) {
      const blob = git(['hash-object', '-w', '--stdin'], target).trim();
      git(['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`]);
    }
    git([
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'seed',
    ]);
    execFileSync('git', ['clone', '--bare', seedDir, bareDir], {
      cwd: dirname(bareDir),
      stdio: 'ignore',
    });
    configureTestGitRepository(bareDir);
  }

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ok-clone-links-')));
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    vi.stubEnv('XDG_CONFIG_HOME', join(workspace, '.config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'url../.insteadOf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://127.0.0.1:1/');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  test('a repository with unsafe links is refused and leaves no clone behind', async () => {
    seedBareRepoWithLinks(join(workspace, 'o', 'r.git'), {
      'notes/leak.md': '../.git/config',
      'notes/q"uote.md': '../.ok/local/principal.json',
    });
    const url = 'https://127.0.0.1:1/o/r.git';

    const error = await runClone(
      url,
      { json: true, dir: 'target', _detectGhFn: relayTokenGh },
      {} as never,
      workspace,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsafeIncomingSymlinkError);
    expect(existsSync(join(workspace, 'target'))).toBe(false);

    const emitted: Record<string, unknown>[] = [];
    await handleCloneFailure({
      error,
      url,
      branch: null,
      json: true,
      emit: (event) => emitted.push(event),
      printStderr: () => undefined,
    });
    expect(emitted[0]?.type).toBe('error');
    expect(emitted[0]?.code).toBe('unsafe-symlinks');
    expect(String(emitted[0]?.message)).not.toContain('notes/');
    expect(emitted[0]?.refusedSymlinkPaths).toEqual(
      expect.arrayContaining(['notes/leak.md', 'notes/q\\"uote.md']),
    );

    const printed: string[] = [];
    await handleCloneFailure({
      error,
      url,
      branch: null,
      json: false,
      emit: () => undefined,
      printStderr: (text) => printed.push(text),
    });
    expect(printed.join('')).toContain(
      '"notes/leak.md" (points into private .git or OpenKnowledge state)',
    );
    expect(printed.join('')).toContain('"notes/q\\"uote.md"');
  });

  test('refusing keeps an existing empty target directory and empties it again', async () => {
    seedBareRepoWithLinks(join(workspace, 'o', 'r.git'), { 'notes/root': '..' });
    mkdirSync(join(workspace, 'target'));

    await expect(
      runClone(
        'https://127.0.0.1:1/o/r.git',
        { json: true, dir: 'target', _detectGhFn: relayTokenGh },
        {} as never,
        workspace,
      ),
    ).rejects.toBeInstanceOf(UnsafeIncomingSymlinkError);

    expect(readdirSync(join(workspace, 'target'))).toEqual([]);
  });

  test('an empty repository still clones', async () => {
    const bareDir = join(workspace, 'o', 'r.git');
    mkdirSync(bareDir, { recursive: true });
    execFileSync('git', ['init', '--bare', '--initial-branch=main'], {
      cwd: bareDir,
      stdio: 'ignore',
    });
    configureTestGitRepository(bareDir);

    await expect(
      runClone(
        'https://127.0.0.1:1/o/r.git',
        { json: true, dir: 'target', _detectGhFn: relayTokenGh },
        {} as never,
        workspace,
      ),
    ).resolves.toBe(join(workspace, 'target'));
  });

  test.runIf(process.platform !== 'win32')(
    'a repository whose links stay inside it is cloned and checked out',
    async () => {
      seedBareRepoWithLinks(join(workspace, 'o', 'r.git'), { 'notes/readme.md': '../README.md' });
      const targetDir = join(workspace, 'target');

      await expect(
        runClone(
          'https://127.0.0.1:1/o/r.git',
          { json: true, dir: 'target', _detectGhFn: relayTokenGh },
          {} as never,
          workspace,
        ),
      ).resolves.toBe(targetDir);

      expect(readFileSync(join(targetDir, 'README.md'), 'utf-8')).toBe('# seeded\n');
      expect(readlinkSync(join(targetDir, 'notes', 'readme.md'))).toBe('../README.md');
      expect(
        execFileSync('git', ['status', '--porcelain'], { cwd: targetDir, encoding: 'utf-8' }),
      ).toBe('');
    },
  );
});
