import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { GitHandle } from './git-handle.ts';
import {
  type CheckPushPermissionOptions,
  checkPushPermission,
  type DetectGhFn,
  type FetchFn,
} from './github-permissions.ts';
import {
  type CredentialUrlMatchReader,
  type GitHubAccount,
  resolveGitHubAccountFromUrl,
} from './share/github-account.ts';
import { SyncEngine } from './sync-engine.ts';

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

let tmpDir = '';
let projectDir = '';
let contentDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gh-account-agreement-'));
  projectDir = join(tmpDir, 'project');
  contentDir = join(tmpDir, 'content');
  mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function initGitWithOrigin(originUrl: string): Promise<void> {
  const git = simpleGit(projectDir);
  await git.init(['--initial-branch=main']);
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(join(projectDir, 'README.md'), 'seed\n', 'utf-8');
  await git.add('.');
  await git.commit('seed');
  await git.addRemote('origin', originUrl);
}

const scriptedGh = (_host?: string, login?: string): ReturnType<DetectGhFn> =>
  login
    ? { available: true, token: `gho_${login}`, resolvedLogin: login }
    : { available: true, token: 'gho_active' };

function recordDetectGh(): {
  fn: DetectGhFn;
  hosts: Array<string | undefined>;
  logins: Array<string | undefined>;
} {
  const hosts: Array<string | undefined> = [];
  const logins: Array<string | undefined> = [];
  return {
    fn: (host?: string, options?: { login?: string }) => {
      const login = options?.login;
      hosts.push(host);
      logins.push(login);
      return scriptedGh(host, login);
    },
    hosts,
    logins,
  };
}

