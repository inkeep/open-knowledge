#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const REV_ID_RE = /^[ \t]*GitOrigin-RevId:[ \t]*([0-9a-f]{7,40})[ \t]*$/gim;
const PR_URL_RE = /^https?:\/\/[^/]*github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_NUMBER_RE = /^#?(\d+)$/;

const DEFAULT_PRIVATE_REPO = 'inkeep/agents-private';

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

export function parseGitOriginRevIds(commitMessage) {
  const ids = [];
  for (const m of String(commitMessage ?? '').matchAll(REV_ID_RE)) {
    ids.push(m[1].toLowerCase());
  }
  return ids;
}

export function parseFixRef(raw, { defaultRepo = DEFAULT_PRIVATE_REPO } = {}) {
  const ref = String(raw ?? '').trim();
  if (!ref) throw new Error('missing fix reference (expected a commit SHA, a PR URL, or #N)');

  if (FULL_SHA_RE.test(ref)) return { kind: 'sha', sha: ref.toLowerCase() };

  const urlMatch = PR_URL_RE.exec(ref);
  if (urlMatch) {
    return { kind: 'pr', owner: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) };
  }

  const numMatch = PR_NUMBER_RE.exec(ref);
  if (numMatch) {
    const [owner, repo] = defaultRepo.split('/');
    if (!owner || !repo) throw new Error(`invalid default repo '${defaultRepo}' (expected owner/repo)`);
    return { kind: 'pr', owner, repo, number: Number(numMatch[1]) };
  }

  throw new Error(
    `unrecognized fix reference '${ref}' (expected a full 40-character commit SHA, a PR URL, or #N)`,
  );
}

function releaseTagKey(raw) {
  const line = String(raw).trim();
  const stable = STABLE_TAG_RE.exec(line);
  if (stable) {
    return { tag: stable[0], key: [Number(stable[1]), Number(stable[2]), Number(stable[3]), 1, 0] };
  }
  const beta = BETA_TAG_RE.exec(line);
  if (beta) {
    return {
      tag: beta[0],
      key: [Number(beta[1]), Number(beta[2]), Number(beta[3]), 0, Number(beta[4])],
    };
  }
  return null;
}

function byReleaseKeyAscending(a, b) {
  for (let i = 0; i < a.key.length; i += 1) {
    if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
  }
  return 0;
}

export function sortReleaseTagsAscending(rawTags) {
  const parsed = [];
  for (const line of rawTags) {
    const entry = releaseTagKey(line);
    if (entry) parsed.push(entry);
  }
  parsed.sort(byReleaseKeyAscending);
  return parsed.map((p) => p.tag);
}

export function sortStableTagsAscending(rawTags) {
  const parsed = [];
  for (const line of rawTags) {
    const m = STABLE_TAG_RE.exec(String(line).trim());
    if (m) parsed.push({ tag: m[0], key: [Number(m[1]), Number(m[2]), Number(m[3])] });
  }
  parsed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return parsed.map((p) => p.tag);
}

export function firstContainingStableTag({ sortedStableTags, sha, contains }) {
  for (const tag of sortedStableTags) {
    if (contains(tag, sha)) return tag;
  }
  return null;
}

