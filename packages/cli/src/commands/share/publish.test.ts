/**
 * Unit + integration tests for the publish flow.
 *
 * The orchestrator (`runPublishFlow`) is dependency-injected (octokit,
 * `ensureOkScaffold`, `gitFactory`) so all five branches of the error
 * taxonomy are reachable without GitHub or a real git binary. A final
 * integration test runs the full orchestrator against a tempdir + a fake
 * Octokit that responds with a "remote" pointer at a second tempdir
 * initialized as a bare repo — that way `git push` succeeds end-to-end
 * with no network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import { classifyOctokitError, runPublishFlow } from './publish.ts';

// ─── Octokit fake factory ─────────────────────────────────────────────────────

interface FakeOctokitOptions {
  authLogin?: string;
  authThrow?: { status?: number; message?: string };
  createUserRepo?:
    | { clone_url: string; default_branch?: string }
    | { __throw: { status?: number; message?: string; response?: unknown } };
  createOrgRepo?:
    | { clone_url: string; default_branch?: string }
    | { __throw: { status?: number; message?: string; response?: unknown } };
  /** Fixture for the `repos.get` idempotency probe after a 422 create-repo failure. */
  getRepo?: { clone_url: string; default_branch?: string } | { __throw: { status?: number } };
}

function makeFakeOctokit(opts: FakeOctokitOptions = {}): Octokit {
  return {
    users: {
      getAuthenticated: async () => {
        if (opts.authThrow) {
          throw Object.assign(new Error(opts.authThrow.message ?? 'fake'), {
            status: opts.authThrow.status,
          });
        }
        return { data: { login: opts.authLogin ?? 'alice' } };
      },
    },
    repos: {
      createForAuthenticatedUser: async () => {
        if (opts.createUserRepo && '__throw' in opts.createUserRepo) {
          throw Object.assign(new Error(opts.createUserRepo.__throw.message ?? 'fake'), {
            status: opts.createUserRepo.__throw.status,
            response: opts.createUserRepo.__throw.response,
          });
        }
        if (!opts.createUserRepo) {
          throw new Error('createUserRepo fixture missing');
        }
        return {
          data: {
            clone_url: opts.createUserRepo.clone_url,
            default_branch: opts.createUserRepo.default_branch ?? 'main',
          },
        };
      },
      createInOrg: async () => {
        if (opts.createOrgRepo && '__throw' in opts.createOrgRepo) {
          throw Object.assign(new Error(opts.createOrgRepo.__throw.message ?? 'fake'), {
            status: opts.createOrgRepo.__throw.status,
            response: opts.createOrgRepo.__throw.response,
          });
        }
        if (!opts.createOrgRepo) {
          throw new Error('createOrgRepo fixture missing');
        }
        return {
          data: {
            clone_url: opts.createOrgRepo.clone_url,
            default_branch: opts.createOrgRepo.default_branch ?? 'main',
          },
        };
      },
      get: async () => {
        if (opts.getRepo && '__throw' in opts.getRepo) {
          throw Object.assign(new Error('not found'), {
            status: opts.getRepo.__throw.status ?? 404,
          });
        }
        if (!opts.getRepo) {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        return {
          data: {
            clone_url: opts.getRepo.clone_url,
            default_branch: opts.getRepo.default_branch ?? 'main',
          },
        };
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake; only the touched surface matters.
  } as any;
}

// ─── classifyOctokitError ────────────────────────────────────────────────────

describe('classifyOctokitError', () => {
  test('422 with "name already exists" → name-conflict', () => {
    const code = classifyOctokitError({
      status: 422,
      message: 'Validation Failed',
      response: { data: { errors: [{ message: 'name already exists on this account' }] } },
    });
    expect(code).toBe('name-conflict');
  });

  test('422 with unrelated message → network', () => {
    const code = classifyOctokitError({
      status: 422,
      message: 'Validation Failed',
      response: { data: { errors: [{ message: 'unrelated' }] } },
    });
    expect(code).toBe('network');
  });

  test('403 with "saml" in the body → saml-sso', () => {
    const code = classifyOctokitError({
      status: 403,
      message: 'Forbidden',
      response: {
        data: { message: 'Resource protected by organization SAML enforcement' },
      },
    });
    expect(code).toBe('saml-sso');
  });

  test('403 without SSO marker → network', () => {
    const code = classifyOctokitError({
      status: 403,
      message: 'Rate limit exceeded',
      response: { data: { message: 'API rate limit exceeded' } },
    });
    expect(code).toBe('network');
  });

  test('401 → auth-required', () => {
    expect(classifyOctokitError({ status: 401 })).toBe('auth-required');
  });

  test('500 → network', () => {
    expect(classifyOctokitError({ status: 500 })).toBe('network');
  });

  test('403 with X-GitHub-SSO header → saml-sso (canonical signal, no body marker needed)', () => {
    const code = classifyOctokitError({
      status: 403,
      message: 'Forbidden',
      response: {
        headers: {
          'x-github-sso':
            'required; url=https://github.com/orgs/inkeep/sso?authorization_request=abc',
        },
        data: { message: 'Forbidden' },
      },
    });
    expect(code).toBe('saml-sso');
  });

  test('422 with errors[].field === "name" → name-conflict (structured signal)', () => {
    const code = classifyOctokitError({
      status: 422,
      message: 'Validation Failed',
      response: {
        data: {
          message: 'Repository creation failed.',
          errors: [
            { resource: 'Repository', code: 'custom', field: 'name', message: 'something' },
          ] as unknown as Array<{ message?: string; field?: string }>,
        },
      },
    });
    expect(code).toBe('name-conflict');
  });
});

// ─── runPublishFlow — error branches with mocked git ──────────────────────────

describe('runPublishFlow (error branches)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-share-publish-err-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('auth-required when probeOwnerKind throws 401', async () => {
    const result = await runPublishFlow({
      octokit: makeFakeOctokit({ authThrow: { status: 401 } }),
      token: 'tok',
      projectDir: tmpDir,
      body: { owner: 'alice', name: 'foo', visibility: 'private' },
    });
    expect(result).toEqual({ kind: 'error', code: 'auth-required' });
  });

  test('name-conflict propagates from createInOrg', async () => {
    const result = await runPublishFlow({
      octokit: makeFakeOctokit({
        createOrgRepo: {
          __throw: {
            status: 422,
            response: { data: { errors: [{ message: 'name already exists on this account' }] } },
          },
        },
      }),
      token: 'tok',
      projectDir: tmpDir,
      body: { owner: 'inkeep', name: 'open-knowledge', visibility: 'public' },
      ownerKind: 'org',
      deps: {
        ensureOkScaffold: () => {},
        // `git init` runs BEFORE `createGitHubRepo` in the orchestrator, so
        // the factory must return a usable git stub. The only methods
        // touched on this error path are `.init()` (no-op) — `.addRemote`
        // and `.raw` never fire because Octokit throws first. Each is
        // shaped as a thennable so simple-git's typings line up.
        gitFactory: () =>
          ({
            init: async () => {},
            addRemote: async () => {
              throw new Error('addRemote should not be reached on name-conflict');
            },
            raw: async () => {
              throw new Error('raw should not be reached on name-conflict');
            },
            add: async () => {},
            // biome-ignore lint/suspicious/noExplicitAny: test stub; partial SimpleGit surface.
          }) as any,
      },
    });
    expect(result).toEqual({ kind: 'error', code: 'name-conflict' });
  });

  test('idempotent retry: 422 + existing-repo-at-owner proceeds to push (e2e)', async () => {
    // Simulate the retry-after-push-failure path: createForAuthenticatedUser
    // throws 422 (repo already exists from the partial first attempt), then
    // `repos.get` returns the existing repo and the orchestrator continues
    // to addRemote + commit + push instead of returning name-conflict.
    const bareRepo = mkdtempSync(join(tmpdir(), 'ok-share-publish-retry-bare-'));
    execSync('git init --bare', { cwd: bareRepo, stdio: 'ignore' });
    // Pre-init the project repo + set local gitconfig identity. simple-git's
    // `.env({GIT_TERMINAL_PROMPT: '0'})` REPLACES the subprocess env (does
    // not merge) so process.env-based GIT_AUTHOR_* don't propagate. Repo-
    // local config is the only reliable cross-environment identity source —
    // dev machines have global config; CI runners don't, and the env-var
    // pattern silently drops with simple-git's replace semantics.
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name Test', { cwd: tmpDir });
    execSync('git config user.email test@example.com', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'README.md'), '# Hello\n', 'utf-8');
    try {
      const bareUrl = `file://${bareRepo}`;
      const result = await runPublishFlow({
        octokit: makeFakeOctokit({
          authLogin: 'alice',
          createUserRepo: {
            __throw: {
              status: 422,
              response: { data: { errors: [{ field: 'name', message: 'name already exists' }] } },
            },
          },
          getRepo: { clone_url: bareUrl, default_branch: 'main' },
        }),
        token: 'gho_fake',
        projectDir: tmpDir,
        body: { owner: 'alice', name: 'open-knowledge', visibility: 'private' },
        ownerKind: 'user',
        deps: { ensureOkScaffold: () => {} },
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.value.cloneUrl).toBe(bareUrl);
      }
    } finally {
      rmSync(bareRepo, { recursive: true, force: true });
    }
  });

  test('422 with no existing repo at owner still returns name-conflict', async () => {
    const result = await runPublishFlow({
      octokit: makeFakeOctokit({
        authLogin: 'alice',
        createUserRepo: {
          __throw: {
            status: 422,
            response: { data: { errors: [{ field: 'name', message: 'name already exists' }] } },
          },
        },
        // No `getRepo` fixture → fake throws 404 → tryFetchExistingRepo returns null.
      }),
      token: 'tok',
      projectDir: tmpDir,
      body: { owner: 'alice', name: 'foo', visibility: 'private' },
      ownerKind: 'user',
      deps: { ensureOkScaffold: () => {} },
    });
    expect(result).toEqual({ kind: 'error', code: 'name-conflict' });
  });

  test('init-failed when ensureOkScaffold throws', async () => {
    const result = await runPublishFlow({
      octokit: makeFakeOctokit({ authLogin: 'alice' }),
      token: 'tok',
      projectDir: tmpDir,
      body: { owner: 'alice', name: 'foo', visibility: 'private' },
      ownerKind: 'user',
      deps: {
        ensureOkScaffold: () => {
          throw new Error('symlink-blocked');
        },
      },
    });
    expect(result).toEqual({ kind: 'error', code: 'init-failed' });
  });
});

