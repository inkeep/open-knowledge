#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  firstContainingStableTag,
  parseFixRef,
  parseGitOriginRevIds,
  realReleaseTags,
  resolvePrivateSha,
  resolveShippedVersion,
  sortReleaseTagsAscending,
  sortStableTagsAscending,
} from './resolve-shipped-version.mjs';
import {
  compareVersions,
  composeReply,
  evaluateFanIn,
  isOriginRepliableFrom,
  markerSuffixFor,
  partitionAttachments,
} from './write-back-gate.mjs';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const RELEASES_TAG_BASE = 'https://github.com/inkeep/open-knowledge/releases/tag';
const DEFAULT_PRIVATE_REPO = 'inkeep/agents-private';
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const PAGE_SIZE = 50;

export const CANDIDATE_QUERY = `
  query WriteBackCandidates($after: String) {
    issues(
      first: ${PAGE_SIZE}
      after: $after
      filter: { state: { type: { eq: "completed" } } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        state { type }
        labels { nodes { name } }
        attachments { nodes { url } }
      }
    }
  }
`;

export const CHILDREN_QUERY = `
  query WriteBackChildren($parentId: ID!, $after: String) {
    issues(first: ${PAGE_SIZE}, after: $after, filter: { parent: { id: { eq: $parentId } } }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        state { type }
        labels { nodes { name } }
        attachments { nodes { url } }
      }
    }
  }
`;

export function notificationMarkerUrl({ version, originUrl }) {
  const v = String(version ?? '')
    .trim()
    .replace(/^v/, '');
  if (!v) throw new Error('notificationMarkerUrl needs a version');
  if (!String(originUrl ?? '').trim()) throw new Error('notificationMarkerUrl needs an origin url');
  return `${RELEASES_TAG_BASE}/v${v}${markerSuffixFor(originUrl)}`;
}

export function isFixRepoInRemit({ kind, owner, repo }, { defaultRepo = DEFAULT_PRIVATE_REPO, selfRepo } = {}) {
  if (kind === 'sha') return true;
  const target = `${owner}/${repo}`.toLowerCase();
  const reachable = [defaultRepo, selfRepo]
    .map((r) => String(r ?? '').trim().toLowerCase())
    .filter(Boolean);
  return reachable.includes(target);
}

export function isSelfRepoPr({ kind, owner, repo }, selfRepo, defaultRepo = DEFAULT_PRIVATE_REPO) {
  if (kind !== 'pr') return false;
  const self = String(selfRepo ?? '').trim().toLowerCase();
  if (!self || self === String(defaultRepo ?? '').trim().toLowerCase()) return false;
  return self === `${owner}/${repo}`.toLowerCase();
}

