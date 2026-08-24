#!/usr/bin/env node
/**
 * Answer "which stable version shipped this fix?" for a fix that merged on the
 * private monorepo and reached this repo through the Copybara mirror.
 *
 * Why this is not a one-liner. The mirror rewrites commit SHAs, and the
 * mirrored commits have no pull requests in the repo where the release tags
 * live — so the usual `release commits -> associatedPullRequests -> closing
 * keywords` walk that every off-the-shelf release notifier uses returns
 * nothing here. What the mirror *does* write unconditionally is a
 * `GitOrigin-RevId: <source-sha>` trailer, so the chain runs the other way:
 *
 *     private PR -> merge commit SHA -> GitOrigin-RevId match -> mirrored
 *     commit -> lowest stable tag whose history contains it
 *
 * The last hop is TAG CONTAINMENT, not pull-request association, which is why
 * the mirror break above does not affect it.
 *
 * "Most recent release published after the merge date" is NOT the answer and
 * gets this wrong in practice: mirrored commit eb52a625cd86859a8ec43ddc8f96e9b418d092a7
 * is absent from v0.35.0 through v0.35.6 and first appears in v0.36.0, even
 * though three of those v0.35.x stables published after its source merged. The
 * colocated test pins that case.
 *
 * Relationship to the Linear release stamping workflow: that workflow answers
 * the inverse question (given a release, which tickets does it carry) by
 * scanning commit text, and writes to Linear. This script writes nowhere and
 * reads only git; the two do not overlap in mechanism or in output.
 *
 * Usage:
 *   node .github/scripts/resolve-shipped-version.mjs <sha | pr-url | #N | N>
 *
 * Must run inside a full clone of this repo (`fetch-depth: 0`, `fetch-tags:
 * true`) — the containment walk needs every stable tag and the mirror lookup
 * needs full history.
 *
 * Emits JSON to stdout and, under Actions, appends
 *   shipped / version / tag / private_sha / mirrored_sha
 * to $GITHUB_OUTPUT. Logs go to stderr.
 *
 * Fail-loud contract, matching the sibling selection script: "not mirrored
 * yet" and "mirrored but not in any stable yet" are real ANSWERS and exit 0 —
 * a caller that must refuse rather than guess reads `shipped: false` and
 * declines. Every other failure (bad ref, git/gh error, ambiguous input) exits
 * non-zero. An infra error must never collapse into "not shipped", because a
 * caller cannot distinguish that from the truth and would either stay silent
 * forever or, worse, name the wrong version.
 *
 * The pure core takes its git/gh boundary as injected dependencies so the
 * tests need no live repo, no network, and no tags.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
// A prerelease tag of the beta cadence: `v0.59.0-beta.3`. Deliberately its own
// pattern rather than an optional group on STABLE_TAG_RE, so every stable-only
// call site keeps refusing prereleases by construction. The beta channel has to
// ask for them; it must not be reachable by an accidental widening.
const BETA_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
// Copybara emits the trailer on its own line. Matched case-insensitively on
// the key and anchored to a line start so a trailer quoted inside a prose body
// (a squash message that pasted another commit's footer) cannot outrank the
// real one.
const REV_ID_RE = /^[ \t]*GitOrigin-RevId:[ \t]*([0-9a-f]{7,40})[ \t]*$/gim;
// Accepts both hosts' PR URL shapes plus the bare `#N` / `N` forms an operator
// is likely to paste.
const PR_URL_RE = /^https?:\/\/[^/]*github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_NUMBER_RE = /^#?(\d+)$/;

const DEFAULT_PRIVATE_REPO = 'inkeep/agents-private';

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

/**
 * Every `GitOrigin-RevId` value in a commit message, in order of appearance.
 * A message normally carries exactly one; more than one means the message
 * embedded someone else's footer, which the caller resolves by exact match
 * rather than by position.
 */
export function parseGitOriginRevIds(commitMessage) {
  const ids = [];
  for (const m of String(commitMessage ?? '').matchAll(REV_ID_RE)) {
    ids.push(m[1].toLowerCase());
  }
  return ids;
}

/**
 * Parse the operator-facing fix reference into something resolvable.
 *   { kind: 'sha', sha }                       — a full 40-hex commit SHA
 *   { kind: 'pr', owner, repo, number }        — a PR URL, `#N`, or `N`
 * Throws on anything else: guessing at a malformed ref is how a caller ends up
 * naming a version that belongs to a different change.
 */
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

  // An abbreviated SHA is rejected rather than expanded: this repo cannot
  // resolve a private-repo abbreviation, and a 7-char prefix is not unique
  // enough to trust across two repositories.
  throw new Error(
    `unrecognized fix reference '${ref}' (expected a full 40-character commit SHA, a PR URL, or #N)`,
  );
}

/**
 * Sort key for a release tag, or null when the tag is neither a stable nor a
 * beta of the cadence this repo cuts.
 *
 * The fourth component carries semver's prerelease precedence: every
 * `v0.59.0-beta.N` ranks BELOW the `v0.59.0` that supersedes it. That ordering
 * is the whole reason the beta channel can answer "the earliest build carrying
 * this fix" with the beta rather than the stable that followed it weeks later.
 *
 * The same precedence rule is spelled out once more, over version strings rather
 * than tags, as `releaseVersionKey` in `write-back-gate.mjs`. That file is
 * deliberately IO-free and imports nothing from here, so the two cannot share an
 * implementation; a change to the shape of this repo's release tags has to land
 * in both.
 */
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

