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

async function probeOwnerKind(octokit: Octokit, ownerLogin: string): Promise<'user' | 'org'> {
  const me = await octokit.users.getAuthenticated();
  return me.data.login.toLowerCase() === ownerLogin.toLowerCase() ? 'user' : 'org';
}

type CredentialHelperUnsafeGitOptions = SimpleGitOptions & {
  unsafe?: NonNullable<SimpleGitOptions['unsafe']> & {
    allowUnsafeCredentialHelper?: boolean;
  };
};

function makeGit(projectDir: string): SimpleGit {
  const opts: Partial<CredentialHelperUnsafeGitOptions> = {
    baseDir: projectDir,
    unsafe: { allowUnsafeCredentialHelper: true },
  };
  return simpleGit(opts as Partial<SimpleGitOptions>).env({ GIT_TERMINAL_PROMPT: '0' });
}

function injectTokenIntoCloneUrl(cloneUrl: string, token: string): string {
  if (!cloneUrl.startsWith('https://')) return cloneUrl;
  try {
    if (new URL(cloneUrl).hostname !== 'github.com') return cloneUrl;
  } catch {
    return cloneUrl;
  }
  return cloneUrl.replace('https://', `https://x-access-token:${token}@`);
}

interface PublishGitDeps {
  ensureOkScaffold: (projectDir: string) => void;
  gitFactory: (projectDir: string) => SimpleGit;
}

const DEFAULT_DEPS: PublishGitDeps = {
  ensureOkScaffold: (projectDir) => {
    initContent(projectDir);
  },
  gitFactory: makeGit,
};

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
  ownerKind?: 'user' | 'org';
  deps?: Partial<PublishGitDeps>;
}

export async function runPublishFlow(params: PublishParams): Promise<PublishResult> {
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const projectDir = resolve(params.projectDir);

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

  try {
    deps.ensureOkScaffold(projectDir);
  } catch {
    return { kind: 'error', code: 'init-failed' };
  }

  const git = deps.gitFactory(projectDir);
  const gitDir = join(projectDir, '.git');
  if (!existsSync(gitDir)) {
    try {
      await git.init();
    } catch {
      return { kind: 'error', code: 'init-failed' };
    }
  }

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
        return { kind: 'error', code: 'name-conflict' };
      }
      created = existing;
    } else {
      return { kind: 'error', code: classifyOctokitError(err) };
    }
  }

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

  let needsInitialCommit = false;
  try {
    await git.raw(['rev-parse', '--verify', 'HEAD']);
  } catch {
    needsInitialCommit = true;
  }
  if (needsInitialCommit) {
    try {
      await git.add('.');
      await git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);
    } catch {
      return { kind: 'error', code: 'init-failed' };
    }
  }

  const authUrl = injectTokenIntoCloneUrl(created.cloneUrl, params.token);
  try {
    await git.raw(['push', authUrl, `HEAD:refs/heads/${created.defaultBranch}`]);
  } catch (err) {
    const message = String((err as { message?: string }).message ?? '').toLowerCase();
    if (message.includes('saml') || message.includes('sso')) {
      return { kind: 'error', code: 'saml-sso' };
    }
    return { kind: 'error', code: 'push-failed' };
  }

  try {
    await git.raw(['update-ref', `refs/remotes/origin/${created.defaultBranch}`, 'HEAD']);
  } catch {}

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