// ─── runPublishFlow — end-to-end against bare-repo "remote" ──────────────────

describe('runPublishFlow (e2e against bare repo)', () => {
  let workspace: string;
  let projectDir: string;
  let bareRepo: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ok-share-publish-e2e-'));
    projectDir = join(workspace, 'project');
    bareRepo = join(workspace, 'remote.git');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(bareRepo, { recursive: true });
    execSync('git init --bare', { cwd: bareRepo, stdio: 'ignore' });
    // Seed the project with a single markdown file so the initial commit
    // has real content (matches the real Publish flow's expectations).
    writeFileSync(join(projectDir, 'README.md'), '# Hello\n', 'utf-8');
    // Pre-init the project repo + set local gitconfig identity. simple-git's
    // `.env({GIT_TERMINAL_PROMPT: '0'})` REPLACES the subprocess env (does
    // not merge), so process.env-based `GIT_AUTHOR_*` vars never propagate
    // to the spawned git process. Repo-local config is the only reliable
    // cross-environment identity source — dev machines have global config
    // (so the previous env-var approach silently worked locally), but CI
    // runners don't and the commit step fails with "Please tell me who
    // you are." The publish flow's `existsSync('.git')` check skips its
    // own `git init` when we've already initialised the repo.
    execSync('git init', { cwd: projectDir, stdio: 'ignore' });
    execSync('git config user.name Test', { cwd: projectDir });
    execSync('git config user.email test@example.com', { cwd: projectDir });
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('happy path: init → create → addRemote → commit → push to bare repo', async () => {
    // The fake Octokit returns the file:// URL of the bare repo as
    // `clone_url`. simple-git pushes against that URL natively.
    const bareUrl = `file://${bareRepo}`;
    const result = await runPublishFlow({
      octokit: makeFakeOctokit({
        authLogin: 'alice',
        createUserRepo: { clone_url: bareUrl, default_branch: 'main' },
      }),
      // The token doesn't matter for a file:// push — the URL splice is
      // a no-op against a non-https URL. Pass anything non-empty.
      token: 'irrelevant',
      projectDir,
      body: { owner: 'alice', name: 'demo', visibility: 'private' },
      ownerKind: 'user',
      // Skip the real `initContent` so the test doesn't need the @inkeep/
      // open-knowledge-core dist build. The flow still mkdirs the project
      // path because beforeEach already created it.
      deps: {
        ensureOkScaffold: (dir) => {
          // Drop a stub .ok/.gitignore to mirror initContent's effect for
          // staging. The orchestrator stages this with `git add .`.
          mkdirSync(join(dir, '.ok'), { recursive: true });
          writeFileSync(join(dir, '.ok', '.gitignore'), 'local/\n', 'utf-8');
        },
      },
    });
    expect(result).toEqual({
      kind: 'ok',
      value: {
        ownerLogin: 'alice',
        repoName: 'demo',
        cloneUrl: bareUrl,
        defaultBranch: 'main',
      },
    });
    // The bare repo received the push — verify by inspecting the refs.
    const refs = execSync('git --git-dir=. show-ref', {
      cwd: bareRepo,
      encoding: 'utf-8',
    });
    expect(refs).toContain('refs/heads/main');
    // The project's local origin remote is the clean URL (no token).
    const git = simpleGit(projectDir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    expect(origin?.refs?.push).toBe(bareUrl);
    // Initial commit message landed.
    const log = execSync('git log --format=%s', { cwd: projectDir, encoding: 'utf-8' });
    expect(log).toContain('Initial commit');
    // The `.ok/.gitignore` was staged + committed.
    const tree = execSync('git ls-tree -r HEAD --name-only', {
      cwd: projectDir,
      encoding: 'utf-8',
    });
    expect(tree).toContain('.ok/.gitignore');
    // Sanity: README went up too.
    expect(tree).toContain('README.md');
    expect(readFileSync(join(projectDir, 'README.md'), 'utf-8')).toBe('# Hello\n');
    // POST-PUSH REF SYNC — the local `refs/remotes/origin/<default>` ref
    // must exist after publish so the Share button's local-only
    // branch-on-origin check succeeds on the very next click.
    // Without this, the publish→share fall-through always toasts
    // "Push <branch> to GitHub before sharing." on first attempt.
    const remoteRefSha = execSync('git rev-parse refs/remotes/origin/main', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    const headSha = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
    expect(remoteRefSha).toBe(headSha);
  });
});
