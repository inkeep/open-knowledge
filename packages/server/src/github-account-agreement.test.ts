/**
 * Agreement pin across the three consumers of declared-account resolution:
 * the push-permission probe, the sync engine's git handles, and the clone
 * path's URL resolution. One remote must resolve to one GitHub identity in
 * all three — an edit that threads the account into some consumers but not
 * others lets the probe report `allowed` as one account while the push
 * authenticates as another.
 *
 * Agreement is asserted at the account-resolution layer, via the scripted
 * gh fake's recorded arguments, not by comparing tokens alone: the three
 * consumers share no token cache (the probe calls `detectGh` raw), so a
 * same-token assertion could stay green while a consumer stopped requesting
 * the declared account.
 *
 * The clone leg is `resolveGitHubAccountFromUrl` plus a direct `detectGh`
 * forward: `ok clone` consumes exactly that resolver, but its forwarding
 * code lives in `packages/cli`, which this package cannot import (cli
 * already depends on server). The cli's own suites pin the forwarding; this
 * file pins that the resolution feeding it matches the server-side
 * consumers.
 */

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

/**
 * One gh for the whole scenario: any requested account is honored with its
 * own token, while a login-less request returns the active account's token,
 * which `detectGh` leaves unattributed.
 */
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
  /** The clone path's resolution of the same URL the origin points at. */
  urlAccount: GitHubAccount;
  /** What the clone path's forward into gh returned. */
  cloneResult: ReturnType<DetectGhFn>;
  /** The options the engine handed the probe, resolved account included. */
  probeOpts: CheckPushPermissionOptions[];
  /** Authorization header of every request the probe sent. */
  probeAuthHeaders: Array<string | null>;
  pushPermission: ReturnType<SyncEngine['getStatus']>['pushPermission'];
  handleEnv: GitHandle['env'];
  ghHosts: Array<string | undefined>;
  ghLogins: Array<string | undefined>;
}

/**
 * Drive all three consumers against one origin URL, one scripted gh, and
 * one credential-config state: the clone path's URL resolution first
 * (mirroring the clone-then-sync lifecycle), then a started engine whose
 * probe runs the real `checkPushPermission` with only the network faked.
 */
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
  // A 404 exercises the denied path, making the probe's identity
  // attribution observable alongside each request's Authorization header.
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

    // Every gh invocation — the clone forward, the engine's handles, the
    // probe — asked for alice on the origin's host; none resolved on its own.
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

    // No consumer passes a login: the repo owner is never an account
    // selector, and gh answers as whichever account is active.
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
