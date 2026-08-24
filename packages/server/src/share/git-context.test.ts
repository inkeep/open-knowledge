import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  branchExistsOnOrigin,
  originGitHubHost,
  parseGitHubOriginUrl,
  readGitHeadBranch,
  readOriginGitHubRepo,
  readSyncRemoteInfo,
  sameGitHubLogin,
  shouldResetAmbientCredentials,
} from './git-context.ts';

function seedRepo(
  root: string,
  spec: {
    head?: string;
    config?: string;
    branchRefs?: Record<string, string>;
    packedRefs?: string;
    gitDirAsFile?: { contents: string };
  } = {},
): void {
  if (spec.gitDirAsFile) {
    writeFileSync(join(root, '.git'), spec.gitDirAsFile.contents, 'utf-8');
    return;
  }
  const gitDir = join(root, '.git');
  mkdirSync(gitDir, { recursive: true });
  if (spec.head !== undefined) {
    writeFileSync(join(gitDir, 'HEAD'), spec.head, 'utf-8');
  }
  if (spec.config !== undefined) {
    writeFileSync(join(gitDir, 'config'), spec.config, 'utf-8');
  }
  if (spec.branchRefs) {
    const refDir = join(gitDir, 'refs', 'remotes', 'origin');
    mkdirSync(refDir, { recursive: true });
    for (const [branch, sha] of Object.entries(spec.branchRefs)) {
      const refPath = join(refDir, branch);
      mkdirSync(resolve(refPath, '..'), { recursive: true });
      writeFileSync(refPath, sha, 'utf-8');
    }
  }
  if (spec.packedRefs !== undefined) {
    writeFileSync(join(gitDir, 'packed-refs'), spec.packedRefs, 'utf-8');
  }
}

const CANONICAL_HEAD = 'ref: refs/heads/main\n';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const CANONICAL_CONFIG_HTTPS =
  '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';

describe('readGitHeadBranch', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-head-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns branch name for a normal symbolic-ref HEAD', () => {
    seedRepo(dir, { head: CANONICAL_HEAD });
    expect(readGitHeadBranch(dir)).toBe('main');
  });

  test('returns branch name with a slash for nested branches', () => {
    seedRepo(dir, { head: 'ref: refs/heads/feat/sharing-virality-flow\n' });
    expect(readGitHeadBranch(dir)).toBe('feat/sharing-virality-flow');
  });

  test('returns null for a detached HEAD (raw SHA)', () => {
    seedRepo(dir, { head: '0123456789abcdef0123456789abcdef01234567\n' });
    expect(readGitHeadBranch(dir)).toBeNull();
  });

  test('returns null when the project has no .git directory', () => {
    expect(readGitHeadBranch(dir)).toBeNull();
  });

  test('returns null when .git/HEAD is missing', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(readGitHeadBranch(dir)).toBeNull();
  });

  test('reads through a worktree pointer file', () => {
    const realGitDir = mkdtempSync(join(tmpdir(), 'share-git-real-'));
    writeFileSync(join(realGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n', 'utf-8');
    seedRepo(dir, { gitDirAsFile: { contents: `gitdir: ${realGitDir}\n` } });
    expect(readGitHeadBranch(dir)).toBe('feature-x');
    rmSync(realGitDir, { recursive: true, force: true });
  });

  test('returns null when .git is an unreadable file (malformed worktree pointer)', () => {
    seedRepo(dir, { gitDirAsFile: { contents: 'not a worktree pointer\n' } });
    expect(readGitHeadBranch(dir)).toBeNull();
  });
});

