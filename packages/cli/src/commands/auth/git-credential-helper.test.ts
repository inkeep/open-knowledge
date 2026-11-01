import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import {
  GITHUB_HOST,
  type GitHubStandIn,
  startGitHubStandIn,
} from '../../../tests/support/github-stand-in.test-helper.ts';
import { buildCliCredentialHelper } from '../../auth/resolve-auth.ts';
import { linesCarrying } from '../git-credential-fixtures.test-helper.ts';

const CLI_DIST = resolve(import.meta.dirname, '../../../dist');
const CLI_ENTRY = join(CLI_DIST, 'cli.mjs');
const ORIGIN_URL = `https://${GITHUB_HOST}/alice/demo.git`;
const RELAY_TOKEN = 'ok-test-helper-relay-token-github-accepts';
const STALE_RELAY_TOKEN = 'ok-test-helper-relay-token-github-rejects';
const GET_BUNDLE_BUDGET_BYTES = 300 * 1024;
const UPDATE_BUNDLE_BUDGET_BYTES = 8 * 1024;
const HELPER_INPUT = `protocol=https\nhost=${GITHUB_HOST}\n\n`;
const CHILD_TIMEOUT_MS = 10_000;

const LOAD_PROBE = `import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});
process.on('exit', () => writeFileSync(process.env.OK_TEST_LOAD_RECORD, JSON.stringify(loaded)));
`;

let workspace: string;
let home: string;
let projectDir: string;
let traceFile: string;
let standIn: GitHubStandIn | undefined;

function hermeticEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function helperOperations(): string[] {
  if (!existsSync(traceFile)) return [];
  return linesCarrying(readFileSync(traceFile, 'utf-8'), 'run_command:').flatMap((line) => {
    const operation = /auth git-credential (get|store|erase)\b/.exec(line)?.[1];
    return operation === undefined ? [] : [operation];
  });
}

function fetchThroughOkHelper(
  relayToken: string,
): Promise<{ status: number | null; stderr: string }> {
  const fetch = spawn(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      buildCliCredentialHelper([process.execPath, CLI_ENTRY]),
      '-c',
      'credential.interactive=false',
      'fetch',
      'origin',
    ],
    {
      cwd: projectDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: hermeticEnv({
        GIT_TRACE: traceFile,
        OK_GH_TOKEN: relayToken,
        OK_GH_TOKEN_HOST: GITHUB_HOST,
      }),
    },
  );
  let stderr = '';
  fetch.stderr.setEncoding('utf-8');
  fetch.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number | null;
    stderr: string;
  }>();
  fetch.once('error', reject);
  fetch.once('close', (status) => resolve({ status, stderr }));
  return promise;
}

interface LoadedBundle {
  status: number | null;
  stdout: string;
  stderr: string;
  bytes: number;
  files: string[];
}

function bundleLoadedBy(args: readonly string[]): LoadedBundle {
  const probe = join(workspace, 'load-probe.mjs');
  const record = join(workspace, 'loaded-modules.json');
  writeFileSync(probe, LOAD_PROBE);
  const run = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(probe).href, CLI_ENTRY, ...args],
    {
      cwd: projectDir,
      input: HELPER_INPUT,
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: hermeticEnv({
        OK_TEST_LOAD_RECORD: record,
        OK_GH_TOKEN: RELAY_TOKEN,
        OK_GH_TOKEN_HOST: GITHUB_HOST,
      }),
    },
  );
  expect(
    run.error,
    `${args.join(' ')} did not finish within ${CHILD_TIMEOUT_MS} ms:\n${run.stderr}`,
  ).toBeUndefined();
  const dist = realpathSync(CLI_DIST);
  const files = (JSON.parse(readFileSync(record, 'utf-8')) as string[])
    .filter((url) => url.startsWith('file:'))
    .map((url) => realpathSync(fileURLToPath(url)))
    .filter((path) => path.startsWith(`${dist}${sep}`));
  expect(files, 'the load probe saw no dist/cli.mjs, so it measured nothing').toContain(
    join(dist, 'cli.mjs'),
  );
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    bytes: files.reduce((sum, path) => sum + statSync(path).size, 0),
    files,
  };
}

