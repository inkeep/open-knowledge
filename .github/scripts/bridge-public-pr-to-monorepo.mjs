import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyClaGate } from './cla-gate.mjs';

// Keep the public PR bridge copies code-shape aligned. They ship to
// separate public repos through Copybara, so they cannot import shared code.
// Sibling bridge copies:
// - public/agents/.github/scripts/bridge-public-pr-to-monorepo.mjs
// - public/agents-optional-local-dev/.github/scripts/bridge-public-pr-to-monorepo.mjs
// The Open Knowledge copy additionally imports a co-located `cla-gate.mjs` for
// contributor-CLA enforcement — an OK-only divergence. That module ships to the
// same repo via Copybara, so the import resolves on the mirror; the "no shared
// code" rule still holds (no module is shared ACROSS the three repos).
// The OK copy also routes 3-way-apply conflicts to a draft maintainer PR rather
// than hard-failing (the OK mirror strips comments, so contributor patches
// conflict against the comment-rich internal tree); the sibling copies keep the
// hard-fail behavior. No drift check enforces shape alignment, so this OK-only
// divergence is intentional and scoped here.
const BRIDGE_COMMENT_MARKER = '<!-- monorepo-pr-bridge -->';
const OSS_SYNC_BOT_NAME = 'inkeep-oss-sync[bot]';
const OSS_SYNC_BOT_EMAIL = '274976938+inkeep-oss-sync[bot]@users.noreply.github.com';

// Strip x-access-token credentials from any string that might end up in an
// error message, log line, or thrown exception. GitHub Actions masks repo
// secrets in its own job log, but this script's exceptions can also surface
// in PR comments (`buildPublicComment` failed-state path), failure-alert
// issues, or future error-reporting integrations — none of which inherit the
// Actions log mask. Defense-in-depth: redact at the boundary so token leakage
// is impossible regardless of where the message ends up.
function sanitizeErrorMessage(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/https:\/\/x-access-token:[^@\s]+@/g, 'https://x-access-token:***@');
}

function run(command, args, options = {}) {
  // Drop inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE: every git spawn in
  // this script targets an explicit clone/worktree via cwd, never the repo a
  // calling git hook belongs to. In CI these variables are unset (no-op);
  // locally they leak from pre-push/pre-commit hooks into harnesses that
  // import this module (the bridge canary) and break explicit-cwd git.
  // Sanitize AFTER merging a caller-supplied env so the guarantee is
  // unconditional — an options.env override must not reintroduce the vars.
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_INDEX_FILE: _i,
    ...cleanEnv
  } = { ...process.env, ...options.env };
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
      env: cleanEnv,
    }).trim();
  } catch (error) {
    const stderr = sanitizeErrorMessage(error.stderr?.toString().trim() ?? '');
    const stdout = sanitizeErrorMessage(error.stdout?.toString().trim() ?? '');
    const details = [stderr, stdout].filter(Boolean).join('\n');
    const fallback = sanitizeErrorMessage(`${command} ${args.join(' ')} failed`);
    throw new Error(details || fallback);
  }
}

