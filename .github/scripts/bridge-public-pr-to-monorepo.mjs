import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyClaGate } from './cla-gate.mjs';

const OSS_SYNC_BOT_NAME = 'inkeep-oss-sync[bot]';
const OSS_SYNC_BOT_EMAIL = '274976938+inkeep-oss-sync[bot]@users.noreply.github.com';
const MAX_COMMAND_ERROR_LENGTH = 4096;
const MAX_COMMAND_LABEL_LENGTH = 256;

function sanitizeErrorMessage(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/https:\/\/x-access-token:[^@\s]+@/g, 'https://x-access-token:***@');
}

function run(command, args, options = {}) {
  const { preserveOutput = false, ...execOptions } = options;
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_COMMON_DIR: _c,
    GIT_INDEX_FILE: _i,
    GIT_OBJECT_DIRECTORY: _o,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _a,
    GIT_NAMESPACE: _n,
    GIT_PREFIX: _p,
    ...cleanEnv
  } = { ...process.env, ...execOptions.env };
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execOptions,
      env: cleanEnv,
    });
    return preserveOutput ? output : output.trim();
  } catch (error) {
    const invocation = sanitizeErrorMessage(`${command} ${args.join(' ')}`);
    const commandLabel =
      invocation.length > MAX_COMMAND_LABEL_LENGTH
        ? `${invocation.slice(0, MAX_COMMAND_LABEL_LENGTH)}...`
        : invocation;
    if (error.code === 'ENOBUFS') {
      const limit =
        execOptions.maxBuffer === undefined
          ? 'the configured limit'
          : `${execOptions.maxBuffer} bytes`;
      throw new Error(
        `${commandLabel} exceeded the output buffer limit (${limit}).`.slice(
          0,
          MAX_COMMAND_ERROR_LENGTH,
        ),
      );
    }
    const stderr = sanitizeErrorMessage(error.stderr?.toString().trim() ?? '');
    const stdout = sanitizeErrorMessage(error.stdout?.toString().trim() ?? '');
    const details =
      [stderr, stdout].filter(Boolean).join('\n') || sanitizeErrorMessage(error.message);
    throw new Error(`${commandLabel} failed: ${details}`.slice(0, MAX_COMMAND_ERROR_LENGTH));
  }
}

async function githubRequest({ token, method = 'GET', path: requestPath, body }) {
  const response = await fetch(`https://api.github.com${requestPath}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'inkeep-public-pr-bridge',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${requestPath} failed (${response.status}): ${text}`);
    error.status = response.status;
    throw error;
  }

  return text ? JSON.parse(text) : null;
}