describe("git authenticates through OpenKnowledge's built credential helper", () => {
  beforeAll(() => {
    expect(
      existsSync(CLI_ENTRY),
      `${CLI_ENTRY} is missing. The cli \`test\` turbo task builds it first; a bare vitest run needs \`pnpm --dir packages/cli run build:cli\`.`,
    ).toBe(true);
  });

  beforeEach(async () => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ok-git-credential-helper-')));
    home = join(workspace, 'home');
    projectDir = join(workspace, 'project');
    traceFile = join(workspace, 'git-trace.log');
    mkdirSync(home, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    standIn = await startGitHubStandIn({
      root: join(workspace, 'github'),
      acceptedPassword: RELAY_TOKEN,
      repositories: ['alice/demo.git'],
    });
    for (const [key, value] of [
      ['user.name', 'Helper Test'],
      ['user.email', 'helper-test@example.com'],
      ['init.defaultBranch', 'main'],
      ['commit.gpgsign', 'false'],
      ['http.proxy', standIn.proxyUrl],
      ['http.sslCAInfo', standIn.caFile],
      ['http.curloptResolve', `${GITHUB_HOST}:443:127.0.0.1`],
    ]) {
      execFileSync('git', ['config', '--file', join(home, '.gitconfig'), '--add', key, value]);
    }
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: projectDir, env: hermeticEnv(), stdio: 'ignore' });
    git('init', '--initial-branch=main');
    configureTestGitRepository(projectDir);
    git('commit', '--allow-empty', '-m', 'seed');
    git('push', standIn.repositoryDir('alice/demo.git'), 'main:main');
    git('remote', 'add', 'origin', ORIGIN_URL);
  });

  afterEach(async () => {
    await standIn?.close();
    standIn = undefined;
    rmSync(workspace, { recursive: true, force: true });
  });

  test('an accepted token is fetched with get, then git reports it to store without an error', async () => {
    const fetched = await fetchThroughOkHelper(RELAY_TOKEN);

    expect(fetched.status, fetched.stderr).toBe(0);
    expect(standIn?.requests.filter((request) => request.status === 200)).toContainEqual(
      expect.objectContaining({
        credential: { username: 'x-access-token', password: RELAY_TOKEN },
      }),
    );
    expect(helperOperations()).toEqual(['get', 'store']);
    expect(linesCarrying(fetched.stderr, 'error:')).toEqual([]);
  });

  test('a rejected token is reported to erase without an error from the helper', async () => {
    const fetched = await fetchThroughOkHelper(STALE_RELAY_TOKEN);

    expect(fetched.status).not.toBe(0);
    expect(fetched.stderr).toContain('Authentication failed');
    expect(helperOperations()).toEqual(['get', 'erase']);
    expect(linesCarrying(fetched.stderr, 'error:')).toEqual([]);
  });

  test('each helper call loads only its own slice of the bundle, not the whole CLI', () => {
    const get = bundleLoadedBy(['auth', 'git-credential', 'get']);
    expect(get.status, get.stderr).toBe(0);
    expect(get.bytes, get.files.join('\n')).toBeLessThan(GET_BUNDLE_BUDGET_BYTES);
    for (const operation of ['store', 'erase']) {
      const update = bundleLoadedBy(['auth', 'git-credential', operation]);
      expect(update.status, update.stderr).toBe(0);
      expect(update.bytes, update.files.join('\n')).toBeLessThan(UPDATE_BUNDLE_BUDGET_BYTES);
    }
  });

  test('any other argv shape runs the full CLI, which applies its options and errors', () => {
    const prefixed = bundleLoadedBy(['--log-level', 'debug', 'auth', 'git-credential', 'get']);
    expect(prefixed.bytes).toBeGreaterThan(GET_BUNDLE_BUDGET_BYTES);
    expect(prefixed.status, prefixed.stderr).toBe(0);
    expect(prefixed.stdout).toBe(`username=x-access-token\npassword=${RELAY_TOKEN}\n`);

    const help = bundleLoadedBy(['auth', 'git-credential', 'get', '--help']);
    expect(help.bytes).toBeGreaterThan(GET_BUNDLE_BUDGET_BYTES);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage:');

    const unknown = bundleLoadedBy(['auth', 'git-credential', 'frob']);
    expect(unknown.bytes).toBeGreaterThan(GET_BUNDLE_BUDGET_BYTES);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("error: unknown command 'frob'");
  });
});
