import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellSingleQuote } from '@inkeep/open-knowledge-core';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import {
  GITHUB_HOST,
  type GitHubStandIn,
  type PlainHttpInterceptor,
  startGitHubStandIn,
  startPlainHttpInterceptor,
} from '../../../tests/support/github-stand-in.test-helper.ts';
import {
  type CliHelperCall,
  gitConfigParameter as configParameter,
  type RecordedHelperCall as HelperCall,
  linesCarrying,
  readJsonLines,
  writeCliCredentialStandIn,
  writeCliEntryLauncher,
  writeRecordingCredentialHelper,
} from '../git-credential-fixtures.test-helper.ts';
import { type PublishResult, runPublishFlow as runPublishFlowProduct } from './publish.ts';

async function runPublishFlow(...args: Parameters<typeof runPublishFlowProduct>) {
  const result = await runPublishFlowProduct(...args);
  if (existsSync(join(args[0].projectDir, '.git', 'config'))) {
    configureTestGitRepository(args[0].projectDir);
  }
  return result;
}

const CLONE_URL = `https://${GITHUB_HOST}/alice/demo.git`;
const PUBLISH_TOKEN = 'ok-test-publish-token-the-stand-in-accepts';
const STALE_TOKEN = 'ok-test-publish-token-the-stand-in-rejects';
const AMBIENT_HELPERS = ['env-count', 'env-parameters', 'github-scoped', 'global'];
const ENTERPRISE_HOST = 'ghe.example.com';
const ENTERPRISE_CLONE_URL = `https://${ENTERPRISE_HOST}/alice/demo.git`;
const ENTERPRISE_PUBLISH_TOKEN = 'ok-test-publish-token-for-the-enterprise-host';
const ENTERPRISE_USER_PASSWORD = 'ok-test-enterprise-password-in-the-users-own-helper';
const INHERITED_RELAY_TOKEN = 'ok-test-relay-token-inherited-from-the-environment';

function octokitCreatingRepoAt(cloneUrl: string): Octokit {
  return {
    repos: {
      createForAuthenticatedUser: async () => ({
        data: { clone_url: cloneUrl, default_branch: 'main' },
      }),
    },
  } as unknown as Octokit;
}