async function githubGraphql({ token, query, variables }) {
  const result = await githubRequest({
    token,
    method: 'POST',
    path: '/graphql',
    body: { query, variables },
  });
  if (result?.errors?.length) {
    throw new Error(`GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`);
  }
  return result;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getPublicPrBranchName(prefix, prNumber) {
  return `${prefix}-${prNumber}`;
}

function parseJsonEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error.message}`);
  }
}

function hasSourceCommit(internalRepoDir, sha) {
  try {
    return run('git', ['-C', internalRepoDir, 'cat-file', '-t', sha]) === 'commit';
  } catch {
    return false;
  }
}

function fetchSourceCommit({ internalRepoDir, remoteUrl, sha, role }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`Bridge: recorded public ${role} commit has an invalid SHA.`);
  }
  if (hasSourceCommit(internalRepoDir, sha)) return;
  try {
    run('git', ['-C', internalRepoDir, 'fetch', '--no-tags', remoteUrl, sha]);
  } catch (error) {
    throw new Error(
      `Bridge: recorded public ${role} commit ${sha} is unavailable: ${error.message}`,
    );
  }
  if (!hasSourceCommit(internalRepoDir, sha)) {
    throw new Error(`Bridge: recorded public ${role} commit ${sha} is unavailable.`);
  }
}

function diffRecordedPublicCommits(internalRepoDir, baseSha, headSha) {
  return run(
    'git',
    [
      '-C',
      internalRepoDir,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      `${baseSha}...${headSha}`,
    ],
    { maxBuffer: 50 * 1024 * 1024, preserveOutput: true },
  );
}

function filterDiffByPath(patch, excludedPrefixes) {
  if (!excludedPrefixes || excludedPrefixes.length === 0) return patch;

  const sections = patch.split(/(?=^diff --git )/m);
  const kept = [];
  const dropped = [];

  for (const section of sections) {
    if (!section.startsWith('diff --git ')) {
      kept.push(section);
      continue;
    }
    const match = section.match(/^diff --git a\/(.+?) b\/(.+?)\n/);
    if (!match) {
      kept.push(section);
      continue;
    }
    const aPath = match[1].replace(/^"(.+)"$/, '$1');
    const bPath = match[2].replace(/^"(.+)"$/, '$1');

    const isExcluded = excludedPrefixes.some(
      (prefix) => aPath.startsWith(prefix) || bPath.startsWith(prefix),
    );

    if (isExcluded) {
      dropped.push(aPath === bPath ? aPath : `${aPath} -> ${bPath}`);
    } else {
      kept.push(section);
    }
  }

  if (dropped.length > 0) {
    const preview = dropped.slice(0, 20).join('\n  ');
    const more = dropped.length > 20 ? `\n  ...and ${dropped.length - 20} more` : '';
    console.log(
      `Bridge: filtered ${dropped.length} diff section(s) matching excluded prefixes:\n  ${preview}${more}`,
    );
  }

  return kept.join('');
}

function prefixPatchPaths(patch, prefix, pathRewrites = {}) {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const prefixedPath = (value) => {
    if (value === '/dev/null') {
      return value;
    }

    const unquoted = value.replace(/^"(.+)"$/, '$1');

    const segments = unquoted.split('/');
    if (segments.some((s) => s === '..' || s === '.')) {
      throw new Error(`Rejecting patch with path traversal: ${unquoted}`);
    }

    const rewrite = pathRewrites[unquoted];
    if (rewrite) {
      const rewriteSegments = rewrite.split('/');
      if (rewriteSegments.some((s) => s === '..' || s === '.')) {
        throw new Error(`Rejecting patch rewrite with path traversal: ${rewrite}`);
      }
    }

    const nextValue = rewrite ?? `${normalizedPrefix}/${unquoted}`.replace(/\/+/g, '/');
    return value.startsWith('"') ? `"${nextValue}"` : nextValue;
  };

  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git a/')) {
        const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (!match) {
          return line;
        }
        return `diff --git a/${prefixedPath(match[1])} b/${prefixedPath(match[2])}`;
      }
      if (line.startsWith('--- a/')) {
        return `--- a/${prefixedPath(line.slice(6))}`;
      }
      if (line.startsWith('+++ b/')) {
        return `+++ b/${prefixedPath(line.slice(6))}`;
      }
      if (line.startsWith('rename from ')) {
        return `rename from ${prefixedPath(line.slice('rename from '.length))}`;
      }
      if (line.startsWith('rename to ')) {
        return `rename to ${prefixedPath(line.slice('rename to '.length))}`;
      }
      if (line.startsWith('copy from ')) {
        return `copy from ${prefixedPath(line.slice('copy from '.length))}`;
      }
      if (line.startsWith('copy to ')) {
        return `copy to ${prefixedPath(line.slice('copy to '.length))}`;
      }
      return line;
    })
    .join('\n');
}

function internalPullRequestTitle(publicPr) {
  return `Sync ${publicPr.base.repo.full_name} public PR #${publicPr.number}: ${publicPr.title}`;
}

