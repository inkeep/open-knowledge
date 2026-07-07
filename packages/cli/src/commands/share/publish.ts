/**
 * `open-knowledge share publish` — drive a no-remote project to first share.
 *
 * Sequence (publish scaffold, first commit, and remote push):
 *   1. Ensure `.ok/` scaffold exists (calls `initContent` if missing) so the
 *      project-root `.ok/.gitignore` is staged before the first commit lands.
 *   2. `git init` if `.git` is absent.
 *   3. Octokit `repos.createForAuthenticatedUser` (`kind === 'user'`) or
 *      `repos.createInOrg` (`kind === 'org'`). Visibility defaults to private
 *      per publish defaults; description optional. On 422 with "name already exists on
 *      this account", surface `name-conflict`; on 403 with SSO body marker,
 *      surface `saml-sso`.
 *   4. `git.addRemote('origin', <cloneUrl>)`.
 *   5. Stage all + `git.commit('Initial commit')` iff no commits yet.
 *      A project pre-seeded with a commit history (rare for the no-remote
 *      path but possible) gets the existing HEAD pushed as-is.
 *   6. Push HEAD to origin's default branch using an inline token URL so
 *      the operation works without depending on the user's git credential
 *      configuration. The token-bearing URL only lives in the simple-git
 *      argv for the duration of one push; the persistent origin remote is
 *      stored as the clean clone URL.
 *
 * Events:
 *   { type: 'publish', ownerLogin, repoName, cloneUrl, defaultBranch }
 *   { type: 'error', code: 'name-conflict' | 'saml-sso' | 'auth-required' |
 *                          'push-failed' | 'init-failed' | 'network' }
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initContent } from '@inkeep/open-knowledge-server';
import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';
import type { TokenStore } from '../../auth/token-store.ts';
import { resolveReposToken } from '../auth/repos.ts';
import { validateGitHubHost } from '../auth/validate-host.ts';

interface PublishOptions {
  host: string;
  owner: string;
  name: string;
  visibility: 'public' | 'private';
  description?: string;
  projectDir: string;
  json: boolean;
}

export interface PublishSuccess {
  ownerLogin: string;
  repoName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export type PublishErrorCode =
  | 'name-conflict'
  | 'saml-sso'
  | 'auth-required'
  | 'push-failed'
  | 'init-failed'
  | 'network';

export type PublishResult =
  | { kind: 'ok'; value: PublishSuccess }
  | { kind: 'error'; code: PublishErrorCode };

// ─── Octokit error classification ─────────────────────────────────────────────

interface OctokitErrorShape {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
    data?: {
      message?: string;
      errors?: Array<{ message?: string; field?: string }>;
    };
  };
}

/**
 * Map a thrown Octokit response into one of the documented error codes.
 *
 * 403 SAML detection prefers the `X-GitHub-SSO` response header (GitHub's
 * canonical signal — Octokit exposes it via `err.response.headers`); falls
 * back to substring matching on body text for transports that drop the
 * header. The substring fallback keeps existing test fixtures that mock
 * only the body shape green.
 *
 * 422 → `name-conflict` prefers the structured `errors[].field === 'name'`
 * signal (what GitHub actually emits for repo name conflicts); falls back
 * to substring matching on the message for resilience against shape drift.
 *
 * 401 means the token is unusable.
 */
export function classifyOctokitError(err: unknown): PublishErrorCode {
  const e = err as OctokitErrorShape;
  const status = e.status;
  const body = e.response?.data;
  const headers = e.response?.headers;
  const bodyMsg = body?.message ?? body?.errors?.map((er) => er.message ?? '').join('\n') ?? '';
  const combined = `${bodyMsg}\n${e.message ?? ''}`.toLowerCase();
  if (status === 401) return 'auth-required';
  if (status === 403) {
    const ssoHeader = headers?.['x-github-sso'];
    if (ssoHeader || combined.includes('saml') || combined.includes('sso')) {
      return 'saml-sso';
    }
    return 'network';
  }
  if (status === 422) {
    if (body?.errors?.some((er) => er.field === 'name')) return 'name-conflict';
    if (combined.includes('already exists') || combined.includes('name already exists')) {
      return 'name-conflict';
    }
    return 'network';
  }
  return 'network';
}

// ─── Octokit repo creation ────────────────────────────────────────────────────

interface CreateRepoArgs {
  octokit: Octokit;
  ownerLogin: string;
  ownerKind: 'user' | 'org';
  name: string;
  visibility: 'public' | 'private';
  description?: string;
}

interface CreatedRepo {
  cloneUrl: string;
  defaultBranch: string;
}

/**
 * Create a repo under the chosen owner. Personal accounts use
 * `repos.createForAuthenticatedUser`; orgs use `repos.createInOrg`. Both
 * return the same shape we need (clone_url + default_branch). Octokit's
 * thrown response is mapped by the caller via `classifyOctokitError`.
 */