describe("share publish authenticates its github.com push only through the CLI's own credential helper", () => {
  let workspace: string;
  let projectDir: string;
  let credentialStore: string;
  let helperLog: string;
  let cliHelperLog: string;
  let traceFile: string;
  let cliStandIn: string;
  let standIn: GitHubStandIn;
  let interceptor: PlainHttpInterceptor | undefined;

  beforeAll(() => {
    expect(
      process.env.GIT_CONFIG_GLOBAL,
      'precondition: GIT_CONFIG_GLOBAL must be unset, or git reads that file instead of the temporary HOME and the credentials this suite approves reach the helpers it names',
    ).toBeUndefined();
  });

  beforeEach(async () => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ok-publish-credential-')));
    const home = join(workspace, 'home');
    projectDir = join(workspace, 'project');
    credentialStore = join(workspace, 'git-credentials');
    helperLog = join(workspace, 'ambient-helper-calls.jsonl');
    cliHelperLog = join(workspace, 'cli-helper-calls.jsonl');
    traceFile = join(workspace, 'git-trace.log');
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
    writeFileSync(join(projectDir, 'README.md'), '# Hello\n', 'utf-8');
    standIn = await startGitHubStandIn({
      root: join(workspace, 'github'),
      acceptedPassword: PUBLISH_TOKEN,
      repositories: ['alice/demo.git'],
      enterpriseHosts: { [ENTERPRISE_HOST]: [ENTERPRISE_USER_PASSWORD, ENTERPRISE_PUBLISH_TOKEN] },
    });
    cliStandIn = writeCliCredentialStandIn({
      dir: workspace,
      callLog: cliHelperLog,
      authFile: join(workspace, 'ok-auth.yml'),
    });
    const recordingHelper = writeRecordingCredentialHelper(workspace, helperLog);

    const globalConfig = join(home, '.gitconfig');
    for (const [key, value] of [
      ['user.name', 'Publish Test'],
      ['user.email', 'publish-test@example.com'],
      ['init.defaultBranch', 'main'],
      ['commit.gpgsign', 'false'],
      ['http.proxy', standIn.proxyUrl],
      ['http.sslCAInfo', standIn.caFile],
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
      configParameter('credential.helper', recordingHelper('env-parameters')),
    );

    execFileSync('git', ['credential', 'approve'], {
      cwd: projectDir,
      input: `protocol=https\nhost=${GITHUB_HOST}\nusername=ambient-user\npassword=ambient-password\n\n`,
    });
    expect(
      readJsonLines<HelperCall>(helperLog).map((call) => `${call.label} ${call.operation}`),
    ).toEqual(expect.arrayContaining(AMBIENT_HELPERS.map((label) => `${label} store`)));
    expect(readFileSync(credentialStore, 'utf-8')).toContain('ambient-user');
    writeFileSync(helperLog, '', 'utf-8');
    vi.stubEnv('GIT_TRACE', traceFile);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await standIn.close();
    await interceptor?.close();
    interceptor = undefined;
    rmSync(workspace, { recursive: true, force: true });
  });

  async function publishWith(
    token: string,
    cloneUrl = CLONE_URL,
    credentialHelperEntry = cliStandIn,
  ): Promise<PublishResult> {
    const cliEntry = process.argv[1];
    process.argv[1] = credentialHelperEntry;
    try {
      return await runPublishFlow({
        octokit: octokitCreatingRepoAt(cloneUrl),
        token,
        projectDir,
        body: { owner: 'alice', name: 'demo', visibility: 'private' },
        ownerKind: 'user',
        deps: { ensureOkScaffold: () => {} },
      });
    } finally {
      process.argv[1] = cliEntry;
    }
  }

  function expectTokenConfinedToCliHelper(token: string): void {
    const trace = readFileSync(traceFile, 'utf-8');
    expect(trace).toMatch(/built-in: git push /);
    expect(trace).toMatch(/remote-https/);
    const projectGitConfig = readFileSync(join(projectDir, '.git', 'config'), 'utf-8');
    expect(projectGitConfig).toContain('[remote "origin"]');

    expect
      .soft(readJsonLines<HelperCall>(helperLog), 'calls reaching the ambient credential helpers')
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(credentialStore, 'utf-8'), token),
        'the ambient git-credential-store file',
      )
      .toEqual([]);
    expect
      .soft(linesCarrying(trace, token), 'argv of git push and its children (GIT_TRACE)')
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

  test('a publish whose token GitHub accepts pushes with that token and hands it to no ambient helper or command line', async () => {
    const result = await publishWith(PUBLISH_TOKEN);

    expect(result).toEqual({
      kind: 'ok',
      value: { ownerLogin: 'alice', repoName: 'demo', cloneUrl: CLONE_URL, defaultBranch: 'main' },
    });
    expect(standIn.requests).toContainEqual({
      method: 'POST',
      path: '/alice/demo.git/git-receive-pack',
      credential: { username: expect.any(String), password: PUBLISH_TOKEN },
      status: 200,
    });
    const pushedHead = execFileSync(
      'git',
      ['--git-dir', standIn.repositoryDir('alice/demo.git'), 'rev-parse', 'refs/heads/main'],
      { encoding: 'utf-8' },
    ).trim();
    expect(pushedHead).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf-8' }).trim(),
    );
    expectTokenConfinedToCliHelper(PUBLISH_TOKEN);
  });

  test("a publish's push authenticates through the real `ok auth git-credential get` command of the CLI entry", async () => {
    const realEntry = writeCliEntryLauncher({ dir: workspace, callLog: cliHelperLog });

    const result = await publishWith(PUBLISH_TOKEN, CLONE_URL, realEntry);

    expect(result).toEqual({
      kind: 'ok',
      value: { ownerLogin: 'alice', repoName: 'demo', cloneUrl: CLONE_URL, defaultBranch: 'main' },
    });
    expect(standIn.requests).toContainEqual({
      method: 'POST',
      path: '/alice/demo.git/git-receive-pack',
      credential: { username: 'x-access-token', password: PUBLISH_TOKEN },
      status: 200,
    });
    expectTokenConfinedToCliHelper(PUBLISH_TOKEN);
  });

  test("a publish whose push recurses into a submodule on a plain http:// GitHub URL never hands publish's token to the submodule's plain-http request", async () => {
    const onPath = await startPlainHttpInterceptor();
    interceptor = onPath;
    const submoduleSource = join(workspace, 'submodule-source');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', submoduleSource]);
    configureTestGitRepository(submoduleSource);
    execFileSync('git', ['-C', submoduleSource, 'commit', '--quiet', '--allow-empty', '-m', 'one']);
    git('init', '--quiet', '--initial-branch=main');
    configureTestGitRepository(projectDir);
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'a project');
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', submoduleSource, 'sub');
    configureTestGitRepository(join(projectDir, 'sub'));
    git('-C', 'sub', 'remote', 'set-url', 'origin', `http://${GITHUB_HOST}/alice/sub.git`);
    git('-C', 'sub', 'commit', '--quiet', '--allow-empty', '-m', 'not yet pushed');
    git('add', '.');
    git('commit', '--quiet', '-m', 'a project with a submodule');
    git('config', 'push.recurseSubmodules', 'on-demand');
    execFileSync('git', [
      'config',
      '--file',
      join(workspace, 'home', '.gitconfig'),
      `http.http://${GITHUB_HOST}.proxy`,
      onPath.proxyUrl,
    ]);

    const result = await publishWith(PUBLISH_TOKEN);

    expect(result).toEqual({ kind: 'error', code: 'push-failed' });
    expect(
      onPath.requests.map((request) => request.url),
      "the submodule's plain-http push",
    ).toContain(`http://${GITHUB_HOST}/alice/sub.git/info/refs?service=git-receive-pack`);
    expect
      .soft(
        onPath.requests.filter((request) => request.basicCredential?.includes(PUBLISH_TOKEN)),
        "plain-http requests carrying publish's token",
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
        readJsonLines<HelperCall>(helperLog),
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

  test('a publish whose token GitHub rejects presents that token and hands it to no ambient helper or command line', async () => {
    const result = await publishWith(STALE_TOKEN);

    expect(result).toEqual({ kind: 'error', code: 'push-failed' });
    expect(standIn.requests).toContainEqual({
      method: 'GET',
      path: '/alice/demo.git/info/refs?service=git-receive-pack',
      credential: { username: expect.any(String), password: STALE_TOKEN },
      status: 401,
    });
    expectTokenConfinedToCliHelper(STALE_TOKEN);
  });

  test('a publish presents its own token when its environment already carries an OK_GH_TOKEN relay for github.com', async () => {
    vi.stubEnv('OK_GH_TOKEN', INHERITED_RELAY_TOKEN);
    vi.stubEnv('OK_GH_TOKEN_HOST', GITHUB_HOST);

    const result = await publishWith(PUBLISH_TOKEN);

    expect(result).toEqual({
      kind: 'ok',
      value: { ownerLogin: 'alice', repoName: 'demo', cloneUrl: CLONE_URL, defaultBranch: 'main' },
    });
    expect(standIn.requests).toContainEqual({
      method: 'POST',
      path: '/alice/demo.git/git-receive-pack',
      credential: { username: expect.any(String), password: PUBLISH_TOKEN },
      status: 200,
    });
    expect(
      standIn.requests.filter((request) => request.credential?.password === INHERITED_RELAY_TOKEN),
    ).toEqual([]);
    expectTokenConfinedToCliHelper(PUBLISH_TOKEN);
  });

  test("a publish to a GitHub Enterprise host pushes its plain URL through the user's own credential helpers and never hands them publish's token", async () => {
    execFileSync('git', ['credential', 'approve'], {
      cwd: projectDir,
      input: `protocol=https\nhost=${ENTERPRISE_HOST}\nusername=enterprise-user\npassword=${ENTERPRISE_USER_PASSWORD}\n\n`,
    });
    expect(
      readJsonLines<HelperCall>(helperLog).map(
        (call) => `${call.label} ${call.operation} ${call.fields.host}`,
      ),
    ).toEqual(
      expect.arrayContaining(
        ['env-count', 'env-parameters', 'global'].map(
          (label) => `${label} store ${ENTERPRISE_HOST}`,
        ),
      ),
    );
    expect(readFileSync(credentialStore, 'utf-8')).toContain(
      `enterprise-user:${ENTERPRISE_USER_PASSWORD}@${ENTERPRISE_HOST}`,
    );
    writeFileSync(helperLog, '', 'utf-8');
    writeFileSync(traceFile, '', 'utf-8');

    const result = await publishWith(ENTERPRISE_PUBLISH_TOKEN, ENTERPRISE_CLONE_URL);

    const trace = readFileSync(traceFile, 'utf-8');
    expect(trace).toMatch(/built-in: git push /);
    expect(trace).toMatch(/remote-https/);
    const projectGitConfig = readFileSync(join(projectDir, '.git', 'config'), 'utf-8');
    expect(projectGitConfig).toContain('[remote "origin"]');
    const ambientCalls = readJsonLines<HelperCall>(helperLog);
    const enterpriseRequests = standIn.requestsTo(ENTERPRISE_HOST);

    expect.soft(result, 'the publish result').toEqual({
      kind: 'ok',
      value: {
        ownerLogin: 'alice',
        repoName: 'demo',
        cloneUrl: ENTERPRISE_CLONE_URL,
        defaultBranch: 'main',
      },
    });
    expect.soft(enterpriseRequests, 'requests reaching the enterprise host').toContainEqual({
      method: 'POST',
      path: '/alice/demo.git/git-receive-pack',
      credential: { username: 'enterprise-user', password: ENTERPRISE_USER_PASSWORD },
      status: 200,
    });
    expect
      .soft(
        execFileSync(
          'git',
          [
            '--git-dir',
            standIn.repositoryDir('alice/demo.git', ENTERPRISE_HOST),
            'for-each-ref',
            '--format=%(objectname)',
            'refs/heads/main',
          ],
          { encoding: 'utf-8' },
        ).trim(),
        "the enterprise repository's main branch",
      )
      .toBe(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf-8' }).trim(),
      );
    expect.soft(standIn.requests, 'requests reaching github.com').toEqual([]);
    expect
      .soft(ambientCalls, "the user's own helpers asked for the enterprise credential")
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
    expect
      .soft(readJsonLines<CliHelperCall>(cliHelperLog), "calls reaching the CLI's own helper")
      .toEqual([]);
    expect
      .soft(
        enterpriseRequests.filter(
          (request) => request.credential?.password === ENTERPRISE_PUBLISH_TOKEN,
        ),
        "enterprise requests presenting publish's token",
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(readFileSync(helperLog, 'utf-8'), ENTERPRISE_PUBLISH_TOKEN),
        'calls reaching the ambient credential helpers',
      )
      .toEqual([]);
    expect
      .soft(
        linesCarrying(trace, ENTERPRISE_PUBLISH_TOKEN),
        'argv of git push and its children (GIT_TRACE)',
      )
      .toEqual([]);
    expect
      .soft(linesCarrying(projectGitConfig, ENTERPRISE_PUBLISH_TOKEN), "the project's .git/config")
      .toEqual([]);
  });
});