describe('readOriginGitHubRepo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-origin-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('parses HTTPS github.com origin URL', () => {
    seedRepo(dir, { config: CANONICAL_CONFIG_HTTPS });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });

  // The origin read deliberately omits the URL-declared login — identity
  // decisions go through the `github-account.ts` resolvers — so the account
  // is asserted on the parser and the origin result is pinned login-free.
  test('the parser surfaces an https userinfo account; the origin read stays login-free', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://alice@github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
    expect(parseGitHubOriginUrl('https://alice@github.com/inkeep/open-knowledge.git')).toEqual({
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
      login: 'alice',
    });
  });

  test('parses SSH SCP-style github.com origin URL', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'ssh',
    });
  });

  test('parses ssh:// github.com origin URL', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = ssh://git@github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'ssh',
    });
  });

  test('surfaces the account declared in an ssh:// origin userinfo', () => {
    expect(parseGitHubOriginUrl('ssh://alice@github.com/inkeep/open-knowledge.git')).toEqual({
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'ssh',
      login: 'alice',
    });
  });

  test('surfaces the account declared in an scp-style origin userinfo', () => {
    expect(parseGitHubOriginUrl('alice@github.com:inkeep/open-knowledge.git')).toEqual({
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'ssh',
      login: 'alice',
    });
  });

  // `git@` is the SSH transport's conventional placeholder, not an account, so
  // reading it as one would send every SSH clone chasing a `git` GitHub user.
  // `git` is also a reserved name on GitHub, so the same holds on https.
  test('treats the literal git userinfo as absent on every transport', () => {
    for (const url of [
      'git@github.com:inkeep/open-knowledge.git',
      'ssh://git@github.com/inkeep/open-knowledge.git',
      'https://git@github.com/inkeep/open-knowledge.git',
    ]) {
      const parsed = parseGitHubOriginUrl(url);
      expect(parsed).toMatchObject({ host: 'github.com' });
      expect(parsed).not.toHaveProperty('login');
    }
  });

  test('percent-decodes an encoded login before validating it', () => {
    expect(
      parseGitHubOriginUrl('https://alice%2Dcontoso@github.com/inkeep/open-knowledge.git'),
    ).toMatchObject({ login: 'alice-contoso' });
  });

  // GCM documents `alice%40contoso.com@host` for forges whose logins are
  // emails, but no GitHub login can contain `@` or `.` — the decoded form
  // fails the login grammar and reads as no declaration rather than becoming
  // a value gh could never serve.
  test('an email-shaped decoded userinfo is not a GitHub login', () => {
    const parsed = parseGitHubOriginUrl(
      'https://alice%40contoso.com@github.com/inkeep/open-knowledge.git',
    );
    expect(parsed).toMatchObject({ host: 'github.com' });
    expect(parsed).not.toHaveProperty('login');
  });

  test('a malformed percent escape fails the login grammar and reads as absent', () => {
    const parsed = parseGitHubOriginUrl('https://ali%zz@github.com/inkeep/open-knowledge.git');
    expect(parsed).toMatchObject({ host: 'github.com' });
    expect(parsed).not.toHaveProperty('login');
  });

  // GitHub's canonical PAT-in-URL form puts the token in the USERNAME half
  // (`https://ghp_…@github.com/o/r`). Reading it as an account would echo the
  // credential into `gh auth token --user` argv, warn-log fields, the
  // sync-status wire, and the sync popover — on every resolution, since the
  // `--user` lookup can never succeed for it.
  test('a token-shaped username is never an account', () => {
    const cases = [
      `https://ghp_${'a'.repeat(36)}@github.com/inkeep/open-knowledge.git`,
      `https://gho_${'b'.repeat(36)}@github.com/inkeep/open-knowledge.git`,
      `https://ghs_${'c'.repeat(36)}@github.com/inkeep/open-knowledge.git`,
      `https://github_pat_${'d'.repeat(70)}@github.com/inkeep/open-knowledge.git`,
    ];
    for (const url of cases) {
      const parsed = parseGitHubOriginUrl(url);
      expect(parsed).toMatchObject({ host: 'github.com' });
      expect(parsed).not.toHaveProperty('login');
    }
  });

  // The Actions/App convention (`x-access-token:<token>@`) and its cousins
  // name the auth scheme, not an account — OK's own publish path mints the
  // x-access-token form.
  test('token-auth placeholder usernames are never accounts', () => {
    for (const user of ['x-access-token', 'x-oauth-basic', 'oauth2', 'token']) {
      const parsed = parseGitHubOriginUrl(
        `https://${user}:tok123@github.com/inkeep/open-knowledge.git`,
      );
      expect(parsed).toMatchObject({ host: 'github.com' });
      expect(parsed).not.toHaveProperty('login');
    }
  });

  // Enterprise Managed User logins carry an underscore + enterprise
  // shortcode; the grammar must admit them or EMU users lose the whole
  // feature.
  test('an EMU-style login with an underscore is a valid account', () => {
    expect(
      parseGitHubOriginUrl('https://mona_acme@github.com/inkeep/open-knowledge.git'),
    ).toMatchObject({ login: 'mona_acme' });
  });

  // 39 chars is GitHub's login ceiling; every current token format is ≥40
  // chars, so length alone keeps arbitrary secrets out even when they avoid
  // the known prefixes.
  test('a 40-char opaque string is rejected by the login length cap', () => {
    const parsed = parseGitHubOriginUrl(
      `https://${'s'.repeat(40)}@github.com/inkeep/open-knowledge.git`,
    );
    expect(parsed).toMatchObject({ host: 'github.com' });
    expect(parsed).not.toHaveProperty('login');
  });

  test('returns ok when repo URL omits the .git suffix', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });

  test('returns non-github for gitlab origin URL', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@gitlab.com:inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'non-github' });
  });

  test('presumes an unknown host is a GitHub Enterprise host', () => {
    // GHES hostnames are arbitrary, so unknown hosts classify as GitHub with
    // the host carried in the result. A self-hosted non-GitHub forge on a
    // custom domain is indistinguishable and lands here too — downstream
    // consumers degrade gracefully for it.
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'ghes.acme.test',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });

  test('parses scp-style GHES origin and carries the host', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.corp.example.com:team/kb.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.corp.example.com',
      owner: 'team',
      repo: 'kb',
      transport: 'ssh',
    });
  });

  test('strips a non-standard port from a GHES host', () => {
    // Downstream consumers (`gh auth token --hostname`, the `/api/v3` probe
    // base) address the host by name; a retained `:8443` would break both.
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test:8443/acme/kb.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'ghes.acme.test',
      owner: 'acme',
      repo: 'kb',
      transport: 'https',
    });
  });

  test('parses the git:// protocol form', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git://github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'git',
    });
  });

  test('normalizes host casing, port, and www-folding', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://WWW.GitHub.com:443/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });

  test('ssh:// origin with a port carries transport ssh and a port-stripped host', () => {
    // The exact shape of the local-forge repro: `ssh://git@localhost:2222/...`
    // against a self-hosted Gitea. Must classify as ssh so the anonymous
    // probe abstains instead of pausing sync.
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = ssh://git@git.acme.test:2222/acme/kb.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'git.acme.test',
      owner: 'acme',
      repo: 'kb',
      transport: 'ssh',
    });
  });

  test('returns no-remote when [remote "origin"] section is absent', () => {
    seedRepo(dir, { config: '[core]\n\trepositoryformatversion = 0\n' });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('returns no-remote when origin section exists but has no url', () => {
    seedRepo(dir, { config: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('returns no-remote when .git/config is missing', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('returns no-remote when the project has no .git at all', () => {
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'no-remote' });
  });

  test('treats unparseable origin url as non-github (defensive — origin field present but malformed)', () => {
    seedRepo(dir, { config: '[remote "origin"]\n\turl = totally-bogus\n' });
    expect(readOriginGitHubRepo(dir)).toEqual({ kind: 'non-github' });
  });

  test('credential-embedded https URL keeps the username as the login and drops the password', () => {
    const url = 'https://user:pass@ghes.corp.example/org/repo.git';
    const parsed = parseGitHubOriginUrl(url);
    expect(parsed).toEqual({
      host: 'ghes.corp.example',
      owner: 'org',
      repo: 'repo',
      transport: 'https',
      login: 'user',
    });
    // The password must not survive the parse in any field — it would reach
    // logs and UI labels from here.
    expect(JSON.stringify(parsed)).not.toContain('pass');
    // The origin read of the same URL stays login-free.
    seedRepo(dir, { config: `[remote "origin"]\n\turl = ${url}\n` });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'ghes.corp.example',
      owner: 'org',
      repo: 'repo',
      transport: 'https',
    });
  });

  test('uses the first url= line and ignores subsequent ones', () => {
    seedRepo(dir, {
      config:
        '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n\turl = https://gitlab.com/x/y.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });

  test('ignores url lines from other remote sections', () => {
    seedRepo(dir, {
      config:
        '[remote "upstream"]\n\turl = https://github.com/upstream/foo.git\n[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
    });
    expect(readOriginGitHubRepo(dir)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });
});

describe('originGitHubHost', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-host-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns github.com for a github.com origin', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
    });
    expect(originGitHubHost(dir)).toBe('github.com');
  });

  test('returns the enterprise host for a GHES origin', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/acme/kb.git\n',
    });
    expect(originGitHubHost(dir)).toBe('ghes.acme.test');
  });

  test('falls back to github.com for a known non-GitHub forge', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@gitlab.com:team/notes.git\n',
    });
    expect(originGitHubHost(dir)).toBe('github.com');
  });

  test('falls back to github.com when there is no .git at all', () => {
    expect(originGitHubHost(dir)).toBe('github.com');
  });
});