export function deriveVersionForFixRefs({
  fixReferences = [],
  stableTags,
  findMirroredCommits,
  contains,
  resolvePrMergeSha,
  readCommitMessage = () => null,
  defaultRepo = DEFAULT_PRIVATE_REPO,
  selfRepo = process.env.GITHUB_REPOSITORY,
  channel = 'stable',
  log = () => {},
}) {
  const usable = fixReferences.filter((ref) => ref.channel !== 'commit' || FULL_SHA_RE.test(ref.sha ?? ''));
  if (usable.length === 0) return null;

  let highest = null;
  for (const ref of usable) {
    const parsed = parseFixRef(ref.channel === 'commit' ? ref.sha : ref.url, { defaultRepo });
    if (!isFixRepoInRemit(parsed, { defaultRepo, selfRepo })) {
      log(
        `::notice::write-back: ${ref.url} lives in ${parsed.owner}/${parsed.repo}, which is outside this ` +
          'workflow\'s reach; no version can be derived for it.',
      );
      return null;
    }
    const refSha = resolvePrivateSha(parsed, { resolvePrMergeSha });
    if (!refSha) {
      log(`::notice::write-back: ${ref.url} was closed without merging, so it carries no fix commit.`);
      return null;
    }
    let result;
    if (isSelfRepoPr(parsed, selfRepo, defaultRepo)) {
      const revIds = parseGitOriginRevIds(readCommitMessage(refSha) ?? '');
      if (revIds.length === 1) {
        result = resolveShippedVersion({
          privateSha: revIds[0],
          stableTags,
          findMirroredCommits,
          contains,
          channel,
        });
      } else {
        log(
          `::notice::write-back: ${ref.url} merges a commit with ${revIds.length === 0 ? 'no' : 'more than one'} ` +
            'origin trailer; falling back to direct tag containment of the merge commit itself.',
        );
        const sortedTags =
          channel === 'beta'
            ? sortReleaseTagsAscending(stableTags)
            : sortStableTagsAscending(stableTags);
        const tag = firstContainingStableTag({
          sortedStableTags: sortedTags,
          sha: refSha,
          contains,
        });
        result = tag
          ? { shipped: true, version: tag.replace(/^v/, ''), tag }
          : {
              shipped: false,
              reason: channel === 'beta' ? 'not-in-any-release' : 'not-in-any-stable',
            };
      }
    } else {
      result = resolveShippedVersion({
        privateSha: refSha,
        stableTags,
        findMirroredCommits,
        contains,
        channel,
      });
    }
    if (!result.shipped) {
      log(
        `::notice::write-back: ${ref.url} has not reached a ${channel === 'beta' ? 'released build' : 'stable release'} ` +
          `yet (${result.reason}).`,
      );
      return null;
    }
    if (highest === null || compareVersions(result.version, highest) > 0) highest = result.version;
  }
  return highest;
}


export const DEFAULT_RELEASE_LOOKBACK = 3;

export const DEFAULT_BETA_LOOKBACK = 10;

export function deriveChannel(releaseTag) {
  const tag = String(releaseTag ?? '').trim();
  if (STABLE_TAG_RE.test(tag)) return 'stable';
  if (/^v\d+\.\d+\.\d+-beta\.\d+$/.test(tag)) return 'beta';
  return null;
}

export function isStableVersion(raw) {
  return /^\d+\.\d+\.\d+$/.test(
    String(raw ?? '')
      .trim()
      .replace(/^v/, ''),
  );
}

function normalizeVersion(raw) {
  const trimmed = String(raw ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(trimmed) ? trimmed : null;
}

export function makeReleaseWindow({ releaseTag, stableTags = [], channel, lookback }) {
  const release = normalizeVersion(releaseTag);
  if (!release) {
    throw new Error(
      `RELEASE_TAG must be a release tag of this cadence, v0.36.0 or v0.36.0-beta.3 ` +
        `(got ${JSON.stringify(releaseTag)}). ` +
        'Refusing to run: with no release to scope against, every shipped fix in history is a candidate.',
    );
  }
  const resolvedChannel = channel ?? (isStableVersion(release) ? 'stable' : 'beta');
  const resolvedLookback =
    lookback ?? (resolvedChannel === 'beta' ? DEFAULT_BETA_LOOKBACK : DEFAULT_RELEASE_LOOKBACK);

  const eligible = resolvedChannel === 'beta' ? () => true : (version) => isStableVersion(version);
  const known = [
    ...new Set(stableTags.map(normalizeVersion).filter(Boolean).filter(eligible)),
  ].sort(compareVersions);
  const atOrBelow = known.filter((v) => compareVersions(v, release) <= 0);
  const floorIndex = atOrBelow.length - (resolvedLookback + 1) - 1;
  const floor = floorIndex >= 0 ? atOrBelow[floorIndex] : null;

  return (version) => {
    const shipped = normalizeVersion(version);
    if (!shipped) return 'unversioned';
    if (compareVersions(shipped, release) > 0) return 'not-yet-shipped';
    if (floor && compareVersions(shipped, floor) <= 0) return 'shipped-earlier';
    return 'in-window';
  };
}

export class NeedsHumanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsHumanError';
  }
}