export function resolveShippedVersion({
  privateSha,
  stableTags,
  findMirroredCommits,
  contains,
  channel = 'stable',
}) {
  if (!FULL_SHA_RE.test(String(privateSha ?? ''))) {
    throw new Error(`privateSha must be a full 40-character commit SHA, got '${privateSha}'`);
  }
  const wanted = String(privateSha).toLowerCase();

  const mirroredShas = [];
  for (const commit of findMirroredCommits(wanted) ?? []) {
    if (parseGitOriginRevIds(commit.message).includes(wanted)) {
      mirroredShas.push(String(commit.sha).toLowerCase());
    }
  }
  if (mirroredShas.length === 0) {
    return { shipped: false, reason: 'not-mirrored', privateSha: wanted, mirroredShas: [] };
  }

  const sorted =
    channel === 'beta' ? sortReleaseTagsAscending(stableTags) : sortStableTagsAscending(stableTags);
  const rank = new Map(sorted.map((tag, i) => [tag, i]));

  let best = null;
  for (const mirroredSha of mirroredShas) {
    const tag = firstContainingStableTag({ sortedStableTags: sorted, sha: mirroredSha, contains });
    if (!tag) continue;
    if (best === null || rank.get(tag) < rank.get(best.tag)) {
      best = { tag, mirroredSha };
    }
  }
  if (best === null) {
    const reason = channel === 'beta' ? 'not-in-any-release' : 'not-in-any-stable';
    return { shipped: false, reason, privateSha: wanted, mirroredShas };
  }

  return {
    shipped: true,
    privateSha: wanted,
    mirroredSha: best.mirroredSha,
    mirroredShas,
    tag: best.tag,
    version: best.tag.slice(1),
  };
}

function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '');
}

export function parseTagLines(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function realReleaseTags() {
  return parseTagLines(runGit(['tag', '--list', 'v*', '--sort=version:refname']));
}

const REC_SEP = '\x1e';
const UNIT_SEP = '\x1f';

export function realFindMirroredCommits(privateSha) {
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

export function realContains(tag, sha) {
  const res = spawnSync('git', ['merge-base', '--is-ancestor', sha, `${tag}^{commit}`], {
    encoding: 'utf8',
  });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${sha} ${tag} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
  );
}

function realResolvePrMergeSha({ owner, repo, number }) {
  let out;
  try {
    out = execFileSync('gh', ['api', `repos/${owner}/${repo}/pulls/${number}`, '--jq', '.merged_at,.merge_commit_sha'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `gh api repos/${owner}/${repo}/pulls/${number} failed: ${String(err?.stderr || err?.message || '').trim()}`,
    );
  }
  const [mergedAt, sha] = out.split('\n').map((s) => s.trim());
  if (!mergedAt || mergedAt === 'null') {
    throw new Error(`${owner}/${repo}#${number} is not merged; there is no fix commit to resolve.`);
  }
  if (!FULL_SHA_RE.test(sha || '')) {
    throw new Error(`${owner}/${repo}#${number} has no usable merge_commit_sha (got '${sha}').`);
  }
  return sha.toLowerCase();
}

export function resolvePrivateSha(fixRef, { resolvePrMergeSha }) {
  return fixRef.kind === 'sha' ? fixRef.sha : resolvePrMergeSha(fixRef);
}

function main() {
  let result;
  let fixRef;
  try {
    fixRef = parseFixRef(process.argv[2], { defaultRepo: process.env.PRIVATE_REPO || DEFAULT_PRIVATE_REPO });
    const privateSha = resolvePrivateSha(fixRef, { resolvePrMergeSha: realResolvePrMergeSha });
    result = resolveShippedVersion({
      privateSha,
      stableTags: realReleaseTags(),
      findMirroredCommits: realFindMirroredCommits,
      contains: realContains,
    });
  } catch (err) {
    console.error(`::error::resolve-shipped-version: ${err.message}`);
    process.exit(1);
  }

  if (result.shipped) {
    log(`Shipped: ${result.privateSha.slice(0, 12)} -> mirrored ${result.mirroredSha.slice(0, 12)} -> ${result.tag}.`);
  } else if (result.reason === 'not-mirrored') {
    log(`Not shipped: no mirrored commit carries GitOrigin-RevId ${result.privateSha} yet.`);
  } else {
    log(`Not shipped: mirrored as ${result.mirroredShas.join(', ')}, but no stable tag contains it yet.`);
  }

  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `shipped=${result.shipped ? 'true' : 'false'}`,
      `version=${result.version ?? ''}`,
      `tag=${result.tag ?? ''}`,
      `private_sha=${result.privateSha ?? ''}`,
      `mirrored_sha=${result.mirroredSha ?? ''}`,
    ];
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