async function waitForPushPermissionResolved(engine: SyncEngine, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (engine.getStatus().pushPermission === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`push-permission probe did not resolve within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface AgreementRun {
  urlAccount: GitHubAccount;
  cloneResult: ReturnType<DetectGhFn>;
  probeOpts: CheckPushPermissionOptions[];
  probeAuthHeaders: Array<string | null>;
  pushPermission: ReturnType<SyncEngine['getStatus']>['pushPermission'];
  handleEnv: GitHandle['env'];
  ghHosts: Array<string | undefined>;
  ghLogins: Array<string | undefined>;
}

async function runAgreementScenario(opts: {
  originUrl: string;
  credentialUrlMatch: string | null;
}): Promise<AgreementRun> {
  await initGitWithOrigin(opts.originUrl);
  const detect = recordDetectGh();
  const readUrlMatch: CredentialUrlMatchReader = () => opts.credentialUrlMatch;

  const urlAccount = resolveGitHubAccountFromUrl(opts.originUrl, {
    _readCredentialUrlMatch: readUrlMatch,
  });
  if (urlAccount.host === undefined) {
    throw new Error('agreement scenarios must use an origin URL that parses as GitHub');
  }
  const cloneResult = detect.fn(urlAccount.host, { login: urlAccount.login });

  const probeOpts: CheckPushPermissionOptions[] = [];
  const probeAuthHeaders: Array<string | null> = [];
  const fetchNotFound: FetchFn = async (_url, init) => {
    probeAuthHeaders.push(new Headers(init?.headers).get('authorization'));
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };

  const engine = new SyncEngine({
    projectDir,
    contentDir,
    contentFilter: stubContentFilter,
    syncEnabled: false,
    detectGh: detect.fn,
    _readCredentialUrlMatch: readUrlMatch,
    checkPushPermissionFn: (o) => {
      probeOpts.push(o);
      return checkPushPermission({ ...o, _fetchFn: fetchNotFound });
    },
  });
  try {
    await engine.start();
    await waitForPushPermissionResolved(engine);
    const handle = (engine as unknown as { gitHandle: () => GitHandle }).gitHandle();
    return {
      urlAccount,
      cloneResult,
      probeOpts,
      probeAuthHeaders,
      pushPermission: engine.getStatus().pushPermission,
      handleEnv: handle.env,
      ghHosts: detect.hosts,
      ghLogins: detect.logins,
    };
  } finally {
    await engine.destroy();
  }
}

describe('declared-account agreement across probe, push, and clone', () => {
  test('a remote-URL-declared account resolves to one identity in all three consumers', async () => {
    const run = await runAgreementScenario({
      originUrl: 'https://alice@github.com/acme/kb.git',
      credentialUrlMatch: null,
    });

    expect(run.urlAccount).toEqual({ host: 'github.com', login: 'alice', source: 'remote-url' });
    expect(run.probeOpts).toHaveLength(1);
    expect(run.probeOpts[0]?.account).toMatchObject({ login: 'alice', source: 'remote-url' });

    expect(run.ghLogins.length).toBeGreaterThanOrEqual(3);
    expect(run.ghLogins.every((l) => l === 'alice')).toBe(true);
    expect(run.ghHosts.every((h) => h === 'github.com')).toBe(true);

    expect(run.cloneResult).toMatchObject({ token: 'gho_alice', resolvedLogin: 'alice' });
    expect(run.probeAuthHeaders).toEqual(['Bearer gho_alice']);
    expect(run.pushPermission).toEqual({
      checkStatus: 'denied',
      deniedReason: 'private-no-access',
      resolvedLogin: 'alice',
    });
    expect(run.handleEnv.OK_GH_TOKEN).toBe('gho_alice');
    expect(run.handleEnv.OK_GH_TOKEN_LOGIN).toBe('alice');
  });

  test('a credential-config-declared account resolves to one identity in all three consumers', async () => {
    const run = await runAgreementScenario({
      originUrl: 'https://github.com/acme/kb.git',
      credentialUrlMatch: 'credential.helper osxkeychain\ncredential.username workbot\n',
    });

    expect(run.urlAccount).toEqual({
      host: 'github.com',
      login: 'workbot',
      source: 'credential-config',
    });
    expect(run.probeOpts[0]?.account).toMatchObject({
      login: 'workbot',
      source: 'credential-config',
    });

    expect(run.ghLogins.length).toBeGreaterThanOrEqual(3);
    expect(run.ghLogins.every((l) => l === 'workbot')).toBe(true);
    expect(run.ghHosts.every((h) => h === 'github.com')).toBe(true);

    expect(run.cloneResult).toMatchObject({ token: 'gho_workbot', resolvedLogin: 'workbot' });
    expect(run.probeAuthHeaders).toEqual(['Bearer gho_workbot']);
    expect(run.pushPermission).toEqual({
      checkStatus: 'denied',
      deniedReason: 'private-no-access',
      resolvedLogin: 'workbot',
    });
    expect(run.handleEnv.OK_GH_TOKEN).toBe('gho_workbot');
    expect(run.handleEnv.OK_GH_TOKEN_LOGIN).toBe('workbot');
  });

  test('with no declared account, all three consumers agree on the active gh account', async () => {
    const run = await runAgreementScenario({
      originUrl: 'https://github.com/inkeep/kb.git',
      credentialUrlMatch: null,
    });

    expect(run.urlAccount).toEqual({ host: 'github.com', source: 'active' });
    expect(run.urlAccount.login).toBeUndefined();
    expect(run.probeOpts[0]?.account).toMatchObject({ source: 'active' });
    expect(run.probeOpts[0]?.account?.login).toBeUndefined();

    expect(run.ghLogins.length).toBeGreaterThanOrEqual(3);
    expect(run.ghLogins.every((l) => l === undefined)).toBe(true);

    expect(run.cloneResult.token).toBe('gho_active');
    expect(run.cloneResult.resolvedLogin).toBeUndefined();
    expect(run.probeAuthHeaders).toEqual(['Bearer gho_active']);
    expect(run.pushPermission).toEqual({
      checkStatus: 'denied',
      deniedReason: 'private-no-access',
    });
    expect(run.handleEnv.OK_GH_TOKEN).toBe('gho_active');
    expect('OK_GH_TOKEN_LOGIN' in run.handleEnv).toBe(false);
  });
});