async function githubRequest({
  token,
  method = 'GET',
  path: requestPath,
  body,
  accept = 'application/vnd.github+json',
}) {
  const response = await fetch(`https://api.github.com${requestPath}`, {
    method,
    headers: {
      Accept: accept,
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

  // .patch and .diff return raw text, not JSON. All other accept types
  // (incl. the default application/vnd.github+json) return JSON.
  const isTextResponse =
    accept === 'application/vnd.github.patch' || accept === 'application/vnd.github.diff';
  return isTextResponse ? text : text ? JSON.parse(text) : null;
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

// True when a `githubRequest` failed because the PR diff exceeds GitHub's
// hard cap on the diff endpoint (currently 20,000 lines). The API surfaces
// this as a 406 with body `diff exceeded the maximum number of lines (20000)`,
// or a JSON error with `diff_too_large` in the message. Detect by message
// text since we don't preserve the HTTP status separately. The patterns are
// kept narrow on purpose: a bare `too_large` would also match unrelated 422s
// (e.g. PR body validation `{"code":"too_long"}` is adjacent — `too_large`
// itself is rare for non-diff endpoints, but we don't rely on coincidence).
function isDiffTooLargeError(error) {
  if (!error || typeof error.message !== 'string') return false;
  return /diff exceeded the maximum number of lines|diff is too large|diff_too_large/i.test(
    error.message,
  );
}

// Compute the PR's diff locally from the public PR refs that syncPublicPr has
// already fetched into agents-private's object store. 3-dot diff mirrors
// GitHub's `.diff` semantics (compares against merge-base). Used as the
// fallback when the API rejects the PR as too large; also implicitly helps
// `git apply --3way` later because the same fetch made the patch's base blobs
// reachable in agents-private's clone.
//
// maxBuffer is bumped to 50 MB because this fallback fires specifically for
// oversized PRs (>20,000 lines on the API endpoint). Node's default 1 MB
// would truncate the very diffs this path is meant to handle.
function fetchPullRequestDiffViaLocalGit({ internalRepoDir, sourceBaseRef, sourceHeadRef }) {
  return run('git', ['-C', internalRepoDir, 'diff', `${sourceBaseRef}...${sourceHeadRef}`], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function fetchPullRequestDiff({
  publicToken,
  publicRepo,
  publicPr,
  internalRepoDir,
  sourceBaseRef,
  sourceHeadRef,
  refsFetched,
}) {
  try {
    return await githubRequest({
      token: publicToken,
      path: `/repos/${publicRepo}/pulls/${publicPr.number}`,
      accept: 'application/vnd.github.diff',
    });
  } catch (error) {
    if (!isDiffTooLargeError(error)) throw error;
    if (!refsFetched) {
      throw new Error(
        `Bridge: cannot use local-git-diff fallback for PR #${publicPr.number} — ` +
          `the public PR refs failed to fetch into agents-private earlier in this run. ` +
          `See the preceding "Bridge: fetch at --depth=..." warning for the original ` +
          `fetch failure; resolve that and re-run.`,
      );
    }
    console.log(
      `Bridge: GitHub diff API rejected PR #${publicPr.number} as too large; ` +
        'falling back to local git diff against fetched public PR refs.',
    );
    return fetchPullRequestDiffViaLocalGit({ internalRepoDir, sourceBaseRef, sourceHeadRef });
  }
}

// Drop diff sections whose old or new path matches any excluded prefix.
// Excluded paths are relative to the PUBLIC repo root (pre-prefix). Used to
// stop pre-cutover branches from re-introducing internal-only paths
// (`specs/`, `reports/`, `.codex/`, etc.) that the public mirror no longer
// exports — those paths exist on agents-private's side but should not flow
// back through the bridge.
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

    // Reject path traversal attempts
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

function buildBridgeMetadata(publicPr, mirrorPath) {
  return [
    '<!-- public-pr-sync',
    `public_repo=${publicPr.base.repo.full_name}`,
    `public_pr_number=${publicPr.number}`,
    `public_pr_url=${publicPr.html_url}`,
    `public_author_login=${publicPr.user.login}`,
    `public_author_id=${publicPr.user.id}`,
    `mirror_path=${mirrorPath}`,
    '-->',
  ].join('\n');
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

// GitHub PR body hard limit. Exceeding returns 422 "body is too long".
const GITHUB_PR_BODY_LIMIT = 65536;

function buildInternalPrBody({ publicPr, branchName, mirrorPath }) {
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

${buildBridgeMetadata(publicPr, mirrorPath)}`;

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

function buildPublicComment({ publicPr, status, details }) {
  if (status === 'synced') {
    return `${BRIDGE_COMMENT_MARKER}
Thanks for the contribution! A maintainer will review and merge your PR. Your commit attribution is preserved as @${publicPr.user.login}.

**What happens next:**

- A maintainer will review your PR.
- If you don't hear back within a few business days, please comment here to nudge — that's the right thing to do, not annoying.
- When your change is accepted, this PR closes automatically. Don't be alarmed when it closes — that's how it merges, and your authorship is preserved.

This comment will be updated as the status changes.`;
  }

  if (status === 'no-op') {
    return `${BRIDGE_COMMENT_MARKER}
I checked this PR, but there was no new change to sync.

${details}`;
  }

  if (status === 'closed') {
    return `${BRIDGE_COMMENT_MARKER}
This PR was closed without merging.

${details}`;
  }

  if (status === 'merged-upstream') {
    return `${BRIDGE_COMMENT_MARKER}
This PR was merged directly here. A maintainer will make sure the change is reconciled on our side.

${details}`;
  }

  if (status === 'conflicts') {
    return `${BRIDGE_COMMENT_MARKER}
Thanks for the contribution! Your PR **could not be merged automatically**: it overlaps other changes that aren't visible here, so a maintainer needs to reconcile it by hand.

**No action is needed from you.** Your PR is already based on the latest \`${publicPr.base.repo.full_name}\` main; the overlap is on our side, not something to fix from your branch. Your commit attribution is preserved as @${publicPr.user.login}.

A maintainer will resolve it and land your change; this PR will close automatically once it merges. This comment will be updated as the status changes.`;
  }

  return `${BRIDGE_COMMENT_MARKER}
I could not sync this PR automatically. A maintainer will look into it.

${details}`;
}

async function upsertIssueComment({ token, repo, issueNumber, body }) {
  // Paginate to find the bridge comment (handles PRs with 100+ comments)
  let comments = [];
  let page = 1;
  while (true) {
    const batch = await githubRequest({
      token,
      path: `/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    });
    comments = comments.concat(batch);
    if (batch.length < 100) break;
    page++;
  }

  const existing = comments.find((comment) => comment.body?.includes(BRIDGE_COMMENT_MARKER));
  if (existing) {
    await githubRequest({
      token,
      method: 'PATCH',
      path: `/repos/${repo}/issues/comments/${existing.id}`,
      body: { body },
    });
    return existing.html_url;
  }

  const created = await githubRequest({
    token,
    method: 'POST',
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    body: { body },
  });
  return created.html_url;
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

// Read the `license/cla` combined-status state on a commit (cla-assistant posts
// it on the public PR head). Returns null when the context is absent.
//
// `?per_page=100` raises the embedded-statuses ceiling from GitHub's default of
// 30 to the documented max. The combined-status array holds the latest status
// per context, so a commit would need >100 distinct status contexts before
// `license/cla` could fall off the first page — at which point the gate would
// read null and fail closed (a false hold), never falsely release. The sibling
// `upsertIssueComment` paginates the same way.
async function readCommitClaStatus({ token, repo, sha, request = githubRequest }) {
  const result = await request({
    token,
    path: `/repos/${repo}/commits/${sha}/status?per_page=100`,
  });
  const cla = (result.statuses ?? []).find((s) => s.context === 'license/cla');
  return cla ? cla.state : null;
}

// Check org membership for a public-PR author. GitHub returns 204 for a member
// and 404 for a non-member (or a membership this token cannot see). Real errors
// — a 403 when the bridge App lacks `members:read`, or a 5xx — propagate so
// `applyClaGate` fails closed rather than treating an outage as "not a member".
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

// Post a commit status — used for the bridge's own `cla/verified` context on the
// internal PR head, the signal the agents-private branch ruleset requires.
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

// Build the GitHub adapter `applyClaGate` consumes. Extracted so the wiring —
// which token/repo each call uses, and the `cla/verified` context the
// agents-private ruleset requires — is testable in isolation rather than buried
// in `syncPublicPr`. `request` is injectable for hermetic tests; production
// uses the module's `githubRequest`.
function createClaGateGh({
  publicToken,
  publicRepo,
  internalToken,
  internalRepo,
  request = githubRequest,
}) {
  // Membership is checked against the org that owns the internal repo (inkeep),
  // on the internal App token — the only credential that can carry
  // `members:read`. The public Actions token cannot read org membership.
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

// Marker appended to the bridge's mirror commit when the 3-way apply left
// conflicts, so the conflict draft-hold survives a metadata-only re-sync (where
// the apply block is skipped) instead of being silently lost.
const CONFLICT_COMMIT_MARKER = 'with conflicts; needs manual resolution';

// True when an internal mirror commit message marks a conflict-carrying bridge
// commit (see CONFLICT_COMMIT_MARKER), used to keep that PR held draft across
// metadata-only re-syncs.
function commitIndicatesConflicts(commitMessage) {
  return typeof commitMessage === 'string' && commitMessage.includes(CONFLICT_COMMIT_MARKER);
}

// Apply the prefixed PR patch onto the internal checkout and classify the
// outcome. `git apply --index --3way` exits non-zero BOTH when the patch cannot
// apply at all AND when it applies but leaves conflict markers, so the exit code
// alone can't tell a genuine failure from a conflict a maintainer can resolve.
// Distinguish them by the index: a 3-way merge that conflicted leaves unmerged
// (stage > 0) entries; a genuine non-apply leaves none.
//   - 'clean'     — applied with no conflicts (exit 0)
//   - 'conflicts' — applied WITH conflict markers (unmerged entries present)
//   - 'failed'    — could not apply (no unmerged entries); `message` carries the
//                   sanitized git output for the contributor-facing comment
function applyPatchWithConflictDetection(internalRepoDir, patchFile) {
  try {
    run('git', ['-C', internalRepoDir, 'apply', '--index', '--3way', patchFile]);
    return { outcome: 'clean', conflictedPaths: [], message: '' };
  } catch (error) {
    // `run()` has already stripped any x-access-token URL from error.message.
    // Guard the unmerged-index probe: if even it throws (corrupt/locked index),
    // fall through to 'failed' rather than escaping the classifier. Fail-closed,
    // never route a real error as a resolvable conflict.
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
      // Fail-closed routing to 'failed' is still correct, but surface the probe
      // failure so a maintainer can tell "no unmerged entries" from "probe broke".
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

  const metadataOnlyAction =
    internalPr &&
    (publicPrAction === 'edited' ||
      publicPrAction === 'ready_for_review' ||
      publicPrAction === 'converted_to_draft');

  let hasStagedChanges = false;
  let hasConflicts = false;
  if (!metadataOnlyAction) {
    // Bring agents-private's main into the local clone and check out the new
    // branch first. We need this in place before the public-PR-refs fetch so
    // any blob already on main is deduplicated; we also need it before
    // `git apply --3way` (later) regardless.
    run('git', ['-C', internalRepoDir, 'fetch', 'origin', internalBaseRef, '--prune']);
    run('git', ['-C', internalRepoDir, 'checkout', '-B', branchName, `origin/${internalBaseRef}`]);

    // Fetch the public PR's base + head into agents-private's object store.
    // Two purposes:
    //   1. `git apply --3way` resolves the patch's base blobs locally even
    //      when public-mirror-sync is stalled and agents-private/main has
    //      drifted from `inkeep/<repo>/main`. Without this, every conflicting
    //      hunk fails with "repository lacks the necessary blob to perform
    //      3-way merge" — the dominant bridge-failure pattern observed on
    //      `inkeep/open-knowledge-legacy#411`, `#396`, `#374`.
    //   2. Provides the baseline pair of refs for the local-git-diff fallback
    //      when the GitHub diff endpoint rejects the PR as too large.
    const sourceRemote = `bridge-public-${publicPrNumber}`;
    const sourceBaseRef = `refs/remotes/${sourceRemote}/pr-base`;
    const sourceHeadRef = `refs/remotes/${sourceRemote}/pr-head`;
    const publicRepoUrl = `https://x-access-token:${publicToken}@github.com/${publicRepo}.git`;

    try {
      run('git', ['-C', internalRepoDir, 'remote', 'remove', sourceRemote]);
    } catch {
      // remote did not exist; harmless
    }
    run('git', ['-C', internalRepoDir, 'remote', 'add', sourceRemote, publicRepoUrl]);

    try {
      // Initial fetch: --depth=10000 covers the long-running branches that
      // trip the size-fallback (e.g. inkeep/open-knowledge-legacy#377 with 78
      // commits). On the rare branch whose merge-base is deeper, the
      // subsequent `git diff base...head` errors clearly with "no merge
      // base" rather than producing a wrong diff — so we re-fetch with
      // increasing depth before giving up.
      let refsFetched = false;
      for (const depth of [10000, 50000]) {
        try {
          run('git', [
            '-C',
            internalRepoDir,
            'fetch',
            '--no-tags',
            `--depth=${depth}`,
            sourceRemote,
            `+refs/pull/${publicPrNumber}/head:${sourceHeadRef}`,
            `+refs/heads/${publicPr.base.ref}:${sourceBaseRef}`,
          ]);
          refsFetched = true;
          break;
        } catch (error) {
          console.log(
            `Bridge: fetch at --depth=${depth} failed: ${error.message}. ` +
              `Retrying with deeper history if available.`,
          );
        }
      }
      if (!refsFetched) {
        console.log(
          'Bridge: warning: could not fetch public PR refs into agents-private at any depth. ' +
            "Continuing — `git apply --3way` will still succeed if the public mirror's blobs already match agents-private/main, " +
            'but the local-git-diff fallback for oversized PRs will not be available.',
        );
      }

      // Use .diff (unified squash diff) not .patch (multi-commit mailbox
      // format). .patch returns one patch per PR commit, each with
      // intermediate blob SHAs that only exist in inkeep/agents' object
      // store; any conflicting hunk forces git apply --3way to look up
      // those intermediates and fail with "repository lacks the necessary
      // blob". .diff is a single base-vs-head diff — no intermediates,
      // only the PR base blobs are referenced.
      //
      // For PRs whose .diff exceeds GitHub's 20,000-line endpoint cap,
      // fetchPullRequestDiff falls back to a local 3-dot `git diff`
      // against the refs we just fetched.
      const rawPatch = await fetchPullRequestDiff({
        publicToken,
        publicRepo,
        publicPr,
        internalRepoDir,
        sourceBaseRef,
        sourceHeadRef,
        refsFetched,
      });
      const excludedPrefixes = parseJsonEnv('BRIDGE_EXCLUDED_PATHS', []);
      const patch = filterDiffByPath(rawPatch, excludedPrefixes);

      if (!patch.trim()) {
        const details =
          rawPatch.trim() && excludedPrefixes.length > 0
            ? `Every diff section matched an excluded path prefix (\`${excludedPrefixes.join('`, `')}\`), so there was nothing left to port.`
            : 'GitHub returned an empty patch, so there was nothing to port.';
        await upsertIssueComment({
          token: publicToken,
          repo: publicRepo,
          issueNumber: publicPrNumber,
          body: buildPublicComment({
            publicPr,
            status: 'no-op',
            details,
          }),
        });
        return;
      }

      const tempDir = mkdtempSync(path.join(tmpdir(), 'public-pr-bridge-'));
      const patchFile = path.join(tempDir, 'public-pr.patch');
      writeFileSync(patchFile, prefixPatchPaths(patch, mirrorPath, pathRewrites), 'utf8');

      try {
        const applyResult = applyPatchWithConflictDetection(internalRepoDir, patchFile);

        if (applyResult.outcome === 'failed') {
          // Genuine non-apply (not a resolvable conflict) — surface it and fail.
          // `run()` sanitized the git output, so it's safe to include; it makes
          // the failure actionable. NOT a "rebase" case: the contributor is
          // already on the latest public base — this is a bridge-side problem.
          // Wrap the comment post so a GitHub API failure here can't mask the
          // actual git apply diagnostic in the error thrown below.
          try {
            await upsertIssueComment({
              token: publicToken,
              repo: publicRepo,
              issueNumber: publicPrNumber,
              body: buildPublicComment({
                publicPr,
                status: 'failed',
                details:
                  'The diff could not be applied on our side. This is a ' +
                  'bridge-side issue, not a problem with your PR (which is already based ' +
                  'on the latest public base); a maintainer will look into it.' +
                  `\n\n\`\`\`\n${applyResult.message}\n\`\`\``,
              }),
            });
          } catch (commentError) {
            console.warn(
              `Bridge: could not post 'failed' comment to public PR: ${commentError.message}`,
            );
          }
          throw new Error(applyResult.message || 'git apply failed');
        }

        hasConflicts = applyResult.outcome === 'conflicts';

        // A conflicted 3-way apply leaves unmerged (stage > 0) entries with
        // conflict markers in the working tree; `git apply --index` already
        // staged the cleanly-merged files. Stage the marker versions too so the
        // commit captures the full state for a maintainer to resolve on the
        // internal PR (the markers make it un-mergeable; it's held draft below).
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
      // Always tear down the bridge-public remote, even on early return or
      // throw, so subsequent runs (or a retry of the same PR) start clean.
      try {
        run('git', ['-C', internalRepoDir, 'remote', 'remove', sourceRemote]);
      } catch {
        // best-effort
      }
    }

    internalPr = await findOpenInternalPr({
      token: internalToken,
      repo: internalRepo,
      owner: internalOwner,
      branchName,
    });

    if (!internalPr && !hasStagedChanges) {
      await upsertIssueComment({
        token: publicToken,
        repo: publicRepo,
        issueNumber: publicPrNumber,
        body: buildPublicComment({
          publicPr,
          status: 'no-op',
          details: 'The change already appears to be present, so there was nothing new to sync.',
        }),
      });
      return;
    }
  }

  // On a metadata-only re-sync (edited / ready_for_review / converted_to_draft)
  // the apply block above is skipped, so `hasConflicts` is still its initial
  // false even for a PR previously bridged with conflicts. Re-derive the conflict
  // hold from the existing internal PR's head-commit marker, otherwise a metadata
  // event (e.g. the contributor editing their PR body) would un-draft a
  // conflict-carrying PR and overwrite its comment with 'synced'.
  if (metadataOnlyAction && internalPr) {
    const headCommit = await githubRequest({
      token: internalToken,
      path: `/repos/${internalRepo}/commits/${internalPr.head.sha}`,
    });
    if (headCommit?.commit?.message == null) {
      // A structurally unexpected 200 (no commit message) would silently default
      // hasConflicts to false and un-draft a conflict-carrying PR. The endpoint is
      // stable so this is defensive, but make the implicit fail-open observable.
      console.warn(
        `Bridge: missing commit message for ${internalPr.head.sha}; conflict hold not re-derived on metadata re-sync.`,
      );
    }
    hasConflicts = commitIndicatesConflicts(headCommit?.commit?.message);
  }

  const title = internalPullRequestTitle(publicPr);
  const body = buildInternalPrBody({ publicPr, branchName, mirrorPath });

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
        draft: publicPr.draft,
      },
    });
  }

  // Enforce the contributor CLA. cla-assistant posts `license/cla` on the public
  // PR, but the bridge re-commits under a new SHA here, so that status can't gate
  // the internal PR directly. Hold the internal PR (draft + a failing
  // `cla/verified` status) until signed, re-checked on every sync. This also
  // takes over draft-state mirroring: shouldBeDraft = publicPr.draft || gated ||
  // hasConflicts (a conflict-carrying PR must stay a draft until reconciled).
  await applyClaGate({
    gh: createClaGateGh({ publicToken, publicRepo, internalToken, internalRepo }),
    publicPr,
    internalPr,
    forceDraft: hasConflicts,
  });

  await upsertIssueComment({
    token: publicToken,
    repo: publicRepo,
    issueNumber: publicPrNumber,
    body: buildPublicComment({
      publicPr,
      internalPr,
      status: hasConflicts ? 'conflicts' : 'synced',
    }),
  });
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
    await upsertIssueComment({
      token: publicToken,
      repo: publicRepo,
      issueNumber: publicPrNumber,
      body: buildPublicComment({
        publicPr,
        internalPr,
        status: 'merged-upstream',
        details: '',
      }),
    });
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

  // Clean up the stale branch on agents-private
  try {
    await githubRequest({
      token: internalToken,
      method: 'DELETE',
      path: `/repos/${internalRepo}/git/refs/heads/${branchName}`,
    });
  } catch {
    // Branch may already be deleted or protected
  }

  await upsertIssueComment({
    token: publicToken,
    repo: publicRepo,
    issueNumber: publicPrNumber,
    body: buildPublicComment({
      publicPr,
      status: 'closed',
      details: '',
    }),
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'sync') {
    await syncPublicPr();
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
  buildPublicComment,
  checkOrgMembership,
  commitIndicatesConflicts,
  createClaGateGh,
  listPublicPrCommits,
  normalizeGitHubUserAuthor,
  postCommitStatus,
  prefixPatchPaths,
  readCommitClaStatus,
  // Exported solely for the metadata-event composition test.
  syncPublicPr,
};
