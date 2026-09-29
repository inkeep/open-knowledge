import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shellSingleQuote } from '@inkeep/open-knowledge-core';
import { type Config, readServerLock, resolveLockDir } from '@inkeep/open-knowledge-server';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GhDetectResult } from '../auth/gh-detect.ts';
import { FileBackend, type TokenStore } from '../auth/token-store.ts';
import {
  type CliHelperCall,
  gitConfigParameter,
  linesCarrying,
  type RecordedHelperCall,
  readJsonLines,
  writeCliCredentialStandIn,
  writeRecordingCredentialHelper,
} from './git-credential-fixtures.test-helper.ts';
import {
  GITHUB_HOST,
  type GitHubStandIn,
  type PlainHttpInterceptor,
  startGitHubStandIn,
  startPlainHttpInterceptor,
} from './github-stand-in.test-helper.ts';
import { runSync } from './sync.ts';

const ORIGIN_URL = `https://${GITHUB_HOST}/alice/demo.git`;
const OK_TOKEN = 'ok-test-sync-token-in-openknowledges-own-store';
const GH_TOKEN = 'ok-test-sync-token-the-gh-cli-supplies';
const STALE_PASSWORD = 'ok-test-sync-stale-password-in-an-ambient-helper';
const REVOKED_OK_TOKEN = 'ok-test-sync-revoked-token-in-openknowledges-own-store';
const REVOKED_GH_TOKEN = 'ok-test-sync-revoked-token-the-gh-cli-supplies';
const DENIED_OK_TOKEN = 'ok-test-sync-token-github-denies-access-to-the-repository';
const USER_PASSWORD = 'ok-test-sync-users-own-password-in-an-ambient-helper';
const INHERITED_RELAY_TOKEN = 'ok-test-sync-relay-token-inherited-from-the-environment';
const AMBIENT_HELPERS = ['env-count', 'env-parameters', 'github-scoped', 'global'];
const ENTERPRISE_HOST = 'ghe.example.com';
const ENTERPRISE_URL = `https://${ENTERPRISE_HOST}/alice/demo.git`;
const ENTERPRISE_USER = {
  username: 'enterprise-user',
  password: 'ok-test-sync-users-own-enterprise-password',
};

type SyncEvent = { type: string } & Record<string, unknown>;

interface SyncCredentialSeam {
  tokenStore: TokenStore;
  _detectGhFn: (host?: string, options?: { login?: string }) => GhDetectResult;
}

interface AmbientCredential {
  username: string;
  password: string;
}

type GitRunner = (...args: string[]) => void;

interface Scenario {
  gitHubAccepts: string;
  gitHubDenies?: string;
  okStoreToken?: string;
  ambientCredential?: AmbientCredential;
  enterpriseAccepts?: string;
  enterpriseAmbientCredential?: AmbientCredential;
  otherHostAccepts?: Record<string, string>;
  repository?: (git: GitRunner, server: GitHubStandIn) => void;
}

const ghUnavailable = (): GhDetectResult => ({ available: false });

function originUpstreamOnGitHub(git: GitRunner, server: GitHubStandIn): void {
  git('remote', 'add', 'origin', ORIGIN_URL);
  git('push', server.repositoryDir('alice/demo.git'), 'main:main');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
}

function originUpstreamOnEnterprise(git: GitRunner, server: GitHubStandIn): void {
  git('remote', 'add', 'origin', ENTERPRISE_URL);
  git('push', server.repositoryDir('alice/demo.git', ENTERPRISE_HOST), 'main:main');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
}

function authenticatedRequest(
  kind: 'fetch' | 'push',
  credential: { username: unknown; password: string },
): Record<string, unknown> {
  return kind === 'fetch'
    ? {
        method: 'GET',
        path: '/alice/demo.git/info/refs?service=git-upload-pack',
        credential,
        status: 200,
      }
    : { method: 'POST', path: '/alice/demo.git/git-receive-pack', credential, status: 200 };
}