async function createGitHubRepo(args: CreateRepoArgs): Promise<CreatedRepo> {
  const { octokit, ownerLogin, ownerKind, name, visibility, description } = args;
  const isPrivate = visibility === 'private';
  if (ownerKind === 'user') {
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name,
      private: isPrivate,
      ...(description ? { description } : {}),
    });
    return { cloneUrl: data.clone_url, defaultBranch: data.default_branch ?? 'main' };
  }
  const { data } = await octokit.repos.createInOrg({
    org: ownerLogin,
    name,
    visibility,
    ...(description ? { description } : {}),
  });
  return { cloneUrl: data.clone_url, defaultBranch: data.default_branch ?? 'main' };
}

/**
 * After a 422 create-repo failure (`name-conflict`), check whether the repo
 * already exists under the requested owner. Returns the existing repo's
 * `{cloneUrl, defaultBranch}` so the orchestrator can proceed to push, or
 * `null` if the conflict is with a repo we don't own (e.g. someone else
 * happens to hold the name). The caller decides whether to surface the
 * original `name-conflict` error or continue idempotently.
 */
async function tryFetchExistingRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<CreatedRepo | null> {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return { cloneUrl: data.clone_url, defaultBranch: data.default_branch ?? 'main' };
  } catch {
    return null;
  }
}

// ─── Owner-kind probe ────────────────────────────────────────────────────────

/**
 * Determine whether the chosen owner is the authenticated user or one of
 * their orgs. The wizard already passes this via the UI selection but we
 * also support direct CLI use where the kind is implicit — probe via
 * `users.getAuthenticated` and pick `user` when the logins match.
 */
async function probeOwnerKind(octokit: Octokit, ownerLogin: string): Promise<'user' | 'org'> {
  const me = await octokit.users.getAuthenticated();
  return me.data.login.toLowerCase() === ownerLogin.toLowerCase() ? 'user' : 'org';
}

// ─── simple-git plumbing ──────────────────────────────────────────────────────

type CredentialHelperUnsafeGitOptions = SimpleGitOptions & {
  unsafe?: NonNullable<SimpleGitOptions['unsafe']> & {
    allowUnsafeCredentialHelper?: boolean;
  };
};

/**
 * Build a simple-git instance bound to `projectDir`. We never set a
 * credential.helper on the persisted origin remote — the token-bearing URL
 * is passed inline only when invoking `git push`. The unsafe flag exists
 * because simple-git 3.36 gates credential.helper behind a runtime-only
 * option not exposed by its typings; setting it here keeps the API ready
 * for the (not-currently-used) gh delegation path.
 */
function makeGit(projectDir: string): SimpleGit {
  const opts: Partial<CredentialHelperUnsafeGitOptions> = {
    baseDir: projectDir,
    unsafe: { allowUnsafeCredentialHelper: true },
  };
  return simpleGit(opts as Partial<SimpleGitOptions>).env({ GIT_TERMINAL_PROMPT: '0' });
}

/**
 * Splice a GitHub token into an `https://github.com/<owner>/<repo>.git` URL
 * via the `x-access-token` convention. The result is used as the push target
 * exactly once; the persistent origin remote stays scrubbed.
 */
function injectTokenIntoCloneUrl(cloneUrl: string, token: string): string {
  // Anchor on the exact protocol prefix AND github.com host so a hypothetical
  // malformed cloneUrl can't smuggle the PAT to a different host. GitHub
  // always returns `https://github.com/...` on its REST API; defense-in-depth
  // makes the security contract explicit instead of trusting future callers.
  if (!cloneUrl.startsWith('https://')) return cloneUrl;
  try {
    if (new URL(cloneUrl).hostname !== 'github.com') return cloneUrl;
  } catch {
    return cloneUrl;
  }
  return cloneUrl.replace('https://', `https://x-access-token:${token}@`);
}

interface PublishGitDeps {
  /** Ensure `<projectDir>/.ok/` scaffold exists. Injected so tests can no-op. */
  ensureOkScaffold: (projectDir: string) => void;
  /** Build the simple-git instance. Injected so tests can stub. */
  gitFactory: (projectDir: string) => SimpleGit;
}

const DEFAULT_DEPS: PublishGitDeps = {
  ensureOkScaffold: (projectDir) => {
    initContent(projectDir);
  },
  gitFactory: makeGit,
};

// ─── Main orchestrator ────────────────────────────────────────────────────────

export interface PublishParams {
  octokit: Octokit;
  token: string;
  projectDir: string;
  body: {
    owner: string;
    name: string;
    visibility: 'public' | 'private';
    description?: string;
  };
  /** Optional override for testing. */
  ownerKind?: 'user' | 'org';
  deps?: Partial<PublishGitDeps>;
}