function singleLineCommitSubject(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bridgeCommitSubject({ publicRepo, publicPr, hasConflicts }) {
  const title = singleLineCommitSubject(publicPr.title);
  const suffix = hasConflicts ? ` (${CONFLICT_COMMIT_MARKER})` : '';
  return [
    `sync(oss): mirror ${publicRepo}#${publicPr.number}`,
    title ? `: ${title}` : '',
    suffix,
  ].join('');
}

function buildBridgeMetadata(publicPr, mirrorPath, internalHeadSha) {
  return [
    '<!-- public-pr-sync',
    `public_repo=${publicPr.base.repo.full_name}`,
    `public_pr_number=${publicPr.number}`,
    `public_head_sha=${publicPr.head.sha}`,
    `internal_head_sha=${internalHeadSha ?? ''}`,
    `public_pr_url=${publicPr.html_url}`,
    `public_author_login=${publicPr.user.login}`,
    `public_author_id=${publicPr.user.id}`,
    `mirror_path=${mirrorPath}`,
    '-->',
  ].join('\n');
}

function readImportMetadata(internalPr) {
  const marker = [...(internalPr.body ?? '').matchAll(/<!-- public-pr-sync\n([\s\S]*?)\n-->/g)].at(
    -1,
  );
  if (!marker) return null;
  return Object.fromEntries(
    marker[1].split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

function importedHeadMatches({ internalPr, publicPr, publicRepo, branchName }) {
  const metadata = readImportMetadata(internalPr);
  return (
    internalPr.state === 'open' &&
    internalPr.head.ref === branchName &&
    metadata?.public_repo === publicRepo &&
    metadata?.public_pr_number === String(publicPr.number) &&
    metadata?.public_head_sha === publicPr.head.sha &&
    metadata?.internal_head_sha === internalPr.head.sha
  );
}

function legacyImportNeedsRebuild({ internalPr, publicPr, publicRepo, branchName }) {
  const metadata = readImportMetadata(internalPr);
  return (
    internalPr.state === 'open' &&
    internalPr.head.ref === branchName &&
    metadata?.public_repo === publicRepo &&
    metadata?.public_pr_number === String(publicPr.number) &&
    !Object.hasOwn(metadata, 'public_head_sha') &&
    !Object.hasOwn(metadata, 'internal_head_sha')
  );
}

function publicPrAuthor(publicPr) {
  return {
    name: publicPr.user.login,
    email: `${publicPr.user.id}+${publicPr.user.login}@users.noreply.github.com`,
  };
}

function normalizeGitHubUserAuthor(user) {
  const login = user?.login?.trim();
  const id = user?.id;
  if (!login || id === undefined || id === null) return null;
  return {
    name: login,
    email: `${id}+${login}@users.noreply.github.com`,
  };
}

function normalizeCommitAuthor(author) {
  const name = author?.name?.trim();
  const email = author?.email?.trim();
  if (!name || !email?.includes('@')) return null;
  if (/[\r\n<>]/.test(name) || /[\r\n<>]/.test(email)) return null;
  return { name, email };
}

function parseCoauthorTrailer(line) {
  const match = line.match(/^Co-authored-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i);
  if (!match) return null;
  return normalizeCommitAuthor({ name: match[1], email: match[2] });
}

function coauthorsFromCommitMessage(message) {
  return normalizeCommitMessage(message)
    .split('\n')
    .map((line) => parseCoauthorTrailer(line.trim()))
    .filter(Boolean);
}

function uniqueCommitAuthors(authors) {
  const unique = new Map();
  for (const author of authors) {
    const normalized = normalizeCommitAuthor(author);
    if (!normalized) continue;
    unique.set(`${normalized.name.toLowerCase()} <${normalized.email.toLowerCase()}>`, normalized);
  }
  return [...unique.values()];
}

function normalizePublicPrCommit(commit) {
  return {
    sha: typeof commit?.sha === 'string' ? commit.sha : null,
    author: normalizeGitHubUserAuthor(commit?.author) ?? commit?.commit?.author,
    message: typeof commit?.commit?.message === 'string' ? commit.commit.message : '',
  };
}

async function listPublicPrCommits({ token, repo, prNumber, request = githubRequest }) {
  const publicCommits = [];
  let page = 1;
  while (true) {
    const commits = await request({
      token,
      path: `/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
    });
    publicCommits.push(...commits.map((commit) => normalizePublicPrCommit(commit)));
    if (commits.length < 100) break;
    page++;
  }
  return publicCommits;
}

function normalizeCommitMessage(message) {
  if (typeof message !== 'string') return '';
  return message.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
}

function formatOriginalCommitMessages(commitMessages, publicRepo) {
  const entries = commitMessages
    .map((commit) => {
      const message = normalizeCommitMessage(commit?.message);
      if (!message) return null;
      const rawSha = typeof commit?.sha === 'string' ? commit.sha : '';
      const sha = /^[0-9a-f]{7,40}$/i.test(rawSha) ? rawSha : null;
      const shortSha = sha ? sha.slice(0, 7) : null;
      const author = normalizeCommitAuthor(commit?.author);
      return { author, sha, shortSha, message };
    })
    .filter(Boolean);

  if (entries.length === 0) return '';

  const formatted = entries.map((entry) => {
    const lines = [];
    if (entry.sha && entry.shortSha && publicRepo) {
      lines.push(`[${entry.shortSha}](https://github.com/${publicRepo}/commit/${entry.sha})`);
    } else if (entry.shortSha) {
      lines.push(entry.shortSha);
    } else {
      lines.push('Commit');
    }
    if (entry.author) {
      lines.push(`Author: ${entry.author.name} <${entry.author.email}>`);
    }
    lines.push('');
    lines.push(entry.message);
    return lines.join('\n');
  });

  return ['Commits:', '', formatted.join('\n\n')].join('\n');
}

function buildCommitAttribution({ commitAuthors, commitMessages = [], publicRepo }) {
  const authors = uniqueCommitAuthors([
    ...commitAuthors,
    ...commitMessages.map((commit) => commit?.author),
    ...commitMessages.flatMap((commit) => coauthorsFromCommitMessage(commit?.message)),
  ]);
  const trailers = authors.map((author) => `Co-authored-by: ${author.name} <${author.email}>`);
  const originalCommitMessages = formatOriginalCommitMessages(commitMessages, publicRepo);
  const body = [originalCommitMessages, trailers.join('\n')].filter(Boolean).join('\n\n');
  return { trailers, originalCommitMessages, body };
}

const GITHUB_PR_BODY_LIMIT = 65536;

function buildInternalPrBody({ publicPr, branchName, mirrorPath, internalHeadSha }) {
  const rawOriginal = publicPr.body?.trim()
    ? publicPr.body.trim()
    : '_No public PR body was provided._';

  const compose = (original) => `## Summary
Mirror public PR [#${publicPr.number}](${publicPr.html_url}) from \`${publicPr.base.repo.full_name}\` into \`inkeep/agents-private\` for internal review and merge.

## Attribution
- Original author: @${publicPr.user.login}
- Public branch: \`${publicPr.head.label}\`
- Monorepo branch: \`${branchName}\`
- Monorepo path: \`${mirrorPath}\`

## Original PR Body
<details>
<summary>Expand</summary>

${original}

</details>

## Notes
- Do not edit this PR directly. This branch is fully managed by the public PR bridge and may be overwritten on the next sync.
- Do not merge the public repo PR. Public mirror PRs cannot land changes directly.
- To accept the contribution, merge this monorepo PR. The change will sync back to the public repo automatically, and the public PR will close automatically.
- To make edits or updates to these changes, they should be made directly to the public PR. Contributor updates there will sync back into this monorepo PR.

${buildBridgeMetadata(publicPr, mirrorPath, internalHeadSha)}`;

  let body = compose(rawOriginal);
  if (body.length > GITHUB_PR_BODY_LIMIT) {
    const footer = `\n\n_...truncated. Original body exceeded GitHub's ${GITHUB_PR_BODY_LIMIT}-char PR body limit; see [original PR](${publicPr.html_url}) for full content._`;
    const scaffolding = body.length - rawOriginal.length;
    const budget = GITHUB_PR_BODY_LIMIT - scaffolding - footer.length - 100;
    const truncated = rawOriginal.slice(0, Math.max(budget, 0)) + footer;
    console.log(
      `Bridge: PR body exceeded GitHub's ${GITHUB_PR_BODY_LIMIT}-char limit ` +
        `(original: ${rawOriginal.length} chars, truncated to: ${truncated.length} chars).`,
    );
    body = compose(truncated);
  }
  return body;
}

function buildWelcomePublicComment() {
  return `Thanks for the contribution!

**What happens next:**

- A maintainer will review your PR.
- If you don't hear back within a few business days, please comment here to nudge our team.
- This repository is maintained through an internal mirror. When your change is accepted, this PR will close automatically. Don't be alarmed when it closes — that's how it merges, and your authorship is preserved.`;
}

async function createIssueComment({ token, repo, issueNumber, body }) {
  const created = await githubRequest({
    token,
    method: 'POST',
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    body: { body },
  });
  return created.html_url;
}

async function acknowledgePublicPr() {
  const publicToken = requireEnv('PUBLIC_TOKEN');
  const publicRepo = requireEnv('PUBLIC_REPO');
  const publicPrNumber = Number.parseInt(requireEnv('PUBLIC_PR_NUMBER'), 10);

  await createIssueComment({
    token: publicToken,
    repo: publicRepo,
    issueNumber: publicPrNumber,
    body: buildWelcomePublicComment(),
  });
}

async function findOpenInternalPr({ token, repo, owner, branchName }) {
  const pulls = await githubRequest({
    token,
    path: `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branchName}`)}`,
  });
  return pulls[0] ?? null;
}

async function ensureDraftState({ token, pullRequest, shouldBeDraft }) {
  if (Boolean(pullRequest.draft) === Boolean(shouldBeDraft)) {
    return;
  }

  const query = shouldBeDraft
    ? `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }`
    : `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }`;

  await githubGraphql({
    token,
    query,
    variables: { id: pullRequest.node_id },
  });
}

async function readCommitClaStatus({ token, repo, sha, request = githubRequest }) {
  const result = await request({
    token,
    path: `/repos/${repo}/commits/${sha}/status?per_page=100`,
  });
  const cla = (result.statuses ?? []).find((s) => s.context === 'license/cla');
  return cla ? cla.state : null;
}

async function checkOrgMembership({ token, org, login, request = githubRequest }) {
  try {
    await request({ token, path: `/orgs/${org}/members/${encodeURIComponent(login)}` });
    return true;
  } catch (error) {
    if (error?.status === 404) {
      return false;
    }
    throw error;
  }
}

async function postCommitStatus({
  token,
  repo,
  sha,
  state,
  context,
  description,
  request = githubRequest,
}) {
  await request({
    token,
    method: 'POST',
    path: `/repos/${repo}/statuses/${sha}`,
    body: { state, context, description },
  });
}

function createClaGateGh({
  publicToken,
  publicRepo,
  internalToken,
  internalRepo,
  request = githubRequest,
}) {
  const org = internalRepo.split('/')[0];
  return {
    readClaStatus: (pr) =>
      readCommitClaStatus({ token: publicToken, repo: publicRepo, sha: pr.head.sha, request }),
    isOrgMember: (login) => checkOrgMembership({ token: internalToken, org, login, request }),
    setDraft: (pr, shouldBeDraft) =>
      ensureDraftState({ token: internalToken, pullRequest: pr, shouldBeDraft }),
    setVerifiedStatus: (pr, state, description) =>
      postCommitStatus({
        token: internalToken,
        repo: internalRepo,
        sha: pr.head.sha,
        state,
        context: 'cla/verified',
        description,
        request,
      }),
  };
}

async function refreshPublicPrCla() {
  if (requireEnv('PUBLIC_STATUS_CONTEXT') !== 'license/cla') {
    console.log('Bridge: skipped CLA refresh for an unrelated public status.');
    return;
  }
  const sha = requireEnv('PUBLIC_STATUS_SHA');
  const publicToken = requireEnv('PUBLIC_TOKEN');
  const internalToken = requireEnv('INTERNAL_TOKEN');
  const publicRepo = requireEnv('PUBLIC_REPO');
  const internalRepo = requireEnv('INTERNAL_REPO');
  const internalBranchPrefix = requireEnv('INTERNAL_BRANCH_PREFIX');
  const owner = internalRepo.split('/')[0];
  let matchedPublicPrs = 0;
  for (let page = 1; ; page += 1) {
    const openPrs = await githubRequest({
      token: publicToken,
      path: `/repos/${publicRepo}/pulls?state=open&per_page=100&page=${page}`,
    });
    for (const candidate of openPrs) {
      if (candidate.head?.sha !== sha) continue;
      matchedPublicPrs += 1;
      const publicPr = await githubRequest({
        token: publicToken,
        path: `/repos/${publicRepo}/pulls/${candidate.number}`,
      });
      const publicHead = `public PR #${publicPr.number} head ${sha}`;
      if (
        publicPr.state !== 'open' ||
        publicPr.head.sha !== sha ||
        publicPr.base.repo.full_name !== publicRepo ||
        (publicPr.head.repo?.full_name === publicRepo && publicPr.head.ref === 'copybara/sync')
      ) {
        console.log(`Bridge: skipped ${publicHead}; public PR is no longer eligible.`);
        continue;
      }
      const branchName = getPublicPrBranchName(internalBranchPrefix, publicPr.number);
      const linkedPr = await findOpenInternalPr({
        token: internalToken,
        repo: internalRepo,
        owner,
        branchName,
      });
      if (!linkedPr) {
        console.log(`Bridge: skipped ${publicHead}; no linked import is open.`);
        continue;
      }
      const internalPr = linkedPr;
      if (!importedHeadMatches({ internalPr, publicPr, publicRepo, branchName })) {
        console.log(`Bridge: skipped ${publicHead}; recorded import does not match.`);
        continue;
      }
      const headCommit = await githubRequest({
        token: internalToken,
        path: `/repos/${internalRepo}/commits/${internalPr.head.sha}`,
      });
      const currentPublicPr = await githubRequest({
        token: publicToken,
        path: `/repos/${publicRepo}/pulls/${publicPr.number}`,
      });
      const currentInternalPr = await githubRequest({
        token: internalToken,
        path: `/repos/${internalRepo}/pulls/${internalPr.number}`,
      });
      if (
        currentPublicPr.state !== 'open' ||
        currentPublicPr.head.sha !== sha ||
        currentInternalPr.head.sha !== internalPr.head.sha ||
        !importedHeadMatches({
          internalPr: currentInternalPr,
          publicPr: currentPublicPr,
          publicRepo,
          branchName,
        })
      ) {
        console.log(`Bridge: skipped ${publicHead}; public PR or import changed during refresh.`);
        continue;
      }
      await applyClaGate({
        gh: createClaGateGh({ publicToken, publicRepo, internalToken, internalRepo }),
        publicPr: currentPublicPr,
        internalPr: currentInternalPr,
        forceDraft: commitIndicatesConflicts(headCommit.commit.message),
      });
      console.log(`Bridge: refreshed CLA for ${publicHead}.`);
    }
    if (openPrs.length < 100) break;
  }
  if (matchedPublicPrs === 0) {
    console.log(`Bridge: no open public PR has head ${sha}.`);
  }
}