export async function runWriteBack({
  listCandidates,
  listChildren,
  versionFor,
  readChangesetProse,
  postReply,
  recordNotification,
  classifyRelease,
  channel = 'stable',
  selfRepo = process.env.GITHUB_REPOSITORY,
  live = false,
  log = () => {},
}) {
  if (typeof classifyRelease !== 'function') {
    throw new Error('runWriteBack requires classifyRelease; see makeReleaseWindow.');
  }
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`runWriteBack requires channel 'stable' or 'beta', got '${channel}'`);
  }
  if (!String(selfRepo ?? '').trim()) {
    throw new Error(
      'runWriteBack requires selfRepo (GITHUB_REPOSITORY): without it no GitHub origin can be ' +
        'recognised as one this job may reply to, and every candidate would be skipped silently.',
    );
  }

  const posted = [];
  const skipped = [];
  const errored = [];
  const skip = (identifier, reason) => skipped.push({ identifier, reason });

  const processCandidate = async (candidate) => {
    const {
      origins: attachedOrigins,
      unrepliable,
      fixReferences,
    } = partitionAttachments(candidate.attachmentUrls ?? []);
    const origins = attachedOrigins.filter((origin) => isOriginRepliableFrom(origin, selfRepo));

    if (origins.length === 0 && unrepliable.length === 0) {
      if (attachedOrigins.length > 0) {
        log(
          `::debug::write-back: ${candidate.identifier} reports from ` +
            `${attachedOrigins.map((o) => o.url).join(', ')}, outside ${selfRepo || 'this repo'}; ` +
            'this job has no standing to post there.',
        );
        skip(candidate.identifier, 'origin-elsewhere');
      } else {
        skip(candidate.identifier, 'no-origin');
      }
      return;
    }

    const children = await listChildren(candidate.id);

    const considered = children.length > 0 ? children : [candidate];

    const versions = new Map();
    for (const node of considered) {
      versions.set(node.identifier, await versionFor(node));
    }

    const gate = evaluateFanIn({
      ticket: candidate,
      descendants: children,
      resolveVersion: (node) => versions.get(node.identifier) ?? null,
      log,
    });

    if (gate.decision !== 'notify') {
      if (gate.unresolved.length > 0) {
        const unresolvedWithRef = considered.filter(
          (node) =>
            gate.unresolved.includes(node.identifier) &&
            partitionAttachments(node.attachmentUrls ?? []).fixReferences.length > 0,
        );
        if (unresolvedWithRef.length === 0) {
          skip(candidate.identifier, 'no-fix-reference');
          return;
        }
        log(
          `::warning::write-back: ${candidate.identifier} is done but no ${channel === 'beta' ? 'released build' : 'stable release'} ` +
            `could be derived for ${unresolvedWithRef.map((n) => n.identifier).join(', ')}; posting nothing. ` +
            'Check the fix-reference attachments on those tickets.',
        );
        skip(candidate.identifier, 'version-underivable');
        return;
      }
      skip(candidate.identifier, 'fan-in-withheld');
      return;
    }

    if (channel === 'beta' && isStableVersion(gate.version)) {
      skip(candidate.identifier, 'stable-covers-it');
      return;
    }

    const placement = classifyRelease(gate.version);
    if (placement !== 'in-window') {
      skip(candidate.identifier, placement);
      return;
    }

    if (origins.length === 0) {
      const unreachable = [
        ...attachedOrigins
          .filter((origin) => !isOriginRepliableFrom(origin, selfRepo))
          .map((origin) => `${origin.channel} in ${origin.owner}/${origin.repo}`),
        ...unrepliable.map((u) => u.channel),
      ];
      log(
        `::warning::write-back: ${candidate.identifier} shipped in v${gate.version} but no origin on it can be ` +
          `replied to (${unreachable.join(', ')}); posting nothing.`,
      );
      skip(candidate.identifier, 'origin-unrepliable');
      return;
    }

    for (const origin of origins) {
      const attachmentUrls = candidate.attachmentUrls ?? [];
      const marker = notificationMarkerUrl({ version: gate.version, originUrl: origin.url });
      if (attachmentUrls.includes(marker)) {
        skip(candidate.identifier, 'already-notified');
        continue;
      }
      const changeset = await readChangesetProse(candidate, { fixReferences });
      const text =
        changeset === null
          ? null
          : composeReply({
              changeset,
              version: gate.version,
              originChannel: origin.channel,
              coverage: gate.coverage,
              channel,
            });

      if (!text) {
        log(
          `::warning::write-back: ${candidate.identifier} shipped in v${gate.version} but has no changeset prose ` +
            'behind it; posting nothing rather than a bare version.',
        );
        skip(candidate.identifier, 'no-prose');
        continue;
      }

      if (!live) {
        log(
          `::notice::write-back: [dry run] would reply to ${origin.url} for ${candidate.identifier} ` +
            `(v${gate.version}, covers ${gate.coverage.join(', ')}).`,
        );
        posted.push({
          identifier: candidate.identifier,
          origin: origin.url,
          version: gate.version,
          dryRun: true,
        });
        continue;
      }

      await recordNotification({
        issueId: candidate.id,
        url: marker,
        title: `Reporter notified: v${gate.version}`,
      });
      log(
        `::debug::write-back: marker written for ${origin.url} (${candidate.identifier}); posting reply next.`,
      );
      try {
        await postReply(origin, text);
      } catch (err) {
        throw new NeedsHumanError(
          `marker for ${origin.url} was written but the reply did NOT send (${err.message}). ` +
            'No future run will retry it; post the reply by hand.',
        );
      }
      log(
        `::notice::write-back: replied to ${origin.url} for ${candidate.identifier} ` +
          `(v${gate.version}).`,
      );
      posted.push({
        identifier: candidate.identifier,
        origin: origin.url,
        version: gate.version,
        dryRun: false,
      });
    }
  };

  for (const candidate of await listCandidates()) {
    try {
      await processCandidate(candidate);
    } catch (err) {
      const disposition = err instanceof NeedsHumanError ? 'needs-human' : 'retried-next-run';
      log(
        `::warning::write-back: ${candidate.identifier} could not be processed (${disposition}): ${err.message}`,
      );
      errored.push({ identifier: candidate.identifier, message: err.message, disposition });
    }
  }

  return { posted, skipped, errored, dryRun: !live };
}

