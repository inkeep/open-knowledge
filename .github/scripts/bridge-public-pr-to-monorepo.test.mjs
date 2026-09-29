import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import * as bridge from './bridge-public-pr-to-monorepo.mjs';
import {
  applyPatchWithConflictDetection,
  bridgeCommitSubject,
  buildCommitAttribution,
  buildWelcomePublicComment,
  checkOrgMembership,
  commitIndicatesConflicts,
  createClaGateGh,
  listPublicPrCommits,
  normalizeGitHubUserAuthor,
  postCommitStatus,
  readCommitClaStatus,
  syncPublicPr,
} from './bridge-public-pr-to-monorepo.mjs';

const fakeRequest = (response) => {
  const calls = [];
  const request = async (args) => {
    calls.push(args);
    return response;
  };
  return { request, calls };
};

describe('buildCommitAttribution', () => {
  test('credits every unique contributor with native coauthor trailers', () => {
    const attribution = buildCommitAttribution({
      commitAuthors: [
        { name: 'Sarah Inkeep', email: 'sarah@inkeep.com' },
        {
          name: 'github-actions[bot]',
          email: '41898282+github-actions[bot]@users.noreply.github.com',
        },
        { name: 'Sarah Inkeep', email: 'sarah@inkeep.com' },
        { name: 'Robert Inkeep', email: 'robert@inkeep.com' },
      ],
    });

    expect(attribution.trailers).toEqual([
      'Co-authored-by: Sarah Inkeep <sarah@inkeep.com>',
      'Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
      'Co-authored-by: Robert Inkeep <robert@inkeep.com>',
    ]);
  });

  test('lists commits for readability and builds a deduped GitHub attribution block', () => {
    const attribution = buildCommitAttribution({
      commitAuthors: [{ name: 'octocat', email: '1+octocat@users.noreply.github.com' }],
      commitMessages: [
        {
          sha: '1234567890abcdef',
          author: { name: 'Sarah Inkeep', email: 'sarah@inkeep.com' },
          message: 'Add search\n\nExplain the indexing path.',
        },
        {
          sha: 'fedcba9876543210',
          author: { name: 'Robert Inkeep', email: 'robert@inkeep.com' },
          message: 'Fix empty query\r\n\r\nCo-authored-by: A <a@example.com>',
        },
      ],
      publicRepo: 'inkeep/open-knowledge',
    });

    expect(attribution.originalCommitMessages).toBe(
      [
        'Commits:',
        '',
        '[1234567](https://github.com/inkeep/open-knowledge/commit/1234567890abcdef)',
        'Author: Sarah Inkeep <sarah@inkeep.com>',
        '',
        'Add search',
        '',
        'Explain the indexing path.',
        '',
        '[fedcba9](https://github.com/inkeep/open-knowledge/commit/fedcba9876543210)',
        'Author: Robert Inkeep <robert@inkeep.com>',
        '',
        'Fix empty query',
        '',
        'Co-authored-by: A <a@example.com>',
      ].join('\n'),
    );
    expect(attribution.trailers).toEqual([
      'Co-authored-by: octocat <1+octocat@users.noreply.github.com>',
      'Co-authored-by: Sarah Inkeep <sarah@inkeep.com>',
      'Co-authored-by: Robert Inkeep <robert@inkeep.com>',
      'Co-authored-by: A <a@example.com>',
    ]);
  });

  test('allows an empty attribution block when no author normalizes', () => {
    const attribution = buildCommitAttribution({
      commitAuthors: [{ name: 'Bad\nName', email: 'bad@x.com' }],
      commitMessages: [],
    });

    expect(attribution.trailers).toEqual([]);
    expect(attribution.body).toBe('');
  });
});

describe('bridgeCommitSubject', () => {
  test('includes the original public PR title while keeping the sync prefix', () => {
    expect(
      bridgeCommitSubject({
        publicRepo: 'inkeep/open-knowledge',
        publicPr: { number: 361, title: 'Preserve contributor commit messages' },
        hasConflicts: false,
      }),
    ).toBe('sync(oss): mirror inkeep/open-knowledge#361: Preserve contributor commit messages');
  });

  test('normalizes multiline titles and preserves the conflict marker', () => {
    expect(
      bridgeCommitSubject({
        publicRepo: 'inkeep/open-knowledge',
        publicPr: { number: 361, title: 'Fix bridge\n\nsubject' },
        hasConflicts: true,
      }),
    ).toBe(
      'sync(oss): mirror inkeep/open-knowledge#361: Fix bridge subject (with conflicts; needs manual resolution)',
    );
  });
});

describe('listPublicPrCommits', () => {
  test('returns public PR commit authors and messages', async () => {
    const { request } = fakeRequest([
      {
        sha: 'abcdef1234567890',
        author: { login: 'linked-author', id: 7 },
        commit: {
          author: { name: 'Raw Author', email: 'raw@example.com' },
          message: 'Add bridge attribution\n\nKeep the public commit message.',
        },
      },
    ]);

    await expect(
      listPublicPrCommits({
        token: 't',
        repo: 'owner/repo',
        prNumber: 123,
        request,
      }),
    ).resolves.toEqual([
      {
        sha: 'abcdef1234567890',
        author: { name: 'linked-author', email: '7+linked-author@users.noreply.github.com' },
        message: 'Add bridge attribution\n\nKeep the public commit message.',
      },
    ]);
  });

  test('paginates until a page returns fewer than 100 commits', async () => {
    const calls = [];
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      sha: `${index.toString(16).padStart(7, '0')}abcdef`,
      author: { login: `author-${index}`, id: index + 1 },
      commit: {
        author: { name: `Raw Author ${index}`, email: `raw-${index}@example.com` },
        message: `Commit ${index}`,
      },
    }));
    const pageTwo = [
      {
        sha: 'feedbee',
        author: { login: 'last-author', id: 101 },
        commit: {
          author: { name: 'Raw Last', email: 'raw-last@example.com' },
          message: 'Commit 100',
        },
      },
    ];
    const request = async (args) => {
      calls.push(args);
      return calls.length === 1 ? pageOne : pageTwo;
    };

    const commits = await listPublicPrCommits({
      token: 't',
      repo: 'owner/repo',
      prNumber: 123,
      request,
    });

    expect(commits).toHaveLength(101);
    expect(commits[0]).toEqual({
      sha: '0000000abcdef',
      author: { name: 'author-0', email: '1+author-0@users.noreply.github.com' },
      message: 'Commit 0',
    });
    expect(commits.at(-1)).toEqual({
      sha: 'feedbee',
      author: { name: 'last-author', email: '101+last-author@users.noreply.github.com' },
      message: 'Commit 100',
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/repos/owner/repo/pulls/123/commits?per_page=100&page=1',
      '/repos/owner/repo/pulls/123/commits?per_page=100&page=2',
    ]);
  });
});