/**
 * Drive the full Publish flow. Pure-ish — all side effects (fs, git, Octokit)
 * flow through injected deps so unit/integration tests can substitute fakes.
 * The orchestrator's contract is: return a `PublishResult`, never throw on
 * documented failure modes. Unanticipated exceptions surface as `network`.
 */
export async function runPublishFlow(params: PublishParams): Promise<PublishResult> {
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const projectDir = resolve(params.projectDir);

  // Owner-kind: caller may pre-resolve via the wizard's owner picker; if
  // omitted, probe via `users.getAuthenticated`. Failure here is auth.
  let ownerKind: 'user' | 'org';
  if (params.ownerKind) {
    ownerKind = params.ownerKind;
  } else {
    try {
      ownerKind = await probeOwnerKind(params.octokit, params.body.owner);
    } catch (err) {
      return { kind: 'error', code: classifyOctokitError(err) };
    }
  }

  // 1. Ensure `.ok/` exists so the `.ok/.gitignore` from initContent's
  //    scaffold is staged BEFORE the initial commit lands. Any
  //    error here is `init-failed` (init is a local filesystem op, not a
  //    network one — the failure mode is distinct).
  try {
    deps.ensureOkScaffold(projectDir);
  } catch {
    return { kind: 'error', code: 'init-failed' };
  }

  // 2. `git init` if the project has no `.git/` yet.
  const git = deps.gitFactory(projectDir);
  const gitDir = join(projectDir, '.git');
  if (!existsSync(gitDir)) {
    try {
      await git.init();
    } catch {
      return { kind: 'error', code: 'init-failed' };
    }
  }

  // 3. Create the repo on GitHub. Idempotent on retry: if `create*` returns
  //    422 (name conflict), treat a repo that already exists under the
  //    requested owner as "create-step previously succeeded" and proceed
  //    to push. This handles the user-visible "Retry push" path after a
  //    transient push failure — without idempotency the retry would fail
  //    here with the same 422 → `name-conflict` → confusing "name already
  //    taken" toast instead of completing the retry.
  let created: CreatedRepo;
  try {
    created = await createGitHubRepo({
      octokit: params.octokit,
      ownerLogin: params.body.owner,
      ownerKind,
      name: params.body.name,
      visibility: params.body.visibility,
      description: params.body.description,
    });
  } catch (err) {
    if (classifyOctokitError(err) === 'name-conflict') {
      const existing = await tryFetchExistingRepo(
        params.octokit,
        params.body.owner,
        params.body.name,
      );
      if (existing === null) {
        // 422 but no repo at <owner>/<name> — somebody else's collision.
        return { kind: 'error', code: 'name-conflict' };
      }
      created = existing;
    } else {
      return { kind: 'error', code: classifyOctokitError(err) };
    }
  }

  // 4. addRemote('origin', <clean clone URL>). On a fresh `git init` this
  //    succeeds; on a retry after partial failure the origin may already
  //    be set — treat that as idempotent so the retry can reach push.
  try {
    await git.addRemote('origin', created.cloneUrl);
  } catch (err) {
    const remoteAlreadyExists = String((err as { message?: string }).message ?? '')
      .toLowerCase()
      .includes('remote origin already exists');
    if (!remoteAlreadyExists) {
      return { kind: 'error', code: 'push-failed' };
    }
  }

  // 5. Stage all + initial commit if no commits exist yet. `git log`
  //    fails on a repo with no commits; that's our signal to commit.
  let needsInitialCommit = false;
  try {
    await git.raw(['rev-parse', '--verify', 'HEAD']);
  } catch {
    needsInitialCommit = true;
  }
  if (needsInitialCommit) {
    try {
      await git.add('.');
      // Use `git commit` directly with --allow-empty so a no-content
      // project (just `.ok/` + `.gitignore`) still produces a commit.
      // Identity is sourced from git config or, in test/CI environments
      // where there's no global config, the GIT_AUTHOR_* env vars set
      // by the caller. The orchestrator does not own identity resolution.
      await git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);
    } catch {
      return { kind: 'error', code: 'init-failed' };
    }
  }

  // 6. Push using an inline token URL. We push to `HEAD:refs/heads/<default>`
  //    so the server-resolved default branch ends up populated. The token
  //    in the URL is visible to process listings only for the push duration
  //    — acceptable for v1 (token rotation is the mitigation, not redaction).
  //
  //    NOTE: pushing to an inline URL (not the `origin` remote name) means
  //    git does NOT update `refs/remotes/origin/<branch>` automatically.
  //    The `-u` flag is a no-op without a named remote. The share button's
  //    branch-on-origin check (`packages/server/src/share/git-context.ts`
  //    `branchExistsOnOrigin`) is local-only by contract — no `git
  //    ls-remote` — so we MUST manually update the remote-tracking ref
  //    after the push completes or every just-published project sees
  //    `branch-not-on-origin` on its first Share click.
  const authUrl = injectTokenIntoCloneUrl(created.cloneUrl, params.token);
  try {
    await git.raw(['push', authUrl, `HEAD:refs/heads/${created.defaultBranch}`]);
  } catch (err) {
    // GitHub's push response carries SSO redirect info in stderr when an
    // org enforces SSO. The CLI surfaces `saml-sso`; the wizard's
    // generic banner lets the user authorize manually. Other
    // failures (network drop, ref rejection) fall through to push-failed.
    const message = String((err as { message?: string }).message ?? '').toLowerCase();
    if (message.includes('saml') || message.includes('sso')) {
      return { kind: 'error', code: 'saml-sso' };
    }
    return { kind: 'error', code: 'push-failed' };
  }

  // 7. Sync the local `refs/remotes/origin/<branch>` ref to the just-pushed
  //    HEAD. `git push -u origin <branch>` would have done this implicitly,
  //    but we push to an inline URL (step 6) so we update the ref manually.
  //    Best-effort: a failure here doesn't undo the successful push, so
  //    we degrade silently — the user's next `git fetch` will populate it,
  //    or the very next manual Share click can fall through to the same
  //    `branch-not-on-origin` toast with the recovery hint.
  try {
    await git.raw(['update-ref', `refs/remotes/origin/${created.defaultBranch}`, 'HEAD']);
  } catch {
    /* best-effort — push already succeeded */
  }

  return {
    kind: 'ok',
    value: {
      ownerLogin: params.body.owner,
      repoName: params.body.name,
      cloneUrl: created.cloneUrl,
      defaultBranch: created.defaultBranch,
    },
  };
}