export function runFailureMessage({ errored = [] } = {}) {
  if (errored.length === 0) return null;
  const head =
    `${errored.length} of the candidates could not be processed: ` +
    errored.map((e) => `${e.identifier} (${e.message})`).join('; ');

  const needsHuman = errored.filter((e) => e.disposition === 'needs-human');
  if (needsHuman.length === 0) {
    return `${head}. No marker was written for any of them, so the next release run picks them up again.`;
  }
  return (
    `${head}. ACTION REQUIRED: ${needsHuman.map((e) => e.identifier).join(', ')} ` +
    `${needsHuman.length === 1 ? 'was' : 'were'} marked as notified but the reply never sent; ` +
    'no future run will retry, so post it by hand.'
  );
}

export const LINEAR_RETRY_ATTEMPTS = 3;
export const LINEAR_RETRY_BASE_MS = 500;
export const LINEAR_RETRY_CAP_MS = 8000;

export const REQUEST_TIMEOUT_MS = 15_000;

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function isRetryableNetworkError(err) {
  for (let cur = err, depth = 0; cur && typeof cur === 'object' && depth < 5; cur = cur.cause, depth += 1) {
    if (cur.name === 'TimeoutError') return true;
    if (RETRYABLE_NETWORK_CODES.has(cur.code)) return true;
    if (
      /fetch failed|socket hang up|other side closed|terminated|network/i.test(
        String(cur.message ?? ''),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function parseRetryAfterSeconds(header) {
  const seconds = Number(String(header ?? '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function retryDelayMs({
  attempt,
  retryAfterSeconds = null,
  base = LINEAR_RETRY_BASE_MS,
  cap = LINEAR_RETRY_CAP_MS,
  random = Math.random,
}) {
  if (retryAfterSeconds !== null) return Math.min(retryAfterSeconds * 1000, cap);
  const window = Math.min(base * 2 ** (attempt - 1), cap);
  return Math.round(window / 2 + random() * (window / 2));
}

class LinearRequestError extends Error {
  constructor(message, { retryable, retryAfterSeconds = null }) {
    super(message);
    this.name = 'LinearRequestError';
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function linearGraphql({
  apiKey,
  query,
  variables,
  fetchImpl = fetch,
  sleep = realSleep,
  random = Math.random,
  attempts = LINEAR_RETRY_ATTEMPTS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = () => {},
}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      let res;
      try {
        res = await fetchImpl(LINEAR_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: apiKey },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new LinearRequestError(`Linear GraphQL request failed before any reply: ${err.message}`, {
          retryable: isRetryableNetworkError(err),
        });
      }

      if (!res.ok) {
        let body = '';
        try {
          body = (await res.text()).slice(0, 400);
        } catch (err) {
          body = `<body unreadable: ${err.message}>`;
        }
        throw new LinearRequestError(`Linear GraphQL returned HTTP ${res.status}: ${body}`, {
          retryable: isRetryableStatus(res.status),
          retryAfterSeconds: parseRetryAfterSeconds(res.headers?.get?.('retry-after')),
        });
      }

      let payload;
      try {
        payload = await res.json();
      } catch (err) {
        throw new LinearRequestError(`Linear GraphQL reply could not be read: ${err.message}`, {
          retryable: isRetryableNetworkError(err),
        });
      }
      if (payload.errors?.length) {
        throw new LinearRequestError(`Linear GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`, {
          retryable: false,
        });
      }
      return payload.data;
    } catch (err) {
      if (attempt >= attempts || !err.retryable) throw err;
      const delay = retryDelayMs({ attempt, retryAfterSeconds: err.retryAfterSeconds, random });
      log(
        `::notice::write-back: Linear call failed transiently (${err.message}); retrying in ${delay}ms ` +
          `(attempt ${attempt + 1} of ${attempts}).`,
      );
      await sleep(delay);
    }
  }
}

function toNode(raw) {
  return {
    id: raw.id,
    identifier: raw.identifier,
    stateType: raw.state?.type ?? 'unknown',
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    attachmentUrls: (raw.attachments?.nodes ?? []).map((a) => a.url),
  };
}

async function paginate({ apiKey, query, variables, log }) {
  const collected = [];
  let after = null;
  do {
    const data = await linearGraphql({ apiKey, query, variables: { ...variables, after }, log });
    const page = data?.issues;
    if (!page)
      throw new Error(
        'Linear returned no issues connection; refusing to treat that as an empty result.',
      );
    collected.push(...page.nodes.map(toNode));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return collected;
}

function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
    );
  }
  return String(res.stdout || '');
}

function realReadCommitMessage(sha) {
  return runGit(['show', '-s', '--format=%B', sha]);
}

const REC_SEP = '\x1e';
const UNIT_SEP = '\x1f';

function realFindMirroredCommits(privateSha) {
  const out = runGit([
    'log',
    '--all',
    '--fixed-strings',
    `--grep=GitOrigin-RevId: ${privateSha}`,
    `--format=%H${UNIT_SEP}%B${REC_SEP}`,
  ]);
  const commits = [];
  for (const record of out.split(REC_SEP)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const sep = trimmed.indexOf(UNIT_SEP);
    if (sep === -1) continue;
    commits.push({ sha: trimmed.slice(0, sep).trim(), message: trimmed.slice(sep + 1) });
  }
  return commits;
}

function realContains(tag, sha) {
  const res = spawnSync('git', ['merge-base', '--is-ancestor', sha, `${tag}^{commit}`], {
    encoding: 'utf8',
  });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${sha} ${tag} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
  );
}

export function selectGhToken({ owner, repo, env }) {
  const crossRepo = String(env.CROSS_REPO_TOKEN ?? '').trim();
  if (!crossRepo) return null;
  const self = String(env.GITHUB_REPOSITORY ?? '').trim().toLowerCase();
  return `${owner}/${repo}`.toLowerCase() === self ? null : crossRepo;
}

function gh(args, target) {
  const token = target ? selectGhToken({ ...target, env: process.env }) : null;
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  });
}