describe('normalizeGitHubUserAuthor', () => {
  test('uses the GitHub-resolved user id/login noreply identity', () => {
    expect(normalizeGitHubUserAuthor({ login: 'rtran9', id: 11001605 })).toEqual({
      name: 'rtran9',
      email: '11001605+rtran9@users.noreply.github.com',
    });
  });

  test('ignores unresolved users but preserves bots as valid contributors', () => {
    expect(normalizeGitHubUserAuthor(null)).toBeNull();
    expect(normalizeGitHubUserAuthor({ login: 'github-actions[bot]', id: 41898282 })).toEqual({
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
    });
  });
});

describe('readCommitClaStatus', () => {
  test('extracts the license/cla state from the combined status', async () => {
    const { request } = fakeRequest({
      statuses: [
        { context: 'ci/build', state: 'success' },
        { context: 'license/cla', state: 'success' },
      ],
    });
    expect(await readCommitClaStatus({ token: 't', repo: 'o/r', sha: 'abc', request })).toBe(
      'success',
    );
  });

  test('returns null when the license/cla context is absent', async () => {
    const { request } = fakeRequest({ statuses: [{ context: 'ci/build', state: 'failure' }] });
    expect(await readCommitClaStatus({ token: 't', repo: 'o/r', sha: 'abc', request })).toBeNull();
  });

  test('returns null for an empty status set', async () => {
    const { request } = fakeRequest({ statuses: [] });
    expect(await readCommitClaStatus({ token: 't', repo: 'o/r', sha: 'abc', request })).toBeNull();
  });

  test("requests the combined status with per_page=100 so license/cla can't fall off page 1", async () => {
    const { request, calls } = fakeRequest({ statuses: [] });
    await readCommitClaStatus({ token: 't', repo: 'owner/repo', sha: 'deadbeef', request });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/repos/owner/repo/commits/deadbeef/status?per_page=100');
  });
});

describe('postCommitStatus', () => {
  test("POSTs the given state/context/description to the commit's statuses endpoint", async () => {
    const { request, calls } = fakeRequest(undefined);
    await postCommitStatus({
      token: 't',
      repo: 'owner/repo',
      sha: 'abc123',
      state: 'failure',
      context: 'cla/verified',
      description: 'held',
      request,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/owner/repo/statuses/abc123',
      body: { state: 'failure', context: 'cla/verified', description: 'held' },
    });
  });
});

describe('checkOrgMembership', () => {
  test('returns true on a 204 (member)', async () => {
    const { request, calls } = fakeRequest(null);
    expect(await checkOrgMembership({ token: 't', org: 'inkeep', login: 'octocat', request })).toBe(
      true,
    );
    expect(calls[0].path).toBe('/orgs/inkeep/members/octocat');
  });

  test('returns false on a 404 (non-member)', async () => {
    const request = async () => {
      const error = new Error('not found (404)');
      error.status = 404;
      throw error;
    };
    expect(
      await checkOrgMembership({ token: 't', org: 'inkeep', login: 'outsider', request }),
    ).toBe(false);
  });

  test('propagates non-404 errors so the gate fails closed', async () => {
    const request = async () => {
      const error = new Error('forbidden (403)');
      error.status = 403;
      throw error;
    };
    await expect(
      checkOrgMembership({ token: 't', org: 'inkeep', login: 'x', request }),
    ).rejects.toThrow(/403/);
  });
});

describe('createClaGateGh', () => {
  const deps = {
    publicToken: 'public-token',
    publicRepo: 'inkeep/open-knowledge',
    internalToken: 'internal-token',
    internalRepo: 'inkeep/agents-private',
  };

  test('readClaStatus reads license/cla from the public PR head, on the public token', async () => {
    const { request, calls } = fakeRequest({
      statuses: [{ context: 'license/cla', state: 'pending' }],
    });
    const gh = createClaGateGh({ ...deps, request });
    const state = await gh.readClaStatus({ head: { sha: 'public-head' } });
    expect(state).toBe('pending');
    expect(calls[0].token).toBe('public-token');
    expect(calls[0].path).toBe(
      '/repos/inkeep/open-knowledge/commits/public-head/status?per_page=100',
    );
  });

  test('setVerifiedStatus posts the cla/verified context to the internal PR head', async () => {
    const { request, calls } = fakeRequest(undefined);
    const gh = createClaGateGh({ ...deps, request });
    await gh.setVerifiedStatus({ head: { sha: 'internal-head' } }, 'failure', 'needs signature');
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe('internal-token');
    expect(calls[0].path).toBe('/repos/inkeep/agents-private/statuses/internal-head');
    expect(calls[0].body).toEqual({
      state: 'failure',
      context: 'cla/verified',
      description: 'needs signature',
    });
  });

  test("isOrgMember checks the internal repo's org on the internal token", async () => {
    const { request, calls } = fakeRequest(null);
    const gh = createClaGateGh({ ...deps, request });
    expect(await gh.isOrgMember('octocat')).toBe(true);
    expect(calls[0].token).toBe('internal-token');
    expect(calls[0].path).toBe('/orgs/inkeep/members/octocat');
  });
});

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitCleanEnv() }).trim();