const CONFLICT_COMMIT_MARKER = 'with conflicts; needs manual resolution';

function commitIndicatesConflicts(commitMessage) {
  return typeof commitMessage === 'string' && commitMessage.includes(CONFLICT_COMMIT_MARKER);
}

function applyPatchWithConflictDetection(internalRepoDir, patchFile) {
  try {
    run('git', ['-C', internalRepoDir, 'apply', '--index', '--3way', patchFile]);
    return { outcome: 'clean', conflictedPaths: [], message: '' };
  } catch (error) {
    let conflictedPaths = [];
    try {
      const unmerged = run('git', [
        '-C',
        internalRepoDir,
        'diff',
        '--name-only',
        '--diff-filter=U',
      ]);
      conflictedPaths = unmerged ? unmerged.split('\n').filter(Boolean) : [];
    } catch (probeError) {
      console.warn(
        `Bridge: git diff --diff-filter=U probe threw after a failed apply; routing as 'failed'. Probe error: ${probeError.message}`,
      );
      conflictedPaths = [];
    }
    if (conflictedPaths.length > 0) {
      return { outcome: 'conflicts', conflictedPaths, message: error.message };
    }
    return { outcome: 'failed', conflictedPaths: [], message: error.message };
  }
}

async function syncPublicPr() {
  const publicToken = requireEnv('PUBLIC_TOKEN');
  const internalToken = requireEnv('INTERNAL_TOKEN');
  const publicRepo = requireEnv('PUBLIC_REPO');
  const internalRepo = requireEnv('INTERNAL_REPO');
  const internalRepoDir = requireEnv('INTERNAL_REPO_DIR');
  const mirrorPath = requireEnv('MONOREPO_PATH_PREFIX');
  const internalBaseRef = requireEnv('INTERNAL_BASE_REF');
  const internalBranchPrefix = requireEnv('INTERNAL_BRANCH_PREFIX');
  const publicPrAction = process.env.PUBLIC_PR_ACTION ?? 'opened';
  const publicPrNumber = Number.parseInt(requireEnv('PUBLIC_PR_NUMBER'), 10);
  const pathRewrites = parseJsonEnv('PUBLIC_PR_PATH_REWRITES', {});
  const internalOwner = internalRepo.split('/')[0];
  const branchName = getPublicPrBranchName(internalBranchPrefix, publicPrNumber);

  const publicPr = await githubRequest({
    token: publicToken,
    path: `/repos/${publicRepo}/pulls/${publicPrNumber}`,
  });

  let internalPr = await findOpenInternalPr({
    token: internalToken,
    repo: internalRepo,
    owner: internalOwner,
    branchName,
  });

  const metadataAction =
    publicPrAction === 'edited' ||
    publicPrAction === 'ready_for_review' ||
    publicPrAction === 'converted_to_draft';
  const legacyNeedsRebuild =
    internalPr &&
    metadataAction &&
    legacyImportNeedsRebuild({ internalPr, publicPr, publicRepo, branchName });
  const metadataOnlyAction = internalPr && metadataAction && !legacyNeedsRebuild;

  if (legacyNeedsRebuild) {
    console.log(
      `Bridge: public PR #${publicPr.number} head ${publicPr.head.sha} has a legacy import; rebuilding after approval.`,
    );
  }

  let hasStagedChanges = false;
  let hasConflicts = false;
  if (!metadataOnlyAction) {
    run('git', ['-C', internalRepoDir, 'fetch', 'origin', internalBaseRef, '--prune']);
    run('git', ['-C', internalRepoDir, 'checkout', '-B', branchName, `origin/${internalBaseRef}`]);

    const sourceRemote = `bridge-public-${publicPrNumber}`;
    const sourceBaseRef = `refs/remotes/${sourceRemote}/pr-base`;
    const sourceHeadRef = `refs/remotes/${sourceRemote}/pr-head`;
    const publicRepoUrl = `https://x-access-token:${publicToken}@github.com/${publicRepo}.git`;
    const publicHeadRepo = publicPr.head.repo?.full_name ?? publicRepo;
    const publicHeadRepoUrl = `https://x-access-token:${publicToken}@github.com/${publicHeadRepo}.git`;

    try {
      run('git', ['-C', internalRepoDir, 'remote', 'remove', sourceRemote]);
    } catch {}
    run('git', ['-C', internalRepoDir, 'remote', 'add', sourceRemote, publicRepoUrl]);

    try {
      try {
        run('git', [
          '-C',
          internalRepoDir,
          'fetch',
          '--no-tags',
          sourceRemote,
          `+refs/pull/${publicPrNumber}/head:${sourceHeadRef}`,
          `+refs/heads/${publicPr.base.ref}:${sourceBaseRef}`,
        ]);
      } catch (error) {
        console.warn(`Bridge: public PR refs were unavailable: ${error.message}`);
      }

      fetchSourceCommit({
        internalRepoDir,
        remoteUrl: publicRepoUrl,
        sha: publicPr.base.sha,
        role: 'base',
      });
      fetchSourceCommit({
        internalRepoDir,
        remoteUrl: publicHeadRepoUrl,
        sha: publicPr.head.sha,
        role: 'head',
      });
      const rawPatch = diffRecordedPublicCommits(
        internalRepoDir,
        publicPr.base.sha,
        publicPr.head.sha,
      );
      const excludedPrefixes = parseJsonEnv('BRIDGE_EXCLUDED_PATHS', []);
      const patch = filterDiffByPath(rawPatch, excludedPrefixes);

      if (!patch.trim()) {
        console.log(
          `Bridge: public PR #${publicPr.number} head ${publicPr.head.sha} has no importable diff; no new import recorded.`,
        );
        return;
      }

      const tempDir = mkdtempSync(path.join(tmpdir(), 'public-pr-bridge-'));
      const patchFile = path.join(tempDir, 'public-pr.patch');
      writeFileSync(patchFile, prefixPatchPaths(patch, mirrorPath, pathRewrites), 'utf8');

      try {
        const applyResult = applyPatchWithConflictDetection(internalRepoDir, patchFile);

        if (applyResult.outcome === 'failed') {
          throw new Error(applyResult.message || 'git apply failed');
        }

        hasConflicts = applyResult.outcome === 'conflicts';

        if (hasConflicts) {
          run('git', ['-C', internalRepoDir, 'add', '-A']);
        }

        hasStagedChanges = (() => {
          try {
            run('git', ['-C', internalRepoDir, 'diff', '--cached', '--quiet']);
            return false;
          } catch {
            return true;
          }
        })();

        if (hasStagedChanges) {
          run('git', ['-C', internalRepoDir, 'config', 'user.name', OSS_SYNC_BOT_NAME]);
          run('git', ['-C', internalRepoDir, 'config', 'user.email', OSS_SYNC_BOT_EMAIL]);

          let publicCommits = [];
          try {
            publicCommits = await listPublicPrCommits({
              token: publicToken,
              repo: publicRepo,
              prNumber: publicPr.number,
            });
          } catch (error) {
            console.warn(
              `Bridge: could not fetch public PR commits for message context: ${error.message}`,
            );
          }
          const { body: commitBody } = buildCommitAttribution({
            commitAuthors: [publicPrAuthor(publicPr)],
            commitMessages: publicCommits,
            publicRepo,
          });
          const commitMessage = bridgeCommitSubject({ publicRepo, publicPr, hasConflicts });
          run('git', [
            '-C',
            internalRepoDir,
            'commit',
            '--cleanup=verbatim',
            '-m',
            commitMessage,
            '-m',
            commitBody,
          ]);

          run('git', [
            '-C',
            internalRepoDir,
            'push',
            '--force-with-lease',
            '--set-upstream',
            'origin',
            branchName,
          ]);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } finally {
      try {
        run('git', ['-C', internalRepoDir, 'remote', 'remove', sourceRemote]);
      } catch {}
    }

    internalPr = await findOpenInternalPr({
      token: internalToken,
      repo: internalRepo,
      owner: internalOwner,
      branchName,
    });

    if (!internalPr && !hasStagedChanges) {
      console.log(
        `Bridge: public PR #${publicPr.number} head ${publicPr.head.sha} produced no staged change; no import recorded.`,
      );
      return;
    }
  }

  if (
    !hasStagedChanges &&
    internalPr &&
    !importedHeadMatches({ internalPr, publicPr, publicRepo, branchName })
  ) {
    const reason = metadataOnlyAction
      ? 'recorded import does not match the current heads'
      : 'produced no staged change and has no matching import';
    console.log(
      `Bridge: public PR #${publicPr.number} head ${publicPr.head.sha} ${reason}; no new receipt recorded.`,
    );
    return;
  }

  if (metadataOnlyAction && internalPr) {
    const headCommit = await githubRequest({
      token: internalToken,
      path: `/repos/${internalRepo}/commits/${internalPr.head.sha}`,
    });
    if (headCommit?.commit?.message == null) {
      console.warn(
        `Bridge: missing commit message for ${internalPr.head.sha}; conflict hold not re-derived on metadata re-sync.`,
      );
    }
    hasConflicts = commitIndicatesConflicts(headCommit?.commit?.message);
  }

  const internalHeadSha = hasStagedChanges
    ? run('git', ['-C', internalRepoDir, 'rev-parse', 'HEAD'])
    : internalPr.head.sha;
  const currentPublicPr = await githubRequest({
    token: publicToken,
    path: `/repos/${publicRepo}/pulls/${publicPr.number}`,
  });
  if (currentPublicPr.state !== 'open' || currentPublicPr.head.sha !== publicPr.head.sha) {
    console.log(
      `Bridge: public PR #${publicPr.number} head ${publicPr.head.sha} changed during sync; no matching receipt recorded.`,
    );
    if (hasStagedChanges) {
      await createClaGateGh({
        publicToken,
        publicRepo,
        internalToken,
        internalRepo,
      }).setVerifiedStatus(
        { head: { sha: internalHeadSha } },
        'failure',
        'Public head changed during sync; awaiting the next approved sync.',
      );
    }
    return;
  }
  const title = internalPullRequestTitle(currentPublicPr);
  const body = buildInternalPrBody({
    publicPr: currentPublicPr,
    branchName,
    mirrorPath,
    internalHeadSha,
  });

  if (internalPr) {
    internalPr = await githubRequest({
      token: internalToken,
      method: 'PATCH',
      path: `/repos/${internalRepo}/pulls/${internalPr.number}`,
      body: { title, body },
    });
  } else {
    internalPr = await githubRequest({
      token: internalToken,
      method: 'POST',
      path: `/repos/${internalRepo}/pulls`,
      body: {
        title,
        head: branchName,
        base: internalBaseRef,
        body,
        draft: currentPublicPr.draft,
      },
    });
  }

  internalPr.head.sha = internalHeadSha;

  await applyClaGate({
    gh: createClaGateGh({ publicToken, publicRepo, internalToken, internalRepo }),
    publicPr: currentPublicPr,
    internalPr,
    forceDraft: hasConflicts,
  });
  console.log(
    `Bridge: applied CLA gate for public PR #${publicPr.number} head ${publicPr.head.sha}.`,
  );
}

async function closeLinkedInternalPr() {
  const publicToken = requireEnv('PUBLIC_TOKEN');
  const internalToken = requireEnv('INTERNAL_TOKEN');
  const publicRepo = requireEnv('PUBLIC_REPO');
  const internalRepo = requireEnv('INTERNAL_REPO');
  const internalBranchPrefix = requireEnv('INTERNAL_BRANCH_PREFIX');
  const publicPrNumber = Number.parseInt(requireEnv('PUBLIC_PR_NUMBER'), 10);
  const internalOwner = internalRepo.split('/')[0];
  const branchName = getPublicPrBranchName(internalBranchPrefix, publicPrNumber);

  const publicPr = await githubRequest({
    token: publicToken,
    path: `/repos/${publicRepo}/pulls/${publicPrNumber}`,
  });

  const internalPr = await findOpenInternalPr({
    token: internalToken,
    repo: internalRepo,
    owner: internalOwner,
    branchName,
  });

  if (!internalPr) {
    return;
  }

  if (publicPr.merged_at) {
    return;
  }

  await githubRequest({
    token: internalToken,
    method: 'POST',
    path: `/repos/${internalRepo}/issues/${internalPr.number}/comments`,
    body: {
      body: `Closing because the linked public PR [#${publicPr.number}](${publicPr.html_url}) was closed without merge.`,
    },
  });

  await githubRequest({
    token: internalToken,
    method: 'PATCH',
    path: `/repos/${internalRepo}/pulls/${internalPr.number}`,
    body: { state: 'closed' },
  });

  try {
    await githubRequest({
      token: internalToken,
      method: 'DELETE',
      path: `/repos/${internalRepo}/git/refs/heads/${branchName}`,
    });
  } catch {}
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'acknowledge') {
    await acknowledgePublicPr();
    return;
  }

  if (mode === 'sync') {
    await syncPublicPr();
    return;
  }

  if (mode === 'refresh-cla') {
    await refreshPublicPrCla();
    return;
  }

  if (mode === 'close') {
    await closeLinkedInternalPr();
    return;
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  applyPatchWithConflictDetection,
  bridgeCommitSubject,
  buildCommitAttribution,
  buildInternalPrBody,
  buildWelcomePublicComment,
  checkOrgMembership,
  commitIndicatesConflicts,
  createClaGateGh,
  listPublicPrCommits,
  normalizeGitHubUserAuthor,
  postCommitStatus,
  prefixPatchPaths,
  readCommitClaStatus,
  refreshPublicPrCla,
  syncPublicPr,
};