function realResolvePrMergeSha({ owner, repo, number }) {
  let out;
  try {
    out = gh(['api', `repos/${owner}/${repo}/pulls/${number}`, '--jq', '.merged_at,.merge_commit_sha'], {
      owner,
      repo,
    });
  } catch (err) {
    throw new Error(
      `gh api repos/${owner}/${repo}/pulls/${number} failed: ${String(err?.stderr || err?.message || '').trim()}`,
    );
  }
  return parseMergeShaOutput(out, { owner, repo, number });
}

export function parseMergeShaOutput(out, { owner, repo, number } = {}) {
  const [mergedAt, sha] = String(out ?? '')
    .split('\n')
    .map((s) => s.trim());
  if (!mergedAt || mergedAt === 'null') return null;
  if (!FULL_SHA_RE.test(sha || '')) {
    throw new Error(`${owner}/${repo}#${number} has no usable merge_commit_sha (got '${sha}').`);
  }
  return sha.toLowerCase();
}

export function changesetDirFor(repo) {
  return repo === 'open-knowledge' ? '.changeset/' : 'public/open-knowledge/.changeset/';
}

export function findChangesetPath(filenames, { repo } = {}) {
  const dir = changesetDirFor(repo);
  const isChangeset = (name) =>
    name.startsWith(dir) && /^[^/]+\.md$/.test(name.slice(dir.length)) && !name.endsWith('/README.md');
  return filenames.map((name) => String(name).trim()).find(isChangeset) ?? null;
}