// ─── Commander wiring ─────────────────────────────────────────────────────────

function emitPublishEvent(json: boolean, result: PublishResult): void {
  if (!json) {
    if (result.kind === 'ok') {
      process.stdout.write(`✓ Published ${result.value.cloneUrl}\n`);
    } else {
      process.stderr.write(`✗ share publish failed: ${result.code}\n`);
      process.exit(1);
    }
    return;
  }
  if (result.kind === 'ok') {
    process.stdout.write(`${JSON.stringify({ type: 'publish', ...result.value })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ type: 'error', code: result.code })}\n`);
}

async function runSharePublish(opts: PublishOptions, tokenStore: TokenStore): Promise<void> {
  const { host, owner, name, visibility, description, projectDir, json } = opts;
  validateGitHubHost(host);
  const token = await resolveReposToken(host, tokenStore);
  if (token == null) {
    emitPublishEvent(json, { kind: 'error', code: 'auth-required' });
    return;
  }
  const baseUrl = host === 'github.com' ? undefined : `https://${host}/api/v3`;
  const octokit = new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });

  // Ensure git user.name/user.email are set before the initial commit so
  // simple-git's `commit` doesn't fail in CI/test environments. The wizard
  // running on a real user's machine inherits global git config; on a
  // pristine box we fall back to the OAuth profile via `git config user.*`.
  try {
    execSync('git config user.email', { cwd: projectDir, stdio: 'ignore' });
  } catch {
    process.env.GIT_AUTHOR_NAME ??= 'OpenKnowledge';
    process.env.GIT_AUTHOR_EMAIL ??= 'noreply@inkeep.com';
    process.env.GIT_COMMITTER_NAME ??= 'OpenKnowledge';
    process.env.GIT_COMMITTER_EMAIL ??= 'noreply@inkeep.com';
  }

  const result = await runPublishFlow({
    octokit,
    token,
    projectDir,
    body: { owner, name, visibility, description },
  });
  emitPublishEvent(json, result);
}

export function sharePublishCommand(getTokenStore: () => Promise<TokenStore>): Command {
  return new Command('publish')
    .description('Publish a no-remote project to GitHub')
    .requiredOption('--owner <owner>', 'GitHub owner (user or org)')
    .requiredOption('--name <name>', 'Repository name')
    .requiredOption('--visibility <visibility>', 'public or private')
    .option('--description <description>', 'Repository description')
    .requiredOption('--project-dir <projectDir>', 'Path to the project on disk')
    .option('--host <host>', 'GitHub or GitHub Enterprise hostname', 'github.com')
    .option('--json', 'Output JSON', false)
    .action(async (opts: PublishOptions) => {
      if (opts.visibility !== 'public' && opts.visibility !== 'private') {
        process.stderr.write(`✗ visibility must be 'public' or 'private'\n`);
        process.exit(1);
      }
      await runSharePublish(opts, await getTokenStore());
    });
}