describe('shouldResetAmbientCredentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-reset-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('github.com origin resets — OK can supply a credential there', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://github.com/inkeep/open-knowledge.git\n',
    });
    expect(shouldResetAmbientCredentials(dir)).toBe(true);
  });

  test('GHES origin resets — sign-in accepts unknown hosts as enterprise', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/acme/kb.git\n',
    });
    expect(shouldResetAmbientCredentials(dir)).toBe(true);
  });

  // The reset follows the HOST, not the transport. An SSH clone still runs
  // HTTPS sub-operations that consult credential helpers, so a transport
  // conditional here would silently strand them; the HTTPS cases above cannot
  // catch that on their own.
  test('github.com SSH origin resets — the decision is host-scoped', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
    });
    expect(shouldResetAmbientCredentials(dir)).toBe(true);
  });

  // The regression this guards: clearing the chain for a forge OK cannot
  // authenticate strands the user with no credential and no in-app recovery,
  // because signing in only ever yields a GitHub token.
  test('gitlab origin does NOT reset — its ambient credential is the only one', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://gitlab.com/team/notes.git\n',
    });
    expect(shouldResetAmbientCredentials(dir)).toBe(false);
  });

  test('bitbucket origin does NOT reset', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@bitbucket.org:team/notes.git\n',
    });
    expect(shouldResetAmbientCredentials(dir)).toBe(false);
  });

  // A userinfo origin used to fall out of the parser as `non-github` and so
  // kept its inherited chain. That was an accident of the grammar, not a
  // policy: the host is still GitHub and OK can still issue a credential for
  // it, which is the only question this gate asks.
  test('https origin with userinfo resets — the host is what decides', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://alice@github.com/inkeep/open-knowledge.git\n',
    });
    expect(shouldResetAmbientCredentials(dir)).toBe(true);
  });

  test('no remote resets — nothing ambient to preserve, sync is dormant anyway', () => {
    expect(shouldResetAmbientCredentials(dir)).toBe(true);
  });
});