function realReadChangesetProse(_candidate, { fixReferences }) {
  const pull = fixReferences.find((ref) => ref.channel === 'pull-request');
  if (!pull) return null;

  let names;
  try {
    names = gh(
      [
        'api',
        `repos/${pull.owner}/${pull.repo}/pulls/${pull.number}/files`,
        '--paginate',
        '--jq',
        '.[].filename',
      ],
      pull,
    );
  } catch (err) {
    throw new Error(
      `gh api pulls/${pull.number}/files failed: ${String(err?.stderr || err?.message || '').trim()}`,
    );
  }

  const changesetPath = findChangesetPath(names.split('\n'), { repo: pull.repo });
  if (!changesetPath) return null;

  let raw;
  try {
    raw = gh(
      [
        'api',
        `repos/${pull.owner}/${pull.repo}/contents/${changesetPath}?ref=refs/pull/${pull.number}/head`,
        '--jq',
        '.content',
      ],
      pull,
    );
  } catch (err) {
    throw new Error(
      `gh api contents/${changesetPath} failed: ${String(err?.stderr || err?.message || '').trim()}`,
    );
  }

  const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  return parseChangeset(decoded);
}

export function parseChangeset(raw) {
  const text = String(raw ?? '');
  const withoutFrontmatter = text.replace(/^\s*---[\s\S]*?---\s*/, '').trim();
  if (!withoutFrontmatter) return null;
  const [firstLine] = withoutFrontmatter.split('\n');
  return { title: firstLine.trim(), body: withoutFrontmatter };
}