describe("ok sync without a running server authenticates through OpenKnowledge's own credential helper", () => {
  let workspace: string;
  let home: string;
  let projectDir: string;
  let credentialStore: string;
  let helperLog: string;
  let cliHelperLog: string;
  let traceFile: string;
  let authFile: string;
  let cliStandIn: string;
  let standIn: GitHubStandIn | undefined;
  let interceptor: PlainHttpInterceptor | undefined;

  beforeAll(() => {
    expect(
      process.env.GIT_CONFIG_GLOBAL,
      'precondition: GIT_CONFIG_GLOBAL must be unset, or git reads that file instead of the temporary HOME and the credentials this suite approves reach the helpers it names',
    ).toBeUndefined();
  });

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ok-sync-credential-')));
    home = join(workspace, 'home');
    projectDir = join(workspace, 'project');
    credentialStore = join(workspace, 'git-credentials');
    helperLog = join(workspace, 'ambient-helper-calls.jsonl');
    cliHelperLog = join(workspace, 'cli-helper-calls.jsonl');
    traceFile = join(workspace, 'git-trace.log');
    authFile = join(workspace, 'ok-auth.yml');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    for (const variable of [
      'NO_PROXY',
      'no_proxy',
      'GIT_SSL_CAINFO',
      'GIT_SSL_NO_VERIFY',
      'OK_GH_TOKEN',
      'OK_GH_TOKEN_HOST',
      'OK_GH_TOKEN_LOGIN',
    ]) {
      vi.stubEnv(variable, undefined);
    }
    mkdirSync(home, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    cliStandIn = writeCliCredentialStandIn({ dir: workspace, callLog: cliHelperLog, authFile });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await standIn?.close();
    standIn = undefined;
    await interceptor?.close();
    interceptor = undefined;
    rmSync(workspace, { recursive: true, force: true });
  });

  function gitCredential(
    operation: 'approve' | 'reject',
    credential: AmbientCredential,
    host = GITHUB_HOST,
  ): void {
    execFileSync('git', ['credential', operation], {
      cwd: projectDir,
      input: `protocol=https\nhost=${host}\nusername=${credential.username}\npassword=${credential.password}\n\n`,
    });
  }

  async function arrange(scenario: Scenario): Promise<GitHubStandIn> {
    const started = await startGitHubStandIn({
      root: join(workspace, 'github'),
      acceptedPassword: scenario.gitHubAccepts,
      ...(scenario.gitHubDenies === undefined ? {} : { deniedPassword: scenario.gitHubDenies }),
      repositories: ['alice/demo.git'],
      enterpriseHosts: {
        ...(scenario.enterpriseAccepts === undefined
          ? {}
          : { [ENTERPRISE_HOST]: [scenario.enterpriseAccepts] }),
        ...Object.fromEntries(
          Object.entries(scenario.otherHostAccepts ?? {}).map(([host, password]) => [
            host,
            [password],
          ]),
        ),
      },
    });
    standIn = started;
    const recordingHelper = writeRecordingCredentialHelper(workspace, helperLog);
    const globalConfig = join(home, '.gitconfig');
    for (const [key, value] of [
      ['user.name', 'Sync Test'],
      ['user.email', 'sync-test@example.com'],
      ['init.defaultBranch', 'main'],
      ['commit.gpgsign', 'false'],
      ['http.proxy', started.proxyUrl],
      ['http.sslCAInfo', started.caFile],
      ['http.curloptResolve', `${GITHUB_HOST}:443:127.0.0.1`],
      ['http.curloptResolve', `${ENTERPRISE_HOST}:443:127.0.0.1`],
      ['credential.helper', recordingHelper('global')],
      ['credential.helper', `store --file ${shellSingleQuote(credentialStore)}`],
      [`credential.https://${GITHUB_HOST}.helper`, recordingHelper('github-scoped')],
    ]) {
      execFileSync('git', ['config', '--file', globalConfig, '--add', key, value]);
    }
    vi.stubEnv('GIT_CONFIG_COUNT', '3');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.interactive');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'false');
    vi.stubEnv('GIT_CONFIG_KEY_1', 'credential.guiPrompt');
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'false');
    vi.stubEnv('GIT_CONFIG_KEY_2', 'credential.helper');
    vi.stubEnv('GIT_CONFIG_VALUE_2', recordingHelper('env-count'));
    vi.stubEnv(
      'GIT_CONFIG_PARAMETERS',
      gitConfigParameter('credential.helper', recordingHelper('env-parameters')),
    );
    if (scenario.okStoreToken !== undefined) {
      await new FileBackend(authFile).set(GITHUB_HOST, 'alice', scenario.okStoreToken, {
        gitProtocol: 'https',
      });
    }

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' });
    git('init', '--initial-branch=main');
    git('commit', '--allow-empty', '-m', 'seed');
    (scenario.repository ?? originUpstreamOnGitHub)(git, started);
    git('commit', '--allow-empty', '-m', 'local work to push');

    const liveness = scenario.ambientCredential ?? {
      username: 'liveness-probe',
      password: 'ok-test-sync-liveness-probe-password',
    };
    gitCredential('approve', liveness);
    expect(
      readJsonLines<RecordedHelperCall>(helperLog).map(
        (call) => `${call.label} ${call.operation} ${call.fields.host}`,
      ),
    ).toEqual(
      expect.arrayContaining(AMBIENT_HELPERS.map((label) => `${label} store ${GITHUB_HOST}`)),
    );
    expect(readFileSync(credentialStore, 'utf-8')).toContain(
      `${liveness.username}:${liveness.password}@${GITHUB_HOST}`,
    );
    if (scenario.ambientCredential === undefined) {
      gitCredential('reject', liveness);
      expect(readFileSync(credentialStore, 'utf-8')).not.toContain(liveness.password);
    }
    if (scenario.enterpriseAmbientCredential !== undefined) {
      const enterprise = scenario.enterpriseAmbientCredential;
      gitCredential('approve', enterprise, ENTERPRISE_HOST);
      expect(readFileSync(credentialStore, 'utf-8')).toContain(
        `${enterprise.username}:${enterprise.password}@${ENTERPRISE_HOST}`,
      );
    }
    writeFileSync(helperLog, '', 'utf-8');
    vi.stubEnv('GIT_TRACE', traceFile);
    return started;
  }

  async function syncWith(
    seam: SyncCredentialSeam,
    op: 'sync' | 'pull' | 'push' = 'sync',
    output: 'json' | 'text' = 'json',
  ): Promise<{ events: SyncEvent[]; stderr: string; error: unknown }> {
    expect(readServerLock(resolveLockDir(projectDir))).toBeNull();
    const events: SyncEvent[] = [];
    let stderr = '';
    const writes = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') events.push(JSON.parse(line) as SyncEvent);
      }
      return true;
    });
    const errorWrites =
      output === 'text'
        ? vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += String(chunk);
            return true;
          })
        : undefined;
    const options: Parameters<typeof runSync>[0] & SyncCredentialSeam = {
      json: output === 'json',
      op,
      ...seam,
    };
    const cliEntry = process.argv[1];
    process.argv[1] = cliStandIn;
    let error: unknown = null;
    try {
      await runSync(options, {} as Config, projectDir);
    } catch (caught) {
      error = caught;
    } finally {
      process.argv[1] = cliEntry;
      writes.mockRestore();
      errorWrites?.mockRestore();
    }
    if (output === 'json') {
      expect(events).toContainEqual({ type: 'step', step: op === 'push' ? 'push' : 'pull' });
      expect(events.filter((event) => event.type === 'triggered')).toEqual([]);
    } else {
      expect(stderr).toContain(`Running ${op} directly (no live server)`);
      expect(stderr).not.toContain('via running server');
    }
    return { events, stderr, error };
  }

  function localAndRemoteMain(repositoryDir: string): { local: string; remote: string } {
    return {
      local: execFileSync('git', ['rev-parse', 'main'], {
        cwd: projectDir,
        encoding: 'utf-8',
      }).trim(),
      remote: execFileSync(
        'git',
        ['--git-dir', repositoryDir, 'for-each-ref', '--format=%(objectname)', 'refs/heads/main'],
        { encoding: 'utf-8' },
      ).trim(),
    };
  }

  function expectSyncCompletedWith(
    outcome: { events: SyncEvent[]; error: unknown },
    server: GitHubStandIn,
    password: string,
  ): void {
    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'sync',
    });
    expect.soft(server.requests, "the pull's authenticated fetch").toContainEqual({
      method: 'GET',
      path: '/alice/demo.git/info/refs?service=git-upload-pack',
      credential: { username: expect.any(String), password },
      status: 200,
    });
    expect.soft(server.requests, "the push's authenticated receive-pack").toContainEqual({
      method: 'POST',
      path: '/alice/demo.git/git-receive-pack',
      credential: { username: expect.any(String), password },
      status: 200,
    });
    const main = localAndRemoteMain(server.repositoryDir('alice/demo.git'));
    expect.soft(main.remote, "the remote's main after sync").toBe(main.local);
  }

  function expectCredentialConfinedToCliHelper(
    token: string,
    context: { tracedCommand?: 'pull' | 'push'; remoteName?: string } = {},
  ): void {
    const { tracedCommand = 'pull', remoteName = 'origin' } = context;
    const trace = readFileSync(traceFile, 'utf-8');
    expect(trace).toMatch(new RegExp(`built-in: git ${tracedCommand}`));
    expect(trace).toMatch(/remote-https/);
    const projectGitConfig = readFileSync(join(projectDir, '.git', 'config'), 'utf-8');
    expect(projectGitConfig).toContain(`[remote "${remoteName}"]`);

    expect
      .soft(
        readJsonLines<RecordedHelperCall>(helperLog),
        'calls reaching the ambient credential helpers',
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(credentialStore, 'utf-8'), token),
        'the ambient git-credential-store file',
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(trace, token),
        'argv of git pull, git push and their children (GIT_TRACE)',
      )
      .toEqual([]);
    expect.soft(linesCarrying(projectGitConfig, token), "the project's .git/config").toEqual([]);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toContainEqual({
        args: ['auth', 'git-credential', 'get'],
        protocol: 'https',
        host: GITHUB_HOST,
      });
  }

  test("with OpenKnowledge signed in and no ambient credential, ok sync pulls and pushes with OpenKnowledge's token", async () => {
    const server = await arrange({ gitHubAccepts: OK_TOKEN, okStoreToken: OK_TOKEN });

    const outcome = await syncWith({
      tokenStore: new FileBackend(authFile),
      _detectGhFn: ghUnavailable,
    });

    expectSyncCompletedWith(outcome, server, OK_TOKEN);
    expectCredentialConfinedToCliHelper(OK_TOKEN);
  });

  test("with a stale credential in an ambient helper, OpenKnowledge's helper wins and the ambient helpers are never asked or told", async () => {
    const stale = { username: 'x-access-token', password: STALE_PASSWORD };
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      ambientCredential: stale,
    });

    const outcome = await syncWith({
      tokenStore: new FileBackend(authFile),
      _detectGhFn: ghUnavailable,
    });

    expectSyncCompletedWith(outcome, server, OK_TOKEN);
    expect
      .soft(
        server.requests.filter((request) => request.credential?.password === STALE_PASSWORD),
        'requests presenting the stale ambient credential',
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(credentialStore, 'utf-8'), STALE_PASSWORD),
        "the stale entry still in the user's credential store",
      )
      .toHaveLength(1);
    expectCredentialConfinedToCliHelper(OK_TOKEN);
  });

  test("with only the gh CLI's token available, ok sync pulls and pushes with it through OpenKnowledge's helper", async () => {
    const server = await arrange({ gitHubAccepts: GH_TOKEN });

    const outcome = await syncWith({
      tokenStore: new FileBackend(authFile),
      _detectGhFn: () => ({ available: true, token: GH_TOKEN }),
    });

    expectSyncCompletedWith(outcome, server, GH_TOKEN);
    expectCredentialConfinedToCliHelper(GH_TOKEN);
  });

  test("signed out of OpenKnowledge with gh unavailable, ok sync keeps using the user's own ambient credential", async () => {
    const own = { username: 'ambient-user', password: USER_PASSWORD };
    const server = await arrange({ gitHubAccepts: USER_PASSWORD, ambientCredential: own });

    const outcome = await syncWith({
      tokenStore: new FileBackend(authFile),
      _detectGhFn: ghUnavailable,
    });

    expectSyncCompletedWith(outcome, server, USER_PASSWORD);
    const ambientCalls = readJsonLines<RecordedHelperCall>(helperLog);
    expect
      .soft(ambientCalls, "the user's own helpers asked for the github.com credential")
      .toContainEqual({
        label: 'global',
        operation: 'get',
        fields: expect.objectContaining({ protocol: 'https', host: GITHUB_HOST }),
        relayToken: null,
      });
    expect
      .soft(
        ambientCalls.filter((call) => call.relayToken !== null),
        'ambient helper calls that inherited an OK_GH_TOKEN relay',
      )
      .toEqual([]);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(credentialStore, 'utf-8'), USER_PASSWORD),
        "the user's entry still in their credential store",
      )
      .toHaveLength(1);
  });

  test.each([
    {
      variable: 'GIT_CONFIG_GLOBAL',
      signIn: "OpenKnowledge's own store",
      token: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      detectGh: ghUnavailable,
      stubEnvironment: () => {
        const homeConfig = join(home, '.gitconfig');
        const configOutsideHome = join(workspace, 'global.gitconfig');
        copyFileSync(homeConfig, configOutsideHome);
        execFileSync('git', ['config', '--file', homeConfig, '--unset', 'http.sslCAInfo']);
        vi.stubEnv('GIT_CONFIG_GLOBAL', configOutsideHome);
      },
    },
    {
      variable: 'GIT_TEMPLATE_DIR',
      signIn: 'the gh CLI',
      token: GH_TOKEN,
      okStoreToken: undefined,
      detectGh: (): GhDetectResult => ({ available: true, token: GH_TOKEN }),
      stubEnvironment: () => {
        const templates = join(workspace, 'empty-templates');
        mkdirSync(templates);
        vi.stubEnv('GIT_TEMPLATE_DIR', templates);
      },
    },
    {
      variable: 'GIT_CONFIG_KEY_3=protocol.file.allow',
      signIn: "OpenKnowledge's own store",
      token: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      detectGh: ghUnavailable,
      stubEnvironment: () => {
        vi.stubEnv('GIT_CONFIG_COUNT', '4');
        vi.stubEnv('GIT_CONFIG_KEY_3', 'protocol.file.allow');
        vi.stubEnv('GIT_CONFIG_VALUE_3', 'always');
      },
    },
  ])(
    "with $variable in the environment, ok sync signed in through $signIn still pulls and pushes through OpenKnowledge's helper, as the signed-out fallback accepts that environment",
    async (row) => {
      const server = await arrange({ gitHubAccepts: row.token, okStoreToken: row.okStoreToken });
      row.stubEnvironment();

      const outcome = await syncWith({
        tokenStore: new FileBackend(authFile),
        _detectGhFn: row.detectGh,
      });

      expectSyncCompletedWith(outcome, server, row.token);
      expectCredentialConfinedToCliHelper(row.token);
    },
  );

  test("with an OK_GH_TOKEN relay for github.com already in its environment, ok sync signed in to OpenKnowledge pulls and pushes with OpenKnowledge's token and never presents the relay's", async () => {
    const server = await arrange({ gitHubAccepts: OK_TOKEN, okStoreToken: OK_TOKEN });
    vi.stubEnv('OK_GH_TOKEN', INHERITED_RELAY_TOKEN);
    vi.stubEnv('OK_GH_TOKEN_HOST', GITHUB_HOST);
    vi.stubEnv('OK_GH_TOKEN_LOGIN', 'inherited-relay-login');

    const outcome = await syncWith({
      tokenStore: new FileBackend(authFile),
      _detectGhFn: ghUnavailable,
    });

    expectSyncCompletedWith(outcome, server, OK_TOKEN);
    expect
      .soft(
        server.requests.filter((request) => request.credential?.password === INHERITED_RELAY_TOKEN),
        "requests presenting the inherited relay's token",
      )
      .toEqual([]);
    expectCredentialConfinedToCliHelper(OK_TOKEN);
  });

  function signedInSeam(): SyncCredentialSeam {
    return { tokenStore: new FileBackend(authFile), _detectGhFn: ghUnavailable };
  }

  function expectPullToGitHubAndPushToEnterprise(
    outcome: { events: SyncEvent[]; error: unknown },
    server: GitHubStandIn,
  ): void {
    const trace = readFileSync(traceFile, 'utf-8');
    expect(trace).toMatch(/built-in: git pull/);
    expect(trace).toMatch(/remote-https/);
    const cliCalls = readJsonLines<CliHelperCall>(cliHelperLog);
    const enterpriseRequests = server.requestsTo(ENTERPRISE_HOST);

    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'sync',
    });
    expect
      .soft(server.requests, "the pull's fetch from github.com")
      .toContainEqual(
        authenticatedRequest('fetch', { username: expect.any(String), password: OK_TOKEN }),
      );
    expect
      .soft(enterpriseRequests, "the push's receive-pack on the Enterprise host")
      .toContainEqual(authenticatedRequest('push', ENTERPRISE_USER));
    const main = localAndRemoteMain(server.repositoryDir('alice/demo.git', ENTERPRISE_HOST));
    expect.soft(main.remote, "the Enterprise remote's main after sync").toBe(main.local);
    expect.soft(cliCalls, "calls reaching the CLI's own helper").toContainEqual({
      args: ['auth', 'git-credential', 'get'],
      protocol: 'https',
      host: GITHUB_HOST,
    });
    expect
      .soft(
        cliCalls.filter((call) => call.host !== GITHUB_HOST),
        "calls reaching the CLI's own helper for another host",
      )
      .toEqual([]);
    expect
      .soft(
        enterpriseRequests.filter((request) => request.credential?.password === OK_TOKEN),
        "Enterprise requests presenting OpenKnowledge's token",
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(helperLog, 'utf-8'), OK_TOKEN),
        "ambient helper calls carrying OpenKnowledge's token",
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(credentialStore, 'utf-8'), OK_TOKEN),
        'the ambient git-credential-store file',
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(trace, OK_TOKEN),
        'argv of git pull, git push and their children (GIT_TRACE)',
      )
      .toEqual([]);
  }

  test("with the branch's push remote on an Enterprise host, the pull presents OpenKnowledge's token to github.com and the push the user's own Enterprise credential", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: (git, github) => {
        originUpstreamOnGitHub(git, github);
        git('remote', 'add', 'enterprise', ENTERPRISE_URL);
        git('push', github.repositoryDir('alice/demo.git', ENTERPRISE_HOST), 'main:main');
        git('config', 'branch.main.pushRemote', 'enterprise');
      },
    });

    const outcome = await syncWith(signedInSeam());

    expectPullToGitHubAndPushToEnterprise(outcome, server);
  });

  test("with origin's pushurl on an Enterprise host, the push's credential follows the push URL", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: (git, github) => {
        originUpstreamOnGitHub(git, github);
        git('config', 'remote.origin.pushurl', ENTERPRISE_URL);
        git('push', github.repositoryDir('alice/demo.git', ENTERPRISE_HOST), 'main:main');
      },
    });

    const outcome = await syncWith(signedInSeam());

    expectPullToGitHubAndPushToEnterprise(outcome, server);
  });

  test("with an insteadOf rewrite of github.com to an Enterprise host, ok sync keeps the user's own Enterprise credential and never asks OpenKnowledge's helper", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: (git, github) => {
        originUpstreamOnGitHub(git, github);
        git('push', github.repositoryDir('alice/demo.git', ENTERPRISE_HOST), 'main:main');
        git('config', `url.https://${ENTERPRISE_HOST}/.insteadOf`, `https://${GITHUB_HOST}/`);
      },
    });

    const outcome = await syncWith(signedInSeam());

    const trace = readFileSync(traceFile, 'utf-8');
    expect(trace).toMatch(/built-in: git pull/);
    expect(trace).toMatch(/remote-https/);
    const enterpriseRequests = server.requestsTo(ENTERPRISE_HOST);
    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'sync',
    });
    expect
      .soft(enterpriseRequests, "the pull's fetch from the Enterprise host")
      .toContainEqual(authenticatedRequest('fetch', ENTERPRISE_USER));
    expect
      .soft(enterpriseRequests, "the push's receive-pack on the Enterprise host")
      .toContainEqual(authenticatedRequest('push', ENTERPRISE_USER));
    const main = localAndRemoteMain(server.repositoryDir('alice/demo.git', ENTERPRISE_HOST));
    expect.soft(main.remote, "the Enterprise remote's main after sync").toBe(main.local);
    expect.soft(server.requests, 'requests reaching github.com').toEqual([]);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect
      .soft(
        enterpriseRequests.filter((request) => request.credential?.password === OK_TOKEN),
        "Enterprise requests presenting OpenKnowledge's token",
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(helperLog, 'utf-8'), OK_TOKEN),
        "ambient helper calls carrying OpenKnowledge's token",
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(trace, OK_TOKEN),
        'argv of git pull, git push and their children (GIT_TRACE)',
      )
      .toEqual([]);
  });

  test("with a single remote not named origin and no upstream, ok push presents OpenKnowledge's token to that remote", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      repository: (git, github) => {
        git('remote', 'add', 'upstream', ORIGIN_URL);
        git('push', github.repositoryDir('alice/demo.git'), 'main:main');
        git('config', 'push.default', 'current');
      },
    });

    const outcome = await syncWith(signedInSeam(), 'push');

    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'push',
    });
    expect
      .soft(server.requests, "the push's authenticated receive-pack")
      .toContainEqual(
        authenticatedRequest('push', { username: expect.any(String), password: OK_TOKEN }),
      );
    const main = localAndRemoteMain(server.repositoryDir('alice/demo.git'));
    expect.soft(main.remote, "the remote's main after the push").toBe(main.local);
    expectCredentialConfinedToCliHelper(OK_TOKEN, {
      tracedCommand: 'push',
      remoteName: 'upstream',
    });
  });

  test("with origin and another remote and no upstream, ok push presents OpenKnowledge's token to origin", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: (git, github) => {
        git('remote', 'add', 'origin', ORIGIN_URL);
        git('push', github.repositoryDir('alice/demo.git'), 'main:main');
        git('remote', 'add', 'enterprise', ENTERPRISE_URL);
        git('push', github.repositoryDir('alice/demo.git', ENTERPRISE_HOST), 'main:main');
        git('config', 'push.default', 'current');
      },
    });

    const outcome = await syncWith(signedInSeam(), 'push');

    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'push',
    });
    expect
      .soft(server.requests, "the push's authenticated receive-pack on github.com")
      .toContainEqual(
        authenticatedRequest('push', { username: expect.any(String), password: OK_TOKEN }),
      );
    const main = localAndRemoteMain(server.repositoryDir('alice/demo.git'));
    expect.soft(main.remote, "github.com's main after the push").toBe(main.local);
    expect
      .soft(server.requestsTo(ENTERPRISE_HOST), 'requests reaching the Enterprise host')
      .toEqual([]);
    expectCredentialConfinedToCliHelper(OK_TOKEN, { tracedCommand: 'push' });
  });

  test.each([
    { form: 'a local path', urlOf: (repository: string) => repository },
    { form: 'a file:// URL', urlOf: (repository: string) => pathToFileURL(repository).href },
  ])(
    "with origin at $form, ok sync completes as it does today and never asks OpenKnowledge's helper",
    async ({ urlOf }) => {
      const localRemote = join(workspace, 'local-remote.git');
      const server = await arrange({
        gitHubAccepts: OK_TOKEN,
        okStoreToken: OK_TOKEN,
        repository: (git) => {
          execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', localRemote]);
          git('remote', 'add', 'origin', urlOf(localRemote));
          git('push', localRemote, 'main:main');
          git('config', 'branch.main.remote', 'origin');
          git('config', 'branch.main.merge', 'refs/heads/main');
          git('update-ref', 'refs/remotes/origin/main', 'main');
        },
      });

      const outcome = await syncWith(signedInSeam());

      expect.soft(outcome.error, 'the error runSync threw').toBeNull();
      expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
        type: 'complete',
        op: 'sync',
      });
      const main = localAndRemoteMain(localRemote);
      expect.soft(main.remote, "the local remote's main after sync").toBe(main.local);
      expect
        .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
        .toEqual([]);
      expect.soft(server.requests, 'requests reaching github.com').toEqual([]);
    },
  );

  test("with origin at a plain http:// GitHub URL, ok sync never releases OpenKnowledge's token to a request that would carry it over plain http", async () => {
    const onPath = await startPlainHttpInterceptor();
    interceptor = onPath;
    await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      repository: (git, github) => {
        originUpstreamOnGitHub(git, github);
        git('remote', 'set-url', 'origin', `http://${GITHUB_HOST}/alice/demo.git`);
        git('config', 'http.proxy', onPath.proxyUrl);
      },
    });

    const outcome = await syncWith(signedInSeam());

    expect(onPath.requests.map((request) => request.url)).toContain(
      `http://${GITHUB_HOST}/alice/demo.git/info/refs?service=git-upload-pack`,
    );
    expect.soft(outcome.error, 'the error runSync threw').not.toBeNull();
    expect
      .soft(
        onPath.requests.filter((request) => request.basicCredential?.includes(OK_TOKEN)),
        "plain-http requests carrying OpenKnowledge's token",
      )
      .toEqual([]);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect
      .soft(
        readJsonLines<RecordedHelperCall>(helperLog),
        "the user's own helpers asked for the http credential",
      )
      .toContainEqual({
        label: 'global',
        operation: 'get',
        fields: expect.objectContaining({ protocol: 'http', host: GITHUB_HOST }),
        relayToken: null,
      });
  });

  const ghHoldsAToken = (): SyncCredentialSeam => ({
    tokenStore: new FileBackend(authFile),
    _detectGhFn: () => ({ available: true, token: GH_TOKEN }),
  });

  test("with origin on an Enterprise host that is not declared, ok sync keeps the user's own credential even when the gh CLI holds a token for that host", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: originUpstreamOnEnterprise,
    });

    const outcome = await syncWith(ghHoldsAToken());

    const enterpriseRequests = server.requestsTo(ENTERPRISE_HOST);
    const ambientCalls = readJsonLines<RecordedHelperCall>(helperLog);
    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'sync',
    });
    expect
      .soft(enterpriseRequests, "the pull's fetch from the Enterprise host")
      .toContainEqual(authenticatedRequest('fetch', ENTERPRISE_USER));
    expect
      .soft(enterpriseRequests, "the push's receive-pack on the Enterprise host")
      .toContainEqual(authenticatedRequest('push', ENTERPRISE_USER));
    expect
      .soft(
        enterpriseRequests.filter((request) => request.credential?.password === GH_TOKEN),
        "Enterprise requests presenting the gh CLI's token",
      )
      .toEqual([]);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect
      .soft(ambientCalls, "the user's own helpers asked for the Enterprise credential")
      .toContainEqual({
        label: 'global',
        operation: 'get',
        fields: expect.objectContaining({ protocol: 'https', host: ENTERPRISE_HOST }),
        relayToken: null,
      });
    expect
      .soft(
        ambientCalls.filter((call) => call.relayToken !== null),
        'ambient helper calls that inherited an OK_GH_TOKEN relay',
      )
      .toEqual([]);
  });

  test("with origin on an Enterprise host declared in ~/.ok/global.yml, ok sync presents the gh CLI's token through OpenKnowledge's helper and never asks the user's own helpers", async () => {
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(
      join(home, '.ok', 'global.yml'),
      `git:\n  hosts:\n    ${ENTERPRISE_HOST}:\n      provider: github\n`,
    );
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      enterpriseAccepts: GH_TOKEN,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: originUpstreamOnEnterprise,
    });

    const outcome = await syncWith(ghHoldsAToken());

    const enterpriseRequests = server.requestsTo(ENTERPRISE_HOST);
    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect
      .soft(enterpriseRequests, "the push's receive-pack on the Enterprise host")
      .toContainEqual(
        authenticatedRequest('push', { username: expect.any(String), password: GH_TOKEN }),
      );
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toContainEqual({
        args: ['auth', 'git-credential', 'get'],
        protocol: 'https',
        host: ENTERPRISE_HOST,
      });
    expect
      .soft(readJsonLines<RecordedHelperCall>(helperLog), 'calls reaching the ambient helpers')
      .toEqual([]);
  });

  test("with origin on a declared Enterprise host at a non-default port, ok sync keeps the user's own credential and hands no relay to their helpers", async () => {
    const portedHost = `${ENTERPRISE_HOST}:8443`;
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(
      join(home, '.ok', 'global.yml'),
      `git:\n  hosts:\n    ${ENTERPRISE_HOST}:\n      provider: github\n`,
    );
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      repository: (git, github) => {
        git('remote', 'add', 'origin', `https://${portedHost}/alice/demo.git`);
        git('push', github.repositoryDir('alice/demo.git', ENTERPRISE_HOST), 'main:main');
        git('config', 'branch.main.remote', 'origin');
        git('config', 'branch.main.merge', 'refs/heads/main');
        git('update-ref', 'refs/remotes/origin/main', 'main');
      },
    });
    gitCredential('approve', ENTERPRISE_USER, portedHost);
    writeFileSync(helperLog, '', 'utf-8');

    const outcome = await syncWith(ghHoldsAToken());

    const enterpriseRequests = server.requestsTo(ENTERPRISE_HOST);
    const ambientCalls = readJsonLines<RecordedHelperCall>(helperLog);
    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect
      .soft(enterpriseRequests, "the push's receive-pack on the ported Enterprise host")
      .toContainEqual(authenticatedRequest('push', ENTERPRISE_USER));
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect
      .soft(ambientCalls, "the user's own helpers asked for the ported host's credential")
      .toContainEqual({
        label: 'global',
        operation: 'get',
        fields: expect.objectContaining({ protocol: 'https', host: portedHost }),
        relayToken: null,
      });
    expect
      .soft(
        ambientCalls.filter((call) => call.relayToken !== null),
        'ambient helper calls that inherited an OK_GH_TOKEN relay',
      )
      .toEqual([]);
  });

  test.each([
    { form: 'an explicit :443', writtenHost: `${GITHUB_HOST}:443`, servedBy: GITHUB_HOST },
    { form: 'a mixed-case host', writtenHost: 'GitHub.com', servedBy: GITHUB_HOST },
    { form: 'the www.github.com alias', writtenHost: 'www.github.com', servedBy: 'www.github.com' },
  ])(
    "with origin's host written as $form, ok sync keeps the user's own credential, never asks OpenKnowledge's helper and hands no relay to the user's helpers",
    async ({ writtenHost, servedBy }) => {
      const own = { username: 'ambient-user', password: USER_PASSWORD };
      const server = await arrange({
        gitHubAccepts: USER_PASSWORD,
        otherHostAccepts: { 'www.github.com': USER_PASSWORD },
        repository: (git, github) => {
          git('remote', 'add', 'origin', `https://${writtenHost}/alice/demo.git`);
          git('push', github.repositoryDir('alice/demo.git', servedBy), 'main:main');
          git('config', 'branch.main.remote', 'origin');
          git('config', 'branch.main.merge', 'refs/heads/main');
          git('update-ref', 'refs/remotes/origin/main', 'main');
        },
      });
      gitCredential('approve', own, writtenHost);
      writeFileSync(helperLog, '', 'utf-8');

      const outcome = await syncWith(ghHoldsAToken());

      const ambientCalls = readJsonLines<RecordedHelperCall>(helperLog);
      expect.soft(outcome.error, 'the error runSync threw').toBeNull();
      expect
        .soft(server.requestsTo(servedBy), "the push's receive-pack with the user's credential")
        .toContainEqual(authenticatedRequest('push', own));
      expect
        .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
        .toEqual([]);
      expect
        .soft(ambientCalls, "the user's own helpers asked for the credential as git wrote the host")
        .toContainEqual({
          label: 'global',
          operation: 'get',
          fields: expect.objectContaining({ protocol: 'https', host: writtenHost }),
          relayToken: null,
        });
      expect
        .soft(
          ambientCalls.filter((call) => call.relayToken !== null),
          'ambient helper calls that inherited an OK_GH_TOKEN relay',
        )
        .toEqual([]);
    },
  );

  test.each(['json', 'text'] as const)(
    "when the remote URL names an account the gh CLI cannot confirm, ok sync's %s output says it used the gh CLI's active account",
    async (output) => {
      const server = await arrange({
        gitHubAccepts: GH_TOKEN,
        repository: (git, github) => {
          originUpstreamOnGitHub(git, github);
          git('remote', 'set-url', 'origin', `https://alice@${GITHUB_HOST}/alice/demo.git`);
        },
      });

      const outcome = await syncWith(
        {
          tokenStore: new FileBackend(authFile),
          _detectGhFn: (_host, options) => ({
            available: true,
            token: GH_TOKEN,
            ...(options?.login !== undefined ? { fallback: true } : {}),
          }),
        },
        'sync',
        output,
      );

      expect.soft(outcome.error, 'the error runSync threw').toBeNull();
      expect
        .soft(server.requests, "the push's receive-pack with the active account's token")
        .toContainEqual(
          authenticatedRequest('push', { username: expect.any(String), password: GH_TOKEN }),
        );
      const warned =
        output === 'json'
          ? outcome.events
              .filter((event) => event.type === 'warning')
              .map((event) => String(event.message))
              .join('\n')
          : outcome.stderr;
      expect(warned, 'the warning ok sync printed').toContain(
        "The remote URL names alice, but the GitHub CLI couldn't confirm that account — ok sync used its active account.",
      );
      expect(warned, 'the warning ok sync printed').toContain('gh auth status');
    },
  );

  test.each([
    {
      source: "OpenKnowledge's own stored sign-in",
      okStoreToken: REVOKED_OK_TOKEN,
      detectGh: ghUnavailable,
      rejected: REVOKED_OK_TOKEN,
      named: `OpenKnowledge's GitHub sign-in for ${GITHUB_HOST}`,
      remedy: `ok auth login --host ${GITHUB_HOST}`,
    },
    {
      source: "the gh CLI's sign-in",
      okStoreToken: undefined,
      detectGh: (): GhDetectResult => ({ available: true, token: REVOKED_GH_TOKEN }),
      rejected: REVOKED_GH_TOKEN,
      named: `the GitHub CLI's sign-in for ${GITHUB_HOST}`,
      remedy: `gh auth login --hostname ${GITHUB_HOST}`,
    },
  ])(
    "when GitHub rejects $source while the user's own helper holds a working credential, ok sync's error names the credential it used and how to renew it",
    async (row) => {
      const server = await arrange({
        gitHubAccepts: USER_PASSWORD,
        okStoreToken: row.okStoreToken,
        ambientCredential: { username: 'ambient-user', password: USER_PASSWORD },
      });

      const outcome = await syncWith({
        tokenStore: new FileBackend(authFile),
        _detectGhFn: row.detectGh,
      });

      expect(server.requests, 'the fetch presenting the rejected credential').toContainEqual({
        method: 'GET',
        path: '/alice/demo.git/info/refs?service=git-upload-pack',
        credential: { username: expect.any(String), password: row.rejected },
        status: 401,
      });
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      expect
        .soft(message, 'the reason git gave, as ok sync reports it')
        .toContain('Authentication failed');
      expect.soft(message, 'the credential ok sync reports it used').toContain(row.named);
      expect.soft(message, 'the renewal command ok sync reports').toContain(`run: ${row.remedy}`);
    },
  );

  test("when github.com denies OpenKnowledge's sign-in access to the repository, ok sync's error names that sign-in and gives no renewal command", async () => {
    const server = await arrange({
      gitHubAccepts: USER_PASSWORD,
      gitHubDenies: DENIED_OK_TOKEN,
      okStoreToken: DENIED_OK_TOKEN,
    });

    const outcome = await syncWith(signedInSeam());

    expect(server.requests, 'the fetch presenting the denied credential').toContainEqual({
      method: 'GET',
      path: '/alice/demo.git/info/refs?service=git-upload-pack',
      credential: { username: expect.any(String), password: DENIED_OK_TOKEN },
      status: 403,
    });
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    expect.soft(message, 'the reason git gave, as ok sync reports it').toContain('403');
    expect
      .soft(message, 'the credential ok sync reports it used')
      .toContain(`OpenKnowledge's GitHub sign-in for ${GITHUB_HOST}`);
    expect
      .soft(message, 'the guidance ok sync gives for a denied account')
      .toContain('check that it has access to the repository');
    expect.soft(message, 'a renewal command in the message').not.toContain('auth login');
  });

  test("when the pull advances a populated submodule on a plain http:// GitHub URL, ok sync never releases OpenKnowledge's credential to the submodule's plain-http request", async () => {
    const onPath = await startPlainHttpInterceptor();
    interceptor = onPath;
    const submoduleSource = join(workspace, 'submodule-source');
    const upstreamWork = join(workspace, 'upstream-work');
    const server = await arrange({
      gitHubAccepts: GH_TOKEN,
      repository: (git, github) => {
        execFileSync('git', ['init', '--quiet', '--initial-branch=main', submoduleSource]);
        execFileSync('git', [
          '-C',
          submoduleSource,
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'one',
        ]);
        git(
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '--quiet',
          submoduleSource,
          'sub',
        );
        git('-C', 'sub', 'remote', 'set-url', 'origin', `http://${GITHUB_HOST}/alice/sub.git`);
        git('commit', '--quiet', '-m', 'add the submodule');
        originUpstreamOnGitHub(git, github);
        execFileSync('git', [
          '-C',
          submoduleSource,
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'two',
        ]);
        const advanced = execFileSync('git', ['-C', submoduleSource, 'rev-parse', 'HEAD'], {
          encoding: 'utf-8',
        }).trim();
        execFileSync('git', [
          'clone',
          '--quiet',
          github.repositoryDir('alice/demo.git'),
          upstreamWork,
        ]);
        execFileSync('git', [
          '-C',
          upstreamWork,
          'update-index',
          '--cacheinfo',
          `160000,${advanced},sub`,
        ]);
        execFileSync('git', [
          '-C',
          upstreamWork,
          'commit',
          '--quiet',
          '-m',
          'advance the submodule',
        ]);
        execFileSync('git', ['-C', upstreamWork, 'push', '--quiet', 'origin', 'main']);
        execFileSync('git', [
          'config',
          '--file',
          join(home, '.gitconfig'),
          `http.http://${GITHUB_HOST}.proxy`,
          onPath.proxyUrl,
        ]);
      },
    });

    await syncWith(ghHoldsAToken());

    expect(server.requests, "the superproject's fetch from github.com").toContainEqual(
      authenticatedRequest('fetch', { username: expect.any(String), password: GH_TOKEN }),
    );
    expect(
      onPath.requests.map((request) => request.url),
      "the submodule's plain-http fetch",
    ).toContain(`http://${GITHUB_HOST}/alice/sub.git/info/refs?service=git-upload-pack`);
    expect
      .soft(
        onPath.requests.filter((request) => request.basicCredential?.includes(GH_TOKEN)),
        "plain-http requests carrying the gh CLI's token",
      )
      .toEqual([]);
    expect
      .soft(
        readJsonLines<CliHelperCall>(cliHelperLog).filter((call) => call.protocol !== 'https'),
        "non-https calls reaching the CLI's own helper",
      )
      .toEqual([]);
    expect
      .soft(
        readJsonLines<RecordedHelperCall>(helperLog),
        "the user's own helpers asked for the submodule's http credential",
      )
      .toContainEqual(
        expect.objectContaining({
          label: 'global',
          operation: 'get',
          fields: expect.objectContaining({ protocol: 'http', host: GITHUB_HOST }),
        }),
      );
  });

  test("with a second plain http:// push URL on origin, ok push presents OpenKnowledge's token to the https push URL and never to the plain-http one", async () => {
    const onPath = await startPlainHttpInterceptor();
    interceptor = onPath;
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      repository: (git, github) => {
        originUpstreamOnGitHub(git, github);
        git('config', '--add', 'remote.origin.pushurl', ORIGIN_URL);
        git('config', '--add', 'remote.origin.pushurl', `http://${GITHUB_HOST}/alice/mirror.git`);
        git('config', `http.http://${GITHUB_HOST}.proxy`, onPath.proxyUrl);
      },
    });

    const outcome = await syncWith(signedInSeam(), 'push');

    expect(server.requests, "the https push URL's receive-pack").toContainEqual(
      authenticatedRequest('push', { username: expect.any(String), password: OK_TOKEN }),
    );
    expect(
      onPath.requests.map((request) => request.url),
      "the plain-http push URL's request",
    ).toContain(`http://${GITHUB_HOST}/alice/mirror.git/info/refs?service=git-receive-pack`);
    expect.soft(outcome.error, 'the error runSync threw').not.toBeNull();
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    expect
      .soft(message, 'the failure ok push reports for the plain-http push URL')
      .not.toContain("OpenKnowledge's GitHub sign-in");
    expect.soft(message, 'a renewal command in the message').not.toContain('auth login');
    expect
      .soft(
        onPath.requests.filter((request) => request.basicCredential?.includes(OK_TOKEN)),
        "plain-http requests carrying OpenKnowledge's token",
      )
      .toEqual([]);
    expect
      .soft(
        readJsonLines<CliHelperCall>(cliHelperLog).filter((call) => call.protocol !== 'https'),
        "non-https calls reaching the CLI's own helper",
      )
      .toEqual([]);
    expect
      .soft(
        readJsonLines<RecordedHelperCall>(helperLog),
        "the user's own helpers asked for the plain-http push URL's credential",
      )
      .toContainEqual({
        label: 'global',
        operation: 'get',
        fields: expect.objectContaining({ protocol: 'http', host: GITHUB_HOST }),
        relayToken: null,
      });
  });

  test.each([
    { spelling: 'in different letter case', writtenHost: 'GitHub.com' },
    { spelling: 'with an explicit :443', writtenHost: `${GITHUB_HOST}:443` },
  ])(
    "with a second push URL that writes the signed-in host $spelling, ok push sends that URL's credential request only to OpenKnowledge's helper, which declines it, and never to the user's own helpers",
    async ({ writtenHost }) => {
      const server = await arrange({
        gitHubAccepts: OK_TOKEN,
        okStoreToken: OK_TOKEN,
        repository: (git, github) => {
          originUpstreamOnGitHub(git, github);
          git('config', '--add', 'remote.origin.pushurl', ORIGIN_URL);
          git('config', '--add', 'remote.origin.pushurl', `https://${writtenHost}/alice/demo.git`);
        },
      });

      const outcome = await syncWith(signedInSeam(), 'push');

      expect(server.requests, "the first push URL's receive-pack").toContainEqual(
        authenticatedRequest('push', { username: expect.any(String), password: OK_TOKEN }),
      );
      expect
        .soft(
          readJsonLines<CliHelperCall>(cliHelperLog),
          "OpenKnowledge's helper asked for the second URL",
        )
        .toContainEqual({
          args: ['auth', 'git-credential', 'get'],
          protocol: 'https',
          host: writtenHost,
        });
      expect
        .soft(readJsonLines<RecordedHelperCall>(helperLog), 'calls reaching the ambient helpers')
        .toEqual([]);
      expect.soft(outcome.error, 'the error runSync threw').not.toBeNull();
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      expect
        .soft(message, 'the failure ok push reports for the second push URL')
        .not.toContain("OpenKnowledge's GitHub sign-in");
    },
  );

  test("with OpenKnowledge signed in and no ambient credential, ok pull authenticates its fetch with OpenKnowledge's token", async () => {
    const server = await arrange({ gitHubAccepts: OK_TOKEN, okStoreToken: OK_TOKEN });

    const outcome = await syncWith(signedInSeam(), 'pull');

    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'pull',
    });
    expect
      .soft(server.requests, "the pull's authenticated fetch")
      .toContainEqual(
        authenticatedRequest('fetch', { username: expect.any(String), password: OK_TOKEN }),
      );
    expectCredentialConfinedToCliHelper(OK_TOKEN, { tracedCommand: 'pull' });
  });

  test("with OpenKnowledge signed in and no ambient credential, ok push authenticates with OpenKnowledge's token", async () => {
    const server = await arrange({ gitHubAccepts: OK_TOKEN, okStoreToken: OK_TOKEN });

    const outcome = await syncWith(signedInSeam(), 'push');

    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'push',
    });
    expect
      .soft(server.requests, "the push's authenticated receive-pack")
      .toContainEqual(
        authenticatedRequest('push', { username: expect.any(String), password: OK_TOKEN }),
      );
    const main = localAndRemoteMain(server.repositoryDir('alice/demo.git'));
    expect.soft(main.remote, "the remote's main after the push").toBe(main.local);
    expectCredentialConfinedToCliHelper(OK_TOKEN, { tracedCommand: 'push' });
  });

  test("with origin at an https URL whose path OpenKnowledge's credential chain cannot read, ok sync keeps the user's own credential and never asks OpenKnowledge's helper", async () => {
    const nestedRepository = 'team/alice/demo.git';
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      enterpriseAccepts: ENTERPRISE_USER.password,
      enterpriseAmbientCredential: ENTERPRISE_USER,
      repository: (git, github) => {
        const remote = github.repositoryDir(nestedRepository, ENTERPRISE_HOST);
        execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
        git('remote', 'add', 'origin', `https://${ENTERPRISE_HOST}/${nestedRepository}`);
        git('push', remote, 'main:main');
        git('config', 'branch.main.remote', 'origin');
        git('config', 'branch.main.merge', 'refs/heads/main');
        git('update-ref', 'refs/remotes/origin/main', 'main');
      },
    });

    const outcome = await syncWith(signedInSeam());

    const enterpriseRequests = server.requestsTo(ENTERPRISE_HOST);
    expect.soft(outcome.error, 'the error runSync threw').toBeNull();
    expect.soft(outcome.events, 'the events runSync emitted').toContainEqual({
      type: 'complete',
      op: 'sync',
    });
    expect.soft(enterpriseRequests, "the pull's fetch from the Enterprise host").toContainEqual({
      method: 'GET',
      path: `/${nestedRepository}/info/refs?service=git-upload-pack`,
      credential: ENTERPRISE_USER,
      status: 200,
    });
    expect
      .soft(enterpriseRequests, "the push's receive-pack on the Enterprise host")
      .toContainEqual({
        method: 'POST',
        path: `/${nestedRepository}/git-receive-pack`,
        credential: ENTERPRISE_USER,
        status: 200,
      });
    const main = localAndRemoteMain(server.repositoryDir(nestedRepository, ENTERPRISE_HOST));
    expect.soft(main.remote, "the Enterprise remote's main after sync").toBe(main.local);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect.soft(server.requests, 'requests reaching github.com').toEqual([]);
  });

  test("with no remote configured, ok sync still runs git's own pull and reports its failure", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      repository: () => {},
    });

    const outcome = await syncWith(signedInSeam());

    expect.soft(outcome.error, 'the error runSync threw').not.toBeNull();
    expect
      .soft(readFileSync(traceFile, 'utf-8'), "git's own pull in the trace")
      .toMatch(/built-in: git pull/);
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect.soft(server.requests, 'requests reaching github.com').toEqual([]);
  });

  test("on a detached HEAD, ok sync's fetch presents OpenKnowledge's token to the only remote", async () => {
    const server = await arrange({
      gitHubAccepts: OK_TOKEN,
      okStoreToken: OK_TOKEN,
      repository: (git, github) => {
        originUpstreamOnGitHub(git, github);
        git('checkout', '--quiet', '--detach');
      },
    });

    await syncWith(signedInSeam());

    expect
      .soft(server.requests, "the pull's authenticated fetch")
      .toContainEqual(
        authenticatedRequest('fetch', { username: expect.any(String), password: OK_TOKEN }),
      );
    expectCredentialConfinedToCliHelper(OK_TOKEN);
  });
});