describe('branchExistsOnOrigin', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-branch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns true when a loose ref exists', () => {
    seedRepo(dir, { branchRefs: { main: `${OID_A}\n` } });
    expect(branchExistsOnOrigin(dir, 'main')).toBe(true);
  });

  test('returns false when no ref file exists', () => {
    seedRepo(dir, { branchRefs: { main: `${OID_A}\n` } });
    expect(branchExistsOnOrigin(dir, 'feature-x')).toBe(false);
  });

  test('returns true for a packed-refs entry', () => {
    seedRepo(dir, {
      packedRefs: `# pack-refs with: peeled fully-peeled sorted\n${OID_A} refs/remotes/origin/main\n${OID_B} refs/remotes/origin/develop\n`,
    });
    expect(branchExistsOnOrigin(dir, 'develop')).toBe(true);
  });

  test('returns false for an absent packed-refs entry', () => {
    seedRepo(dir, {
      packedRefs: `# pack-refs with: peeled fully-peeled sorted\n${OID_A} refs/remotes/origin/main\n`,
    });
    expect(branchExistsOnOrigin(dir, 'feature-x')).toBe(false);
  });

  test('returns true when the branch is loose AND packed (loose wins)', () => {
    seedRepo(dir, {
      branchRefs: { main: `${OID_A}\n` },
      packedRefs: `# pack-refs with: peeled fully-peeled sorted\n${OID_B} refs/remotes/origin/main\n`,
    });
    expect(branchExistsOnOrigin(dir, 'main')).toBe(true);
  });

  test('returns false when no .git at all', () => {
    expect(branchExistsOnOrigin(dir, 'main')).toBe(false);
  });

  test('handles branches with slashes in loose-ref form', () => {
    seedRepo(dir, { branchRefs: { 'feat/sharing': `${OID_A}\n` } });
    expect(branchExistsOnOrigin(dir, 'feat/sharing')).toBe(true);
  });

  test('handles branches with slashes via packed-refs', () => {
    seedRepo(dir, {
      packedRefs: `${OID_A} refs/remotes/origin/feat/sharing-virality-flow\n`,
    });
    expect(branchExistsOnOrigin(dir, 'feat/sharing-virality-flow')).toBe(true);
  });
});