/**
 * Sort every release tag this repo cuts — stables and betas together —
 * ascending, dropping non-conforming refs.
 *
 * Kept separate from the stable-only sorter rather than folded into it behind a
 * flag. The two answer different questions, and the failure mode of conflating
 * them is asymmetric: a stable channel that accidentally saw a prerelease would
 * tell a reporter their fix is out when only a beta carries it, which is the one
 * thing this whole path exists not to do.
 */
export function sortReleaseTagsAscending(rawTags) {
  const parsed = [];
  for (const line of rawTags) {
    const entry = releaseTagKey(line);
    if (entry) parsed.push(entry);
  }
  parsed.sort(byReleaseKeyAscending);
  return parsed.map((p) => p.tag);
}

/** Sort `vX.Y.Z` tags ascending by numeric semver, dropping non-conforming refs. */
export function sortStableTagsAscending(rawTags) {
  const parsed = [];
  for (const line of rawTags) {
    const m = STABLE_TAG_RE.exec(String(line).trim());
    if (m) parsed.push({ tag: m[0], key: [Number(m[1]), Number(m[2]), Number(m[3])] });
  }
  parsed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return parsed.map((p) => p.tag);
}

/**
 * Lowest-version stable tag whose history contains `sha`, or null if none does.
 *
 * The walk is linear rather than a binary search because containment is NOT
 * monotonic across the tag order: a point release is cut off the previous
 * stable rather than off `main`, so a higher tag can contain a commit that a
 * lower one does not and vice versa. Bisecting an unsorted-by-containment
 * sequence would silently skip the real first hit.
 *
 * Any throw from `contains` propagates — an unreadable tag is an infra error,
 * not evidence of non-containment.
 */
export function firstContainingStableTag({ sortedStableTags, sha, contains }) {
  for (const tag of sortedStableTags) {
    if (contains(tag, sha)) return tag;
  }
  return null;
}

/**
 * Pure decision core. Boundaries are injected:
 *   findMirroredCommits(privateSha) -> [{ sha, message }]   (candidates; may over-match)
 *   contains(tag, sha)              -> boolean              (sha is in tag's history)
 *
 * `channel` selects which tags count as a build a reporter could install:
 * `stable` (the default) considers bare `vX.Y.Z` only, `beta` considers every
 * tag of the cadence so the answer can be the prerelease the fix first reached.
 * `stableTags` is the raw `git tag --list v*` output either way — betas are
 * present in it already, and the channel is what decides whether they count.
 *
 * Returns one of:
 *   { shipped: true,  privateSha, mirroredSha, mirroredShas, tag, version }
 *   { shipped: false, reason: 'not-mirrored', privateSha, mirroredShas: [] }
 *   { shipped: false, reason: 'not-in-any-stable' | 'not-in-any-release', privateSha, mirroredShas }
 */
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

  // `git log --grep` is a substring match over the whole message, so a commit
  // that merely quotes the trailer would come back too. Re-check each
  // candidate against the parsed trailer values and keep only exact matches.
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

  // A fix can exist at more than one mirrored SHA: a point release cherry-picks
  // it onto a synthetic off-`main` tag, and a cherry-pick carries the trailer
  // with it. The installable answer is then the LOWEST version among the
  // per-commit first-containing tags, not the one the `main`-line commit
  // reaches, which would over-report and send a reporter past the point release
  // that already carried their fix.
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

// --- workflow-runtime wiring (real git / gh boundary) ---

function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '');
}

/**
 * Split `git tag --list` output into tags.
 *
 * Pure, and separated from the git call so the one property that matters here
 * can be tested: prereleases come back. A caller that wants only stables asks
 * the sorter for them, because the sorter is where the channel is known.
 */
export function parseTagLines(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Every release tag this repo has cut, prereleases INCLUDED.
 *
 * Named for what it returns. It was `realStableTags`, and a second, private copy
 * of it in `write-back.mjs` quietly filtered to bare `vX.Y.Z` to live up to that
 * name — which silently emptied the beta channel, since no prerelease ever
 * reached the channel-aware resolver. One reader, honestly named, and the
 * filtering left to the sorter that knows which channel is asking.
 */
export function realReleaseTags() {
  return parseTagLines(runGit(['tag', '--list', 'v*', '--sort=version:refname']));
}

// Record separator between commits and a unit separator between the SHA and
// the raw body, so a message containing blank lines (every squash message
// does) cannot be mistaken for a record boundary.
const REC_SEP = '\x1e';
const UNIT_SEP = '\x1f';

export function realFindMirroredCommits(privateSha) {
  // `--all` rather than HEAD: a point release lives on a synthetic off-`main`
  // tag, so the cherry-picked copy of a fix is unreachable from the checked-out
  // branch. `--fixed-strings` keeps the SHA from being read as a pattern.
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
  // Distinguish a clean "not an ancestor" (exit 1) from an infra failure (any
  // other non-zero), which must fail loud rather than read as "not contained".
  const res = spawnSync('git', ['merge-base', '--is-ancestor', sha, `${tag}^{commit}`], {
    encoding: 'utf8',
  });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${sha} ${tag} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
  );
}

// The private repo is not checked out here, so the PR -> merge-commit hop goes
// through the API. An unmerged or squash-less PR has no merge commit and is a
// hard error: there is no fix to locate.
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

// Run main() only as a CLI, not when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