async function realPostReply(origin, text) {
  if (origin.channel === 'github-issue') {
    execFileSync(
      'gh',
      [
        'api',
        `repos/${origin.owner}/${origin.repo}/issues/${origin.number}/comments`,
        '-f',
        `body=${text}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return;
  }
  if (origin.channel === 'discord-thread') {
    const url = process.env.DISCORD_NOTIFY_URL;
    const token = process.env.DISCORD_NOTIFY_TOKEN;
    if (!url || !token) throw new Error('DISCORD_NOTIFY_URL / DISCORD_NOTIFY_TOKEN are required to reply on Discord');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: origin.threadId, content: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `notify endpoint returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    return;
  }
  throw new Error(`no reply transport for origin channel '${origin.channel}'`);
}

async function main() {
  const log = (message) => console.log(message);
  const apiKey = (process.env.LINEAR_API_KEY ?? '').trim();
  if (!apiKey) {
    console.log(
      '::notice::write-back: LINEAR_API_KEY is not set on this repo, so there is nothing to enumerate. ' +
        'Add it as a repo secret to enable reporter write-back. Nothing was posted.',
    );
    return;
  }

  const live = process.env.WRITE_BACK_MODE === 'live';
  if (!live) {
    log(
      '::notice::write-back: running in dry-run mode (set WRITE_BACK_MODE=live to arm reporter replies).',
    );
  }

  const releaseTag = process.env.RELEASE_TAG;
  const channel = deriveChannel(releaseTag);
  if (!channel) {
    throw new Error(
      `RELEASE_TAG must be a release tag of this cadence, v0.36.0 or v0.36.0-beta.3 ` +
        `(got ${JSON.stringify(releaseTag)}).`,
    );
  }

  const stableTags = realReleaseTags();
  const versionFor = (node) =>
    deriveVersionForFixRefs({
      fixReferences: partitionAttachments(node.attachmentUrls ?? []).fixReferences,
      stableTags,
      findMirroredCommits: realFindMirroredCommits,
      contains: realContains,
      resolvePrMergeSha: realResolvePrMergeSha,
      readCommitMessage: realReadCommitMessage,
      channel,
      log,
    });

  const classifyRelease = makeReleaseWindow({ releaseTag, stableTags, channel });
  const lookback = channel === 'beta' ? DEFAULT_BETA_LOOKBACK : DEFAULT_RELEASE_LOOKBACK;
  log(
    `::notice::write-back: ${channel} channel, scoped to ${releaseTag} and the ${lookback} ` +
      `${channel === 'beta' ? 'releases' : 'stable releases'} before it; anything shipped earlier is left alone.`,
  );

  if (!String(process.env.CROSS_REPO_TOKEN ?? '').trim()) {
    log(
      `::warning::write-back: no CROSS_REPO_TOKEN, so reads against ${DEFAULT_PRIVATE_REPO} run on this repo's own ` +
        'token and will 404. Those 404s mean "not authorised", not "no such pull request".',
    );
  }

  const result = await runWriteBack({
    listCandidates: () => paginate({ apiKey, query: CANDIDATE_QUERY, variables: {}, log }),
    listChildren: (parentId) => paginate({ apiKey, query: CHILDREN_QUERY, variables: { parentId }, log }),
    versionFor,
    classifyRelease,
    channel,
    readChangesetProse: (candidate, ctx) => realReadChangesetProse(candidate, ctx),
    postReply: realPostReply,
    recordNotification: async ({ issueId, url, title }) => {
      const data = await linearGraphql({
        apiKey,
        query:
          'mutation Mark($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }',
        variables: { input: { issueId, url, title } },
        log,
      });
      if (!data?.attachmentCreate?.success) {
        throw new Error(`Linear attachmentCreate reported failure for issue ${issueId}`);
      }
    },
    live,
    log,
  });

  console.log(
    JSON.stringify({
      dryRun: result.dryRun,
      posted: result.posted.length,
      skipped: result.skipped,
      errored: result.errored,
    }),
  );

  const failure = runFailureMessage(result);
  if (failure) throw new Error(failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::write-back: ${err.message}`);
    process.exit(1);
  });
}