describe('readSyncRemoteInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-git-remote-info-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('GitHub https origin yields owner/repo label + browsable webUrl', () => {
    seedRepo(dir, { config: CANONICAL_CONFIG_HTTPS });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'inkeep/open-knowledge',
      webUrl: 'https://github.com/inkeep/open-knowledge',
    });
  });

  test('GitHub scp-style ssh origin yields the same github webUrl', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = git@github.com:inkeep/open-knowledge.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'inkeep/open-knowledge',
      webUrl: 'https://github.com/inkeep/open-knowledge',
    });
  });

  test('GHES origin yields a host-qualified label and a browsable webUrl', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://ghes.acme.test/team/notes.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'ghes.acme.test/team/notes',
      webUrl: 'https://ghes.acme.test/team/notes',
    });
  });

  // Credential-bearing URLs reach the GitHub branch now that the parser
  // accepts userinfo, so the browse URL is rebuilt from the normalized host —
  // a passthrough would publish the password into a clickable link.
  test('GitHub-host origin with embedded credentials builds a webUrl carrying neither', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://user:pass@ghes.corp.example/org/repo.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'ghes.corp.example/org/repo',
      webUrl: 'https://ghes.corp.example/org/repo',
    });
  });

  test('known non-github forge yields a readable label and a null webUrl (no link)', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://gitlab.com/team/notes.git\n',
    });
    expect(readSyncRemoteInfo(dir)).toEqual({
      label: 'gitlab.com/team/notes',
      webUrl: null,
    });
  });

  test('non-github scp-style ssh origin strips credentials into host/path label', () => {
    seedRepo(dir, { config: '[remote "origin"]\n\turl = git@gitlab.com:team/notes.git\n' });
    expect(readSyncRemoteInfo(dir)).toEqual({ label: 'gitlab.com/team/notes', webUrl: null });
  });

  test('non-github https origin with embedded credentials (incl. @ in password) leaks none', () => {
    seedRepo(dir, {
      config: '[remote "origin"]\n\turl = https://user:p@ss@gitlab.com/org/repo.git\n',
    });
    // The `@`-in-password segment must be fully consumed — no `ss@gitlab...` leak.
    expect(readSyncRemoteInfo(dir)).toEqual({ label: 'gitlab.com/org/repo', webUrl: null });
  });

  test('returns null when no origin url is configured', () => {
    seedRepo(dir, { config: '[core]\n\tbare = false\n' });
    expect(readSyncRemoteInfo(dir)).toBeNull();
  });

  test('returns null when the project has no .git at all', () => {
    expect(readSyncRemoteInfo(dir)).toBeNull();
  });
});