function setupBridgeRepo({ baseContent, oursContent, theirsContent }) {
  const root = mkdtempSync(path.join(tmpdir(), 'bridge-canary-'));
  const repoDir = path.join(root, 'repo');
  mkdirSync(repoDir);
  git(repoDir, 'init', '-q');
  git(repoDir, 'config', 'user.email', 'canary@test.local');
  git(repoDir, 'config', 'user.name', 'canary');
  writeFileSync(path.join(repoDir, 'f.ts'), baseContent);
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-qm', 'base');
  const base = git(repoDir, 'rev-parse', 'HEAD');
  const defaultBranch = git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(repoDir, 'checkout', '-q', '-b', 'contributor');
  writeFileSync(path.join(repoDir, 'f.ts'), theirsContent);
  git(repoDir, 'commit', '-qam', 'contributor change');
  const patch = git(repoDir, 'diff', base, 'HEAD');
  const patchFile = path.join(root, 'contributor.patch');
  writeFileSync(patchFile, `${patch}\n`);
  git(repoDir, 'checkout', '-q', defaultBranch);
  writeFileSync(path.join(repoDir, 'f.ts'), oursContent);
  git(repoDir, 'commit', '-qam', 'internal (comment-rich)');
  return {
    repoDir,
    patchFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const STRIPPED_BASE = 'export const A = 1;\nexport const B = 2;\nexport const C = 3;\n';

describe('applyPatchWithConflictDetection (graceful conflict routing canary)', () => {
  test("a comment-adjacency 3-way conflict is classified 'conflicts', not a hard failure", () => {
    const { repoDir, patchFile, cleanup } = setupBridgeRepo({
      baseContent: STRIPPED_BASE,
      theirsContent: 'export const A = 1;\nexport const B = 22;\nexport const C = 3;\n',
      oursContent:
        'export const A = 1;\nexport const B = 2; // important constant (mirror strips this)\nexport const C = 3;\n',
    });
    try {
      const result = applyPatchWithConflictDetection(repoDir, patchFile);
      expect(result.outcome).toBe('conflicts');
      expect(result.conflictedPaths).toContain('f.ts');
    } finally {
      cleanup();
    }
  });

  test("a divergence far from the contributor's edit applies 'clean'", () => {
    const longBase =
      'export const A = 1;\nexport const B = 2;\n' +
      'const p = 0;\nconst q = 0;\nconst r = 0;\nconst s = 0;\nconst u = 0;\nconst v = 0;\n' +
      'export const C = 3;\n';
    const { repoDir, patchFile, cleanup } = setupBridgeRepo({
      baseContent: longBase,
      theirsContent: longBase.replace('export const B = 2;', 'export const B = 22;'),
      oursContent: longBase.replace(
        'export const C = 3;',
        'export const C = 3; // note on C (mirror strips this)',
      ),
    });
    try {
      const result = applyPatchWithConflictDetection(repoDir, patchFile);
      expect(result.outcome).toBe('clean');
      expect(result.conflictedPaths).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("a genuinely un-appliable patch stays 'failed' (fail-closed, not swallowed)", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bridge-canary-failed-'));
    const repoDir = path.join(root, 'repo');
    mkdirSync(repoDir);
    git(repoDir, 'init', '-q');
    git(repoDir, 'config', 'user.email', 'canary@test.local');
    git(repoDir, 'config', 'user.name', 'canary');
    writeFileSync(path.join(repoDir, 'f.ts'), STRIPPED_BASE);
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-qm', 'base');
    const ghostPatch = [
      'diff --git a/ghost.ts b/ghost.ts',
      'index 1111111..2222222 100644',
      '--- a/ghost.ts',
      '+++ b/ghost.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const patchFile = path.join(root, 'ghost.patch');
    writeFileSync(patchFile, ghostPatch);
    try {
      const result = applyPatchWithConflictDetection(repoDir, patchFile);
      expect(result.outcome).toBe('failed');
      expect(result.conflictedPaths).toHaveLength(0);
      expect(result.message).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('welcome comment sets contributor expectations without implementation details', () => {
    const body = buildWelcomePublicComment();

    expect(body).toContain('Thanks for the contribution!');
    expect(body).toContain('A maintainer will review your PR.');
    expect(body).toContain('internal mirror');
    expect(body).toContain('authorship is preserved');
    expect(body).not.toContain('Copybara');
    expect(body).not.toContain('rebase');
    expect(body).not.toContain('<!-- monorepo-pr-bridge -->');
  });
});

describe('commitIndicatesConflicts (metadata-re-sync conflict-hold guard)', () => {
  test('true for a conflict-marker mirror commit message', () => {
    expect(
      commitIndicatesConflicts(
        'sync(oss): mirror inkeep/open-knowledge#310 (with conflicts; needs manual resolution)',
      ),
    ).toBe(true);
  });

  test('false for a clean mirror commit message', () => {
    expect(commitIndicatesConflicts('sync(oss): mirror inkeep/open-knowledge#310')).toBe(false);
  });

  test('false for absent / non-string input', () => {
    expect(commitIndicatesConflicts(undefined)).toBe(false);
    expect(commitIndicatesConflicts(null)).toBe(false);
    expect(commitIndicatesConflicts(42)).toBe(false);
  });
});

const CONFLICT_HEAD =
  'sync(oss): mirror inkeep/open-knowledge#310 (with conflicts; needs manual resolution)';
const CLEAN_HEAD = 'sync(oss): mirror inkeep/open-knowledge#310';

async function runBridgeSync({
  headCommitMessage = CLEAN_HEAD,
  internalPrStartsDraft = false,
  internalRepoDir = '/tmp/unused-on-metadata-path',
  action = 'edited',
  claStatus = 'success',
  existingPr = true,
  readHead = () => 'internal-head-sha',
  patchHead = readHead,
  mode = 'sync',
  publicHead = 'public-head-sha',
  publicBase = 'public-base-sha',
  publicHeadOnReread = publicHead,
  changedPublicHeadAfterCommit = false,
  changedInternalHeadAfterCommit = false,
  importedPublicHead = 'public-head-sha',
  importedRepo = 'inkeep/open-knowledge',
  importedPrNumber = 310,
  importedInternalHead = readHead(),
  eventSha = 'public-head-sha',
  eventContext = 'license/cla',
  eventState = 'success',
  publicState = 'open',
  internalState = 'open',
  hasMarker = true,
  markerHeadFields = 'current',
  earlierMarker = '',
  headRef = 'contribution',
  headRepo = 'octocat/open-knowledge',
  internalHeadRef = 'public-pr/open-knowledge-310',
  associations = [{ number: 310 }],
  publicCandidates,
}) {
  const recorded = {
    draftMutation: null,
    comment: null,
    statuses: [],
    validationRequests: [],
    internalBodies: [],
  };
  const marker = [
    '<!-- public-pr-sync',
    `public_repo=${importedRepo}`,
    `public_pr_number=${importedPrNumber}`,
    ...(markerHeadFields === 'current' || markerHeadFields === 'partial'
      ? [`public_head_sha=${importedPublicHead}`]
      : []),
    ...(markerHeadFields === 'current' || markerHeadFields === 'internal-only'
      ? [`internal_head_sha=${importedInternalHead}`]
      : []),
    '-->',
  ].join('\n');
  const internalPr = {
    number: 42,
    node_id: 'PR_node_42',
    draft: internalPrStartsDraft,
    head: { sha: readHead(), ref: internalHeadRef, repo: { full_name: 'inkeep/agents-private' } },
    state: internalState,
    base: { ref: 'main' },
    body: earlierMarker + (hasMarker ? marker : ''),
    html_url: 'https://github.com/inkeep/agents-private/pull/42',
  };
  const publicPr = {
    number: 310,
    title: 'Fix something',
    body: 'body',
    html_url: 'https://github.com/inkeep/open-knowledge/pull/310',
    user: { login: 'octocat', id: 99 },
    base: { ref: 'main', sha: publicBase, repo: { full_name: 'inkeep/open-knowledge' } },
    head: { label: 'octocat:branch', sha: publicHead, ref: headRef, repo: { full_name: headRepo } },
    state: publicState,
    draft: false,
  };
  const json = (obj, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(obj),
  });

  let publicReads = 0;
  let internalHeadOverride;
  const apiHead = () => internalHeadOverride ?? readHead();
  const candidatePrs = publicCandidates ?? [{ number: 310, head: { sha: publicHead } }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'GET' && url.includes('/pulls/310/commits?')) return json([]);
    if (method === 'GET' && /\/commits\/[^/]+\/pulls\?/.test(url)) {
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      return json(associations.slice((page - 1) * 100, page * 100));
    }
    if (method === 'GET' && url.includes('/repos/inkeep/agents-private/pulls/42'))
      return json({ ...internalPr, head: { ...internalPr.head, sha: apiHead() } });
    if (method === 'GET' && url.includes('/repos/inkeep/open-knowledge/pulls/311'))
      return json({ ...publicPr, number: 311, head: { ...publicPr.head, sha: 'another-head' } });
    if (method === 'GET' && url.includes('/repos/inkeep/open-knowledge/pulls/310')) {
      publicReads += 1;
      return json({
        ...publicPr,
        head: {
          ...publicPr.head,
          sha:
            publicReads > 1
              ? changedPublicHeadAfterCommit
                ? publicPr.head.sha
                : publicHeadOnReread
              : publicPr.head.sha,
        },
      });
    }
    if (method === 'GET' && url.includes('/repos/inkeep/open-knowledge/pulls?state=open')) {
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      return json(candidatePrs.slice((page - 1) * 100, page * 100));
    }
    if (method === 'GET' && url.includes('/pulls?state=open'))
      return json(
        existingPr ? [{ ...internalPr, head: { ...internalPr.head, sha: readHead() } }] : [],
      );
    if (
      method === 'GET' &&
      url.includes('/commits/internal-head-sha') &&
      !url.includes('/status')
    ) {
      if (changedPublicHeadAfterCommit) publicPr.head.sha = 'new-public-head';
      if (changedInternalHeadAfterCommit) {
        internalHeadOverride = 'new-internal-head';
        internalPr.body = internalPr.body.replace(
          `internal_head_sha=${importedInternalHead}`,
          `internal_head_sha=${internalHeadOverride}`,
        );
      }
      return json({ commit: { message: headCommitMessage } });
    }
    if (method === 'PATCH' && url.includes('/pulls/42')) {
      const update = JSON.parse(init.body);
      recorded.internalBodies.push(update.body);
      return json({ ...internalPr, ...update, head: { ...internalPr.head, sha: patchHead() } });
    }
    if (method === 'POST' && url.endsWith('/repos/inkeep/agents-private/pulls')) {
      const update = JSON.parse(init.body);
      recorded.internalBodies.push(update.body);
      return json({
        ...internalPr,
        body: update.body,
        head: { ...internalPr.head, sha: patchHead() },
      });
    }
    if (method === 'GET' && url.includes('/orgs/')) return json({ message: 'Not Found' }, 404);
    if (method === 'GET' && url.includes(`/commits/${publicHead}/status`)) {
      return json({ statuses: [{ context: 'license/cla', state: claStatus }] });
    }
    if (method === 'GET' && url.includes('/actions/workflows/')) {
      const requestUrl = new URL(url);
      recorded.validationRequests.push({
        method,
        path: requestUrl.pathname,
        authorization: init.headers.Authorization,
        query: Object.fromEntries(requestUrl.searchParams),
      });
      return json({ workflow_runs: [] });
    }
    if (method === 'POST' && url.includes('/actions/runs/')) {
      recorded.validationRequests.push({
        method,
        path: new URL(url).pathname,
        authorization: init.headers.Authorization,
        verifiedStatus: recorded.statuses.at(-1),
      });
      return json(null, 201);
    }
    if (method === 'POST' && url.endsWith('/graphql')) {
      const q = JSON.parse(init.body).query;
      recorded.draftMutation = q.includes('convertPullRequestToDraft')
        ? 'to-draft'
        : q.includes('markPullRequestReadyForReview')
          ? 'to-ready'
          : 'unknown';
      return json({ data: {} });
    }
    if (method === 'POST' && url.includes('/statuses/')) {
      recorded.statuses.push({
        sha: new URL(url).pathname.split('/').at(-1),
        ...JSON.parse(init.body),
      });
      return json({});
    }
    if (method === 'POST' && url.includes('/issues/310/comments')) {
      recorded.comment = JSON.parse(init.body).body;
      return json({ html_url: 'https://github.com/x/comments/1' });
    }
    throw new Error(`unrouted request: ${method} ${url}`);
  };

  const setKeys = {
    PUBLIC_TOKEN: 'pub',
    INTERNAL_TOKEN: 'int',
    PUBLIC_REPO: 'inkeep/open-knowledge',
    INTERNAL_REPO: 'inkeep/agents-private',
    INTERNAL_REPO_DIR: internalRepoDir,
    MONOREPO_PATH_PREFIX: 'public/open-knowledge',
    INTERNAL_BASE_REF: 'main',
    INTERNAL_BRANCH_PREFIX: 'public-pr/open-knowledge',
    PUBLIC_PR_NUMBER: '310',
    PUBLIC_PR_ACTION: action,
    PUBLIC_STATUS_SHA: eventSha,
    PUBLIC_STATUS_CONTEXT: eventContext,
    PUBLIC_STATUS_STATE: eventState,
    GIT_ALLOW_PROTOCOL: 'file',
  };
  const saved = {};
  for (const k of Object.keys(setKeys)) saved[k] = process.env[k];
  Object.assign(process.env, setKeys);
  try {
    if (mode === 'sync') await syncPublicPr();
    else await bridge.refreshPublicPrCla();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(setKeys)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return recorded;
}

describe('syncPublicPr metadata-event composition (conflict-hold fail-open guard)', () => {
  test('a metadata event on a DRAFT conflict PR keeps it draft and posts no public comment', async () => {
    const r = await runBridgeSync({
      headCommitMessage: CONFLICT_HEAD,
      internalPrStartsDraft: true,
    });
    expect(r.draftMutation).toBeNull();
    expect(r.comment).toBeNull();
  });

  test('a metadata event on a clean PR readies it and posts no public comment', async () => {
    const r = await runBridgeSync({ headCommitMessage: CLEAN_HEAD, internalPrStartsDraft: true });
    expect(r.draftMutation).toBe('to-ready');
    expect(r.comment).toBeNull();
  });

  test('a metadata event on a non-draft PR whose head now carries conflicts re-drafts it without a public comment', async () => {
    const r = await runBridgeSync({
      headCommitMessage: CONFLICT_HEAD,
      internalPrStartsDraft: false,
    });
    expect(r.draftMutation).toBe('to-draft');
    expect(r.comment).toBeNull();
  });
});

describe('bridge CLA status refresh', () => {
  test('a successful sync only posts status and never drives Actions', async () => {
    const result = await runBridgeSync({ claStatus: 'success' });
    expect(result.validationRequests).toEqual([]);
  });

  test.each(['success', 'failure', 'pending', null])(
    'uses the current API status %s for the imported public head',
    async (claStatus) => {
      const result = await runBridgeSync({
        mode: 'refresh-cla',
        claStatus,
        eventState: claStatus === 'success' ? 'failure' : 'success',
      });
      expect(result.statuses).toEqual([
        expect.objectContaining({
          sha: 'internal-head-sha',
          context: 'cla/verified',
          state: claStatus === 'success' ? 'success' : 'failure',
        }),
      ]);
      expect(result.validationRequests).toEqual([]);
      expect(result.internalBodies).toEqual([]);
    },
  );

  test.each([
    ['other status context', { eventContext: 'another-check' }],
    [
      'replaced public head',
      { publicHead: 'new-public-head', importedPublicHead: 'new-public-head' },
    ],
    ['other imported repository', { importedRepo: 'another/repository' }],
    ['other imported PR', { importedPrNumber: 311 }],
    ['pending import', { importedPublicHead: 'previous-public-head' }],
    ['replaced internal head', { importedInternalHead: 'previous-internal-head' }],
    ['public head changed during refresh', { changedPublicHeadAfterCommit: true }],
    ['internal head changed during refresh', { changedInternalHeadAfterCommit: true }],
    ['missing marker', { hasMarker: false }],
    ['closed public PR', { publicState: 'closed' }],
    ['closed internal PR', { internalState: 'closed' }],
    ['missing internal PR', { existingPr: false }],
    ['other internal branch', { internalHeadRef: 'fix/ordinary' }],
    ['mirror sync PR', { headRepo: 'inkeep/open-knowledge', headRef: 'copybara/sync' }],
  ])('leaves %s unchanged', async (_name, overrides) => {
    const result = await runBridgeSync({
      mode: 'refresh-cla',
      internalPrStartsDraft: true,
      ...overrides,
    });
    expect(result.statuses).toEqual([]);
    expect(result.draftMutation).toBeNull();
    expect(result.internalBodies).toEqual([]);
  });

  test('uses the final sync marker after the original PR body', async () => {
    const result = await runBridgeSync({
      mode: 'refresh-cla',
      earlierMarker:
        '<!-- public-pr-sync\npublic_head_sha=previous-public-head\ninternal_head_sha=previous-internal-head\n-->\n',
    });
    expect(result.statuses).toEqual([
      expect.objectContaining({ sha: 'internal-head-sha', state: 'success' }),
    ]);
  });

  test('finds the current public PR after a page of other open PRs', async () => {
    const result = await runBridgeSync({
      mode: 'refresh-cla',
      associations: [],
      publicCandidates: [
        ...Array.from({ length: 100 }, () => ({ number: 311, head: { sha: 'other-head' } })),
        { number: 310, head: { sha: 'public-head-sha' } },
      ],
    });
    expect(result.statuses).toEqual([
      expect.objectContaining({ sha: 'internal-head-sha', state: 'success' }),
    ]);
  });

  test('finds a fork PR when commit associations are empty', async () => {
    const result = await runBridgeSync({ mode: 'refresh-cla', associations: [] });
    expect(result.statuses).toEqual([
      expect.objectContaining({
        sha: 'internal-head-sha',
        context: 'cla/verified',
        state: 'success',
      }),
    ]);
    expect(result.internalBodies).toEqual([]);
  });

  test('refresh preserves the conflict hold on an imported head', async () => {
    const result = await runBridgeSync({
      mode: 'refresh-cla',
      headCommitMessage: CONFLICT_HEAD,
      internalPrStartsDraft: true,
    });
    expect(result.statuses).toEqual([expect.objectContaining({ state: 'success' })]);
    expect(result.draftMutation).toBeNull();
  });

  test('metadata edits do not attest to a public head that has not been imported', async () => {
    const result = await runBridgeSync({
      publicHead: 'new-public-head',
      internalPrStartsDraft: true,
    });
    expect(result.statuses).toEqual([]);
    expect(result.draftMutation).toBeNull();
    expect(result.internalBodies).toEqual([]);
  });
});

function setupSyncRepo({ sourceContent = 'updated\n', mapForkToSource = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bridge-head-status-'));
  const remote = path.join(root, 'remote.git');
  const internal = path.join(root, 'internal');
  const branch = 'public-pr/open-knowledge-310';
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', internal);
  git(internal, 'config', 'user.name', 'Fixture');
  git(internal, 'config', 'user.email', 'fixture@example.test');
  mkdirSync(path.join(internal, 'public/open-knowledge'), { recursive: true });
  const file = path.join(internal, 'public/open-knowledge/fixture.txt');
  writeFileSync(file, 'base\n');
  git(internal, 'add', 'public/open-knowledge/fixture.txt');
  git(internal, 'commit', '-m', 'Base');
  git(internal, 'remote', 'add', 'origin', remote);
  git(internal, 'push', '-u', 'origin', 'main');
  git(internal, 'checkout', '-b', branch);
  writeFileSync(file, 'previous\n');
  git(internal, 'commit', '-am', 'Previous head');
  git(internal, 'push', '-u', 'origin', branch);
  const oldHead = git(internal, 'rev-parse', 'HEAD');
  git(internal, 'checkout', 'main');
  const source = path.join(root, 'public');
  const sourceRepoDir = path.join(root, 'public.git');
  git(root, 'init', '--bare', '--initial-branch=main', sourceRepoDir);
  git(root, 'init', '--initial-branch=main', source);
  git(source, 'config', 'user.name', 'Contributor');
  git(source, 'config', 'user.email', 'contributor@example.test');
  writeFileSync(path.join(source, 'fixture.txt'), 'base\n');
  git(source, 'add', 'fixture.txt');
  git(source, 'commit', '-m', 'Base');
  const baseHead = git(source, 'rev-parse', 'HEAD');
  git(source, 'remote', 'add', 'origin', sourceRepoDir);
  git(source, 'push', 'origin', 'main');
  git(source, 'checkout', '-b', 'contribution');
  writeFileSync(path.join(source, 'fixture.txt'), sourceContent);
  git(source, 'commit', '-am', 'Recorded head');
  const approvedHead = git(source, 'rev-parse', 'HEAD');
  git(source, 'push', 'origin', 'HEAD:refs/pull/310/head');
  const rewriteKey = `url.${sourceRepoDir}.insteadOf`;
  git(
    internal,
    'config',
    '--add',
    rewriteKey,
    'https://x-access-token:pub@github.com/inkeep/open-knowledge.git',
  );
  if (mapForkToSource) {
    git(
      internal,
      'config',
      '--add',
      rewriteKey,
      'https://x-access-token:pub@github.com/octocat/open-knowledge.git',
    );
  }
  return {
    root,
    internal,
    remote,
    branch,
    oldHead,
    source,
    sourceRepoDir,
    baseHead,
    approvedHead,
    publishedHead: () => git(remote, 'rev-parse', `refs/heads/${branch}`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function setupSyncSourceRepo() {
  const fixture = setupSyncRepo({ sourceContent: 'approved' });
  writeFileSync(path.join(fixture.source, 'fixture.txt'), 'later');
  git(fixture.source, 'commit', '-am', 'Later head');
  git(fixture.source, 'push', 'origin', 'HEAD:refs/pull/310/head');
  return fixture;
}

function setupForkOnlySyncRepo() {
  const fixture = setupSyncRepo({ mapForkToSource: false });
  const fork = path.join(fixture.root, 'fork');
  const forkRepoDir = path.join(fixture.root, 'fork.git');
  git(fixture.root, 'init', '--bare', '--initial-branch=main', forkRepoDir);
  git(fixture.root, 'clone', fixture.sourceRepoDir, fork);
  git(fork, 'config', 'user.name', 'Fork Contributor');
  git(fork, 'config', 'user.email', 'fork@example.test');
  writeFileSync(path.join(fork, 'fixture.txt'), 'fork-only\n');
  git(fork, 'commit', '-am', 'Fork-only head');
  const forkHead = git(fork, 'rev-parse', 'HEAD');
  git(fork, 'remote', 'add', 'fork', forkRepoDir);
  git(fork, 'push', 'fork', 'HEAD:main');
  git(
    fixture.internal,
    'config',
    '--add',
    `url.${forkRepoDir}.insteadOf`,
    'https://x-access-token:pub@github.com/octocat/open-knowledge.git',
  );
  return { ...fixture, forkHead };
}

async function captureBridgeLogs(action) {
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.warn = (...parts) => logs.push(parts.join(' '));
  try {
    return { result: await action(), logs };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

describe('syncPublicPr legacy metadata import', () => {
  test('an approved metadata event rebuilds content and records the current public head', async () => {
    const fixture = setupSyncRepo();
    try {
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'edited',
        markerHeadFields: 'legacy',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      const publishedHead = fixture.publishedHead();
      expect(publishedHead).not.toBe(fixture.oldHead);
      expect(
        git(fixture.remote, 'show', `${fixture.branch}:public/open-knowledge/fixture.txt`),
      ).toBe('updated');
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${fixture.approvedHead}`);
      expect(recorded.internalBodies.at(-1)).toContain(`internal_head_sha=${publishedHead}`);
      expect(recorded.statuses).toContainEqual(
        expect.objectContaining({
          sha: publishedHead,
          context: 'cla/verified',
          state: 'success',
        }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    ['partial marker', { markerHeadFields: 'partial' }],
    ['internal-only marker', { markerHeadFields: 'internal-only' }],
    ['modern mismatch', { importedPublicHead: 'previous-public-head' }],
    ['other repository', { markerHeadFields: 'legacy', importedRepo: 'another/repository' }],
    ['other PR', { markerHeadFields: 'legacy', importedPrNumber: 311 }],
    ['other branch', { markerHeadFields: 'legacy', internalHeadRef: 'fix/ordinary' }],
  ])('leaves %s without a new receipt or status', async (_name, overrides) => {
    const fixture = setupSyncRepo();
    try {
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'edited',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
        ...overrides,
      });
      expect(fixture.publishedHead()).toBe(fixture.oldHead);
      expect(recorded.internalBodies).toEqual([]);
      expect(recorded.statuses).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('an empty pinned diff leaves a legacy head without a receipt or status and explains why', async () => {
    const fixture = setupSyncRepo();
    try {
      git(fixture.source, 'checkout', 'main');
      git(fixture.source, 'merge', '--ff-only', 'contribution');
      git(fixture.source, 'push', 'origin', 'main');
      git(fixture.source, 'checkout', 'contribution');
      git(fixture.source, 'commit', '--allow-empty', '-m', 'Empty change');
      const emptyHead = git(fixture.source, 'rev-parse', 'HEAD');
      git(fixture.source, 'push', 'origin', 'HEAD:refs/pull/310/head');
      const { result, logs } = await captureBridgeLogs(() =>
        runBridgeSync({
          internalRepoDir: fixture.internal,
          action: 'edited',
          markerHeadFields: 'legacy',
          publicHead: emptyHead,
          publicBase: fixture.approvedHead,
          readHead: fixture.publishedHead,
        }),
      );
      expect(fixture.publishedHead()).toBe(fixture.oldHead);
      expect(result.internalBodies).toEqual([]);
      expect(result.statuses).toEqual([]);
      expect(
        logs.some(
          (line) =>
            line.includes('PR #310') &&
            line.includes(emptyHead) &&
            line.includes('no new import recorded'),
        ),
      ).toBe(true);
      expect(logs.join('\n')).not.toContain(fixture.oldHead);
    } finally {
      fixture.cleanup();
    }
  });

  test('an already present change leaves a legacy head without a receipt or status and explains why', async () => {
    const fixture = setupSyncRepo();
    try {
      writeFileSync(path.join(fixture.internal, 'public/open-knowledge/fixture.txt'), 'updated\n');
      git(fixture.internal, 'commit', '-am', 'Already present');
      git(fixture.internal, 'push', 'origin', 'main');
      const { result, logs } = await captureBridgeLogs(() =>
        runBridgeSync({
          internalRepoDir: fixture.internal,
          action: 'edited',
          markerHeadFields: 'legacy',
          publicHead: fixture.approvedHead,
          publicBase: fixture.baseHead,
          readHead: fixture.publishedHead,
        }),
      );
      expect(fixture.publishedHead()).toBe(fixture.oldHead);
      expect(result.internalBodies).toEqual([]);
      expect(result.statuses).toEqual([]);
      expect(
        logs.some(
          (line) =>
            line.includes('PR #310') &&
            line.includes(fixture.approvedHead) &&
            line.includes('no new receipt recorded'),
        ),
      ).toBe(true);
      expect(logs.join('\n')).not.toContain(fixture.oldHead);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('syncPublicPr published-head status', () => {
  test('imports a recorded head reachable only from its fork', async () => {
    const fixture = setupForkOnlySyncRepo();
    try {
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: fixture.forkHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      expect(
        git(fixture.remote, 'show', `${fixture.branch}:public/open-knowledge/fixture.txt`),
      ).toBe('fork-only');
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${fixture.forkHead}`);
      expect(recorded.statuses).toContainEqual(
        expect.objectContaining({
          sha: fixture.publishedHead(),
          context: 'cla/verified',
          state: 'success',
        }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('publishes the recorded public head when its ref advances', async () => {
    const fixture = setupSyncSourceRepo();
    try {
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${fixture.approvedHead}`);
      expect(
        git(fixture.remote, 'show', `${fixture.branch}:public/open-knowledge/fixture.txt`),
      ).toBe('approved');
    } finally {
      fixture.cleanup();
    }
  });

  test('fetches the recorded head commit after the public ref moves to another history', async () => {
    const fixture = setupSyncRepo({ sourceContent: 'approved' });
    try {
      git(fixture.source, 'push', 'origin', `${fixture.approvedHead}:refs/heads/saved-head`);
      git(fixture.source, 'reset', '--hard', fixture.baseHead);
      writeFileSync(path.join(fixture.source, 'fixture.txt'), 'later');
      git(fixture.source, 'commit', '-am', 'Later head');
      git(fixture.source, 'push', 'origin', '+HEAD:refs/pull/310/head');
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      expect(
        git(fixture.remote, 'show', `${fixture.branch}:public/open-knowledge/fixture.txt`),
      ).toBe('approved');
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${fixture.approvedHead}`);
    } finally {
      fixture.cleanup();
    }
  });

  test('publishes the recorded diff when the base ref advances', async () => {
    const fixture = setupSyncRepo();
    try {
      git(fixture.source, 'checkout', 'main');
      git(fixture.source, 'merge', '--ff-only', 'contribution');
      git(fixture.source, 'push', 'origin', 'main');
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      expect(
        git(fixture.remote, 'show', `${fixture.branch}:public/open-knowledge/fixture.txt`),
      ).toBe('updated');
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${fixture.approvedHead}`);
    } finally {
      fixture.cleanup();
    }
  });

  test('stops before publication when the recorded head commit is unavailable', async () => {
    const fixture = setupSyncRepo();
    try {
      await expect(
        runBridgeSync({
          internalRepoDir: fixture.internal,
          action: 'synchronize',
          publicHead: 'f'.repeat(40),
          publicBase: fixture.baseHead,
          readHead: fixture.publishedHead,
        }),
      ).rejects.toThrow();
      expect(fixture.publishedHead()).toBe(fixture.oldHead);
    } finally {
      fixture.cleanup();
    }
  });

  test('publishes a large diff with complete text bytes', async () => {
    const fixture = setupSyncRepo();
    const largeContent = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    try {
      writeFileSync(path.join(fixture.source, 'fixture.txt'), largeContent);
      git(fixture.source, 'commit', '-am', 'Large text change');
      const largeHead = git(fixture.source, 'rev-parse', 'HEAD');
      git(fixture.source, 'push', 'origin', 'HEAD:refs/pull/310/head');
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: largeHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${largeHead}`);
      expect(
        readFileSync(path.join(fixture.internal, 'public/open-knowledge/fixture.txt'), 'utf8'),
      ).toBe(largeContent);
    } finally {
      fixture.cleanup();
    }
  });

  test('publishes binary file bytes from the recorded commit', async () => {
    const fixture = setupSyncRepo();
    const binaryContent = Buffer.from([0, 1, 2, 127, 128, 255]);
    try {
      writeFileSync(path.join(fixture.source, 'asset.bin'), binaryContent);
      git(fixture.source, 'add', 'asset.bin');
      git(fixture.source, 'commit', '-m', 'Add binary file');
      const binaryHead = git(fixture.source, 'rev-parse', 'HEAD');
      git(fixture.source, 'push', 'origin', 'HEAD:refs/pull/310/head');
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: binaryHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
      });
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${binaryHead}`);
      expect(readFileSync(path.join(fixture.internal, 'public/open-knowledge/asset.bin'))).toEqual(
        binaryContent,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('does not record an imported head when the public head changed during sync', async () => {
    const fixture = setupSyncRepo();
    try {
      const result = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        readHead: fixture.publishedHead,
        publicHeadOnReread: 'new-public-head',
      });
      expect(result.internalBodies).toEqual([]);
      expect(result.statuses).toEqual([
        expect.objectContaining({
          sha: fixture.publishedHead(),
          context: 'cla/verified',
          state: 'failure',
        }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    ['success', 'stale metadata', 'existing'],
    ['failure', 'stale metadata', 'existing'],
    ['success', 'stale reads', 'existing'],
    ['failure', 'stale reads', 'existing'],
    ['success', 'current metadata', 'existing'],
    ['failure', 'current metadata', 'existing'],
    ['success', 'stale metadata', 'new'],
    ['failure', 'stale metadata', 'new'],
  ])('posts %s on the published head with %s for %s PRs', async (claStatus, freshness, entry) => {
    const fixture = setupSyncRepo();
    try {
      const recorded = await runBridgeSync({
        internalRepoDir: fixture.internal,
        action: 'synchronize',
        publicHead: fixture.approvedHead,
        publicBase: fixture.baseHead,
        claStatus,
        existingPr: entry === 'existing',
        readHead: freshness === 'stale reads' ? () => fixture.oldHead : fixture.publishedHead,
        patchHead: freshness === 'current metadata' ? fixture.publishedHead : () => fixture.oldHead,
      });
      const head = fixture.publishedHead();
      expect(recorded.internalBodies.at(-1)).toContain(`public_head_sha=${fixture.approvedHead}`);
      expect(recorded.internalBodies.at(-1)).toContain(`internal_head_sha=${head}`);
      expect(head).not.toBe(fixture.oldHead);
      expect(
        git(fixture.remote, 'show', `${fixture.branch}:public/open-knowledge/fixture.txt`),
      ).toBe('updated');
      expect(recorded.statuses).toContainEqual(
        expect.objectContaining({
          sha: head,
          context: 'cla/verified',
          state: claStatus,
        }),
      );
    } finally {
      fixture.cleanup();
    }
  });
});