describe('linked-worktree common-dir resolution', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'share-git-worktree-'));
    // Common (main) git dir: holds config + remote-tracking refs — NOT the
    // per-worktree git dir.
    const commonDir = join(root, 'main-git');
    mkdirSync(commonDir, { recursive: true });
    writeFileSync(join(commonDir, 'config'), CANONICAL_CONFIG_HTTPS, 'utf-8');
    const refDir = join(commonDir, 'refs', 'remotes', 'origin');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'feat-bar'), `${OID_A}\n`, 'utf-8');
    // Linked-worktree git dir: per-worktree HEAD + a relative `commondir`
    // pointer, exactly as git writes it (`.git/worktrees/<name>/commondir`).
    const worktreeGitDir = join(commonDir, 'worktrees', 'wt');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feat-bar\n', 'utf-8');
    writeFileSync(
      join(worktreeGitDir, 'commondir'),
      `${relative(worktreeGitDir, commonDir)}\n`,
      'utf-8',
    );
    // The worktree checkout: its `.git` is a file pointing at the worktree dir.
    project = join(root, 'wt-checkout');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('reads origin config via commondir (regression: worktree reported no-remote)', () => {
    expect(readOriginGitHubRepo(project)).toEqual({
      kind: 'ok',
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      transport: 'https',
    });
  });

  test('readSyncRemoteInfo resolves the common-dir origin for a worktree', () => {
    expect(readSyncRemoteInfo(project)).toEqual({
      label: 'inkeep/open-knowledge',
      webUrl: 'https://github.com/inkeep/open-knowledge',
    });
  });

  test('branchExistsOnOrigin reads remote-tracking refs from the common dir', () => {
    expect(branchExistsOnOrigin(project, 'feat-bar')).toBe(true);
    expect(branchExistsOnOrigin(project, 'nope')).toBe(false);
  });

  test('HEAD still resolves from the per-worktree git dir, not the common dir', () => {
    expect(readGitHeadBranch(project)).toBe('feat-bar');
  });
});

describe('sameGitHubLogin', () => {
  // GitHub logins are unique case-insensitively, so a casing difference is the
  // same person — treating it as a mismatch would report a declared-account
  // miss for a correctly-configured remote.
  test('a casing difference is the same account', () => {
    expect(sameGitHubLogin('Alice', 'alice')).toBe(true);
    expect(sameGitHubLogin('alice', 'ALICE')).toBe(true);
    expect(sameGitHubLogin('alice', 'alice')).toBe(true);
  });

  test('different accounts are not the same', () => {
    expect(sameGitHubLogin('alice', 'bob')).toBe(false);
  });

  // An unattributed credential is never "the same account" as a named one —
  // the absent side must not read as a match and suppress a real miss.
  test('an absent side is never a match', () => {
    expect(sameGitHubLogin('alice', undefined)).toBe(false);
    expect(sameGitHubLogin(undefined, 'alice')).toBe(false);
    expect(sameGitHubLogin(undefined, undefined)).toBe(false);
  });
});
