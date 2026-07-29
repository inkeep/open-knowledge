#!/usr/bin/env node
/**
 * Tell a bug reporter, once, that the fix they reported has shipped.
 *
 * Why this enumerates tickets rather than release commits. Every off-the-shelf
 * release notifier walks the commits in a release, follows each to its pull
 * request, and reads closing keywords. That returns nothing here: the commits
 * in this repo arrive through the Copybara mirror and have no pull requests in
 * the repo the release tags live in. So the walk starts from the other end. Ask
 * Linear which bug tickets are done, and for each one work forward to the
 * version it shipped in through tag containment, which the mirror does not
 * break.
 *
 * Why the version is never read from Linear. `linear-release.yml` stamps
 * releases onto tickets, and it runs off the same dispatch this does. Reading
 * its output would be a race with an outcome nobody would ever notice: the
 * reporter is simply told the wrong version. Tag containment depends on nothing
 * but git, so the two workflows cannot interfere.
 *
 * Why dry run is the default, and why the credential alone does not arm it.
 * Everything downstream of this posts in public under the project's name. An
 * operator wiring up a Linear key for the back-link half should not thereby
 * start replying to strangers, so live posting needs a second, explicit opt-in
 * that does nothing else. Arming steps are in RELEASES.md.
 *
 * Usage:
 *   RELEASE_TAG=v0.36.0 node .github/scripts/write-back.mjs
 *
 * Must run inside a full clone (`fetch-depth: 0`, `fetch-tags: true`) — the
 * containment walk needs every stable tag and full history.
 *
 * Fail-loud contract: "nothing to notify about" is a real ANSWER and exits 0.
 * A missing credential is an answer too. Any infra error (Linear unreachable, a
 * git failure, a malformed GraphQL response) exits non-zero rather than being
 * folded into silence, because a caller cannot tell a quiet run from a broken
 * one and would never look again. An error against ONE ticket is deferred, not
 * softened: the run finishes so the other reporters still hear, and then exits
 * non-zero carrying every failure it collected.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  parseFixRef,
  resolvePrivateSha,
  resolveShippedVersion,
} from './resolve-shipped-version.mjs';
import { composeReply, evaluateFanIn, partitionAttachments } from './write-back-gate.mjs';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const RELEASES_TAG_BASE = 'https://github.com/inkeep/open-knowledge/releases/tag';
const DEFAULT_PRIVATE_REPO = 'inkeep/agents-private';
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const PAGE_SIZE = 50;

/**
 * The candidate enumeration.
 *
 * `labels: { name: { eq: "Bug" } }` matches when ANY of the ticket's labels is
 * Bug, which is the intent: a real ticket looks like ["Bug", "ok:platform"].
 * The sibling form `labels: { every: { name: { eq: "Bug" } } }` reads almost
 * identically and would silently drop every multi-labelled ticket, which is to
 * say nearly all of them. The colocated test pins that this query never uses
 * `every`.
 *
 * "Not yet notified" is deliberately absent from the filter. Linear's filter
 * language has no negative-existence predicate over attachments, and expressing
 * it as a positive one would invert the meaning; the check runs over the
 * attachments this query already returns.
 */
export const CANDIDATE_QUERY = `
  query WriteBackCandidates($after: String) {
    issues(
      first: ${PAGE_SIZE}
      after: $after
      filter: { state: { type: { eq: "completed" } }, labels: { name: { eq: "Bug" } } }
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

/**
 * The URL that records "this origin has been told about this version".
 *
 * Linear treats an attachment URL as an idempotent key against the same issue,
 * so making this deterministic in (origin, version) buys idempotency with no
 * read-modify-write and no lock: a second run computes the same URL, finds it
 * already on the ticket, and posts nothing. It points at the real release page
 * so a human who clicks it lands somewhere useful.
 */
export function notificationMarkerUrl({ version, originUrl }) {
  const v = String(version ?? '')
    .trim()
    .replace(/^v/, '');
  if (!v) throw new Error('notificationMarkerUrl needs a version');
  if (!String(originUrl ?? '').trim()) throw new Error('notificationMarkerUrl needs an origin url');
  return `${RELEASES_TAG_BASE}/v${v}?notified=${encodeURIComponent(originUrl)}`;
}

/**
 * The version a ticket's fix is installable in, or null if it is not out yet.
 *
 * Across several fix references the answer is the HIGHEST of their individual
 * first-containing tags: the reporter needs a build that contains all of them,
 * so the last one to land sets the floor. (Within a single reference,
 * `resolveShippedVersion` takes the LOWEST across the mirror's copies of that
 * one commit, which is the opposite question and the opposite answer: a point
 * release that carried the fix earlier is the one to name.)
 *
 * Any reference that has not shipped makes the whole answer null. Part of a fix
 * being out is not the fix being out.
 */
export function deriveVersionForFixRefs({
  fixReferences = [],
  stableTags,
  findMirroredCommits,
  contains,
  resolvePrMergeSha,
  defaultRepo = DEFAULT_PRIVATE_REPO,
  log = () => {},
}) {
  const usable = fixReferences.filter((ref) => ref.channel !== 'commit' || FULL_SHA_RE.test(ref.sha ?? ''));
  if (usable.length === 0) return null;

  let highest = null;
  for (const ref of usable) {
    const parsed = parseFixRef(ref.channel === 'commit' ? ref.sha : ref.url, { defaultRepo });
    const privateSha = resolvePrivateSha(parsed, { resolvePrMergeSha });
    if (!privateSha) {
      log(`::notice::write-back: ${ref.url} was closed without merging, so it carries no fix commit.`);
      return null;
    }
    const result = resolveShippedVersion({ privateSha, stableTags, findMirroredCommits, contains });
    if (!result.shipped) {
      log(`::notice::write-back: ${ref.url} has not reached a stable release yet (${result.reason}).`);
      return null;
    }
    if (highest === null || compareSemver(result.version, highest) > 0) highest = result.version;
  }
  return highest;
}

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export const DEFAULT_RELEASE_LOOKBACK = 3;

/** `v0.36.0` and `0.36.0` both mean the same release; anything else means none. */
function normalizeVersion(raw) {
  const trimmed = String(raw ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Decide which shipped versions a given run is allowed to speak about.
 *
 * The release being processed is the ceiling: a fix that lands in a later
 * version has not reached anybody yet, so telling its reporter would be a lie.
 *
 * The floor is deliberately a few releases further back rather than the release
 * itself. A run that never happened — a workflow outage, or simply the stretch
 * before any of this was armed — would otherwise strand those reporters
 * permanently, because the next release only ever considers its own version and
 * nothing ever revisits the gap. Widening the floor is safe because the
 * absent-marker check, not the width of this window, is what prevents a second
 * reply: the window is bounded by "has not been told yet".
 *
 * Without a window every completed fix in history looks eligible, which on a
 * first armed run means messaging the entire back catalogue at once.
 */
export function makeReleaseWindow({
  releaseTag,
  stableTags = [],
  lookback = DEFAULT_RELEASE_LOOKBACK,
}) {
  const release = normalizeVersion(releaseTag);
  if (!release) {
    throw new Error(
      `RELEASE_TAG must be a bare stable tag such as v0.36.0 (got ${JSON.stringify(releaseTag)}). ` +
        'Refusing to run: with no release to scope against, every shipped fix in history is a candidate.',
    );
  }

  const known = [...new Set(stableTags.map(normalizeVersion).filter(Boolean))].sort(compareSemver);
  const atOrBelow = known.filter((v) => compareSemver(v, release) <= 0);
  // Keep the release plus `lookback` older ones; the entry just below that
  // block is the exclusive floor. Too little history to reach back that far
  // means everything at or below the release stays in.
  const floorIndex = atOrBelow.length - (lookback + 1) - 1;
  const floor = floorIndex >= 0 ? atOrBelow[floorIndex] : null;

  return (version) => {
    const shipped = normalizeVersion(version);
    if (!shipped) return 'unversioned';
    if (compareSemver(shipped, release) > 0) return 'not-yet-shipped';
    if (floor && compareSemver(shipped, floor) <= 0) return 'shipped-earlier';
    return 'in-window';
  };
}

/**
 * Walk every candidate and decide, for each, whether to reply and where.
 *
 * Boundaries are injected so the whole decision path is testable with no Linear
 * account, no git repo, and no network:
 *   listCandidates()            -> [candidate]
 *   listChildren(issueId)       -> [node]
 *   versionFor(node)            -> version | null      (tag containment)
 *   readChangesetProse(node)    -> { title, body } | null
 *   postReply(origin, text)     -> void
 *   recordNotification(marker)  -> void
 *
 * `live` false is the default and performs zero writes of any kind.
 *
 * Returns { posted, skipped, errored, dryRun }. `skipped` carries a reason per
 * candidate, so a run that did nothing can be read as either "correctly quiet"
 * or "quietly broken"; `errored` carries the candidates that threw, which the
 * caller must turn into a non-zero exit — they are failures that happened to be
 * survivable, not skips.
 */
export async function runWriteBack({
  listCandidates,
  listChildren,
  versionFor,
  readChangesetProse,
  postReply,
  recordNotification,
  classifyRelease,
  live = false,
  log = () => {},
}) {
  // No default. A missing window is not "notify about everything", it is a
  // caller that forgot to scope the run, and the difference between those two
  // readings is the entire back catalogue.
  if (typeof classifyRelease !== 'function') {
    throw new Error('runWriteBack requires classifyRelease; see makeReleaseWindow.');
  }

  const posted = [];
  const skipped = [];
  const errored = [];
  const skip = (identifier, reason) => skipped.push({ identifier, reason });

  // One candidate per attempt, so a ticket whose fix reference cannot be read
  // does not decide the fate of every reporter behind it in the list. The
  // failure is collected rather than swallowed: the caller fails the run once
  // everyone reachable has been told, which is strictly more than aborting on
  // the first bad reference told anyone.
  const processCandidate = async (candidate) => {
    const { origins, unrepliable, fixReferences } = partitionAttachments(candidate.attachmentUrls ?? []);
    const children = await listChildren(candidate.id);

    // The version for every node in the tree is resolved up front so the gate
    // itself stays synchronous and pure.
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
        log(
          `::warning::write-back: ${candidate.identifier} is done but no stable release could be derived for ` +
            `${gate.unresolved.join(', ')}; posting nothing. Check the fix-reference attachments on those tickets.`,
        );
      }
      skip(candidate.identifier, gate.unresolved.length > 0 ? 'version-underivable' : 'fan-in-withheld');
      return;
    }

    // Scope to the release this run is about. Skips here are the ordinary bulk
    // of a run rather than a fault, so they are recorded per candidate and
    // summarised at the end instead of annotated one line at a time.
    const placement = classifyRelease(gate.version);
    if (placement !== 'in-window') {
      skip(candidate.identifier, placement);
      return;
    }

    if (origins.length === 0) {
      if (unrepliable.length > 0) {
        log(
          `::warning::write-back: ${candidate.identifier} shipped in v${gate.version} but its only origin ` +
            `(${unrepliable.map((u) => u.channel).join(', ')}) has nowhere to post a reply; posting nothing.`,
        );
        skip(candidate.identifier, 'origin-unrepliable');
      } else {
        // Not every fix has a reporter. This is the ordinary case, not a fault.
        skip(candidate.identifier, 'no-origin');
      }
      return;
    }

    for (const origin of origins) {
      const marker = notificationMarkerUrl({ version: gate.version, originUrl: origin.url });
      if ((candidate.attachmentUrls ?? []).includes(marker)) {
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
            });

      if (!text) {
        log(
          `::warning::write-back: ${candidate.identifier} shipped in v${gate.version} but has no changeset prose ` +
            'to quote; posting nothing rather than a bare version.',
        );
        skip(candidate.identifier, 'no-prose');
        continue;
      }

      if (!live) {
        log(
          `::notice::write-back: [dry run] would reply to ${origin.url} for ${candidate.identifier} ` +
            `(v${gate.version}, covers ${gate.coverage.join(', ')}).`,
        );
        posted.push({ identifier: candidate.identifier, origin: origin.url, version: gate.version, dryRun: true });
        continue;
      }

      // Mark before posting, not after. The contract is at-most-once, and the
      // two failure windows are not symmetric: a crash between post and mark
      // re-sends a reply the reporter already read, while a crash between mark
      // and post just leaves them uninformed, which is the same state they were
      // in a moment earlier and which a human can still fix by hand.
      await recordNotification({
        issueId: candidate.id,
        url: marker,
        title: `Reporter notified: v${gate.version}`,
      });
      // The window between these two is the one state an operator cannot infer
      // from the failure alone: marked, so no later run will retry, but never
      // actually delivered. Name it here so it is readable from the job log
      // rather than only from a Linear lookup.
      log(
        `::debug::write-back: marker written for ${origin.url} (${candidate.identifier}); posting reply next.`,
      );
      try {
        await postReply(origin, text);
      } catch (err) {
        // Past the point of no return. Re-raise saying so, because the generic
        // "could not be processed" this lands in reads as retryable and this
        // one is not: the marker stands, so no later run will pick it up and
        // the only remaining fix is a reply posted by hand.
        throw new Error(
          `marker for ${origin.url} was written but the reply did NOT send (${err.message}). ` +
            'No future run will retry it; post the reply by hand.',
        );
      }
      log(`::notice::write-back: replied to ${origin.url} for ${candidate.identifier} (v${gate.version}).`);
      posted.push({ identifier: candidate.identifier, origin: origin.url, version: gate.version, dryRun: false });
    }
  };

  for (const candidate of await listCandidates()) {
    try {
      await processCandidate(candidate);
    } catch (err) {
      log(`::warning::write-back: ${candidate.identifier} could not be processed: ${err.message}`);
      errored.push({ identifier: candidate.identifier, message: err.message });
    }
  }

  return { posted, skipped, errored, dryRun: !live };
}

/**
 * A run that could not process every candidate is a failed run, even though it
 * ran to the end and may well have posted to most reporters. The verdict is
 * returned rather than thrown where it is decided, so that "errors must still
 * turn the job red" is one expression a test can hold on to instead of a branch
 * inside an entry point nothing can call.
 */
export function runFailureMessage({ errored = [] } = {}) {
  if (errored.length === 0) return null;
  return (
    `${errored.length} of the candidates could not be processed: ` +
    errored.map((e) => `${e.identifier} (${e.message})`).join('; ')
  );
}

// --- workflow-runtime wiring (real Linear / git / gh / Discord boundary) ---

async function linearGraphql({ apiKey, query, variables }) {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear GraphQL returned HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const payload = await res.json();
  if (payload.errors?.length) {
    throw new Error(`Linear GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  return payload.data;
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

async function paginate({ apiKey, query, variables }) {
  const collected = [];
  let after = null;
  do {
    const data = await linearGraphql({ apiKey, query, variables: { ...variables, after } });
    const page = data?.issues;
    if (!page) throw new Error('Linear returned no issues connection; refusing to treat that as an empty result.');
    collected.push(...page.nodes.map(toNode));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return collected;
}

function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '');
}

function realStableTags() {
  return runGit(['tag', '--list', 'v*', '--sort=version:refname'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => STABLE_TAG_RE.test(t));
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
  const res = spawnSync('git', ['merge-base', '--is-ancestor', sha, `${tag}^{commit}`], { encoding: 'utf8' });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${sha} ${tag} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
  );
}

/**
 * Two credentials, chosen per call site rather than one ambient one.
 *
 * A fix reference points into the private monorepo, which the workflow's own
 * token cannot see at all — every read against it 404s, indistinguishable from
 * a deleted pull request. The App installation token that CAN see it is scoped
 * to that one repository, so it in turn cannot post the reply back onto an
 * issue here. Neither token can do both jobs, so the target repo picks.
 *
 * Absent a cross-repo token the ambient one is used and the 404 surfaces as an
 * ordinary per-candidate failure, which is why the entry point warns up front
 * when there is no such token: so those 404s are not read as deleted pull
 * requests.
 */
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

/**
 * The merge commit behind a pull request, or null if it never had one.
 *
 * Split out from the `gh` call so the distinction it draws is testable, because
 * that distinction decides whether a run goes red. A pull request closed
 * without merging is an ANSWER: there is no fix commit, which happens whenever
 * a ticket keeps the attachment from a superseded attempt while the fix lands
 * under a different number. Only a human editing Linear can put that right, so
 * it routes to the same warn-and-skip as a fix that has not shipped. A reply
 * shape nobody can account for still throws.
 */
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

/**
 * Where this product's changeset lives, given the repo the fix reference names.
 *
 * The monorepo carries three changeset directories and only one of them is this
 * product's. `public/agents/.changeset/` is a different product's release notes;
 * quoting it would put another team's copy in front of an Open Knowledge bug
 * reporter, and it would read plausibly enough that nobody would catch it. So
 * the directory is chosen by repo rather than found by searching the path for
 * `.changeset/` — a search matches all three, and the monorepo root has a stray
 * changeset sitting in it too.
 *
 * In the public mirror this subtree IS the repo root, so a fix reference naming
 * that repo wants the root directory.
 */
export function changesetDirFor(repo) {
  return repo === 'open-knowledge' ? '.changeset/' : 'public/open-knowledge/.changeset/';
}

/** The one changeset a pull request added, or null if it added none. */
export function findChangesetPath(filenames, { repo } = {}) {
  const dir = changesetDirFor(repo);
  const isChangeset = (name) =>
    name.startsWith(dir) && /^[^/]+\.md$/.test(name.slice(dir.length)) && !name.endsWith('/README.md');
  return filenames.map((name) => String(name).trim()).find(isChangeset) ?? null;
}

/**
 * The prose quoted back to the reporter is the changeset the fix shipped with,
 * which is already public release-notes copy. It is read from the fix pull
 * request's own changeset addition rather than from the ticket, so no internal
 * field is ever in reach.
 */
function realReadChangesetProse(_candidate, { fixReferences }) {
  const pull = fixReferences.find((ref) => ref.channel === 'pull-request');
  if (!pull) return null;

  let names;
  try {
    names = gh(
      ['api', `repos/${pull.owner}/${pull.repo}/pulls/${pull.number}/files`, '--paginate', '--jq', '.[].filename'],
      pull,
    );
  } catch (err) {
    throw new Error(`gh api pulls/${pull.number}/files failed: ${String(err?.stderr || err?.message || '').trim()}`);
  }

  const changesetPath = findChangesetPath(names.split('\n'), { repo: pull.repo });
  if (!changesetPath) return null;

  let raw;
  try {
    raw = gh(
      [
        'api',
        // Read at the PR head rather than at the default branch: the changeset
        // file is consumed and deleted when the release that shipped it was cut.
        `repos/${pull.owner}/${pull.repo}/contents/${changesetPath}?ref=refs/pull/${pull.number}/head`,
        '--jq',
        '.content',
      ],
      pull,
    );
  } catch (err) {
    throw new Error(`gh api contents/${changesetPath} failed: ${String(err?.stderr || err?.message || '').trim()}`);
  }

  const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  return parseChangeset(decoded);
}

/** Strip the `---`-delimited bump block; what remains is the release note. */
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
      ['api', `repos/${origin.owner}/${origin.repo}/issues/${origin.number}/comments`, '-f', `body=${text}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return;
  }
  if (origin.channel === 'discord-thread') {
    // The bot token never leaves Railway, so this goes through the deployed
    // bot's authenticated endpoint rather than carrying a Discord credential
    // into Actions. The release-announcement webhook is NOT an alternative: a
    // webhook is bound to one channel and could only reach threads inside it,
    // so a reply sent that way would land where the reporter never looks.
    const url = process.env.DISCORD_NOTIFY_URL;
    const token = process.env.DISCORD_NOTIFY_TOKEN;
    if (!url || !token) throw new Error('DISCORD_NOTIFY_URL / DISCORD_NOTIFY_TOKEN are required to reply on Discord');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: origin.threadId, content: text }),
    });
    if (!res.ok) {
      throw new Error(`notify endpoint returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    log('::notice::write-back: running in dry-run mode (set WRITE_BACK_MODE=live to arm reporter replies).');
  }

  const releaseTag = process.env.RELEASE_TAG;

  const stableTags = realStableTags();
  const versionFor = (node) =>
    deriveVersionForFixRefs({
      fixReferences: partitionAttachments(node.attachmentUrls ?? []).fixReferences,
      stableTags,
      findMirroredCommits: realFindMirroredCommits,
      contains: realContains,
      resolvePrMergeSha: realResolvePrMergeSha,
      log,
    });

  const classifyRelease = makeReleaseWindow({ releaseTag, stableTags });
  log(
    `::notice::write-back: scoped to ${releaseTag} and the ${DEFAULT_RELEASE_LOOKBACK} stable releases before it; ` +
      'anything shipped earlier is left alone.',
  );

  if (!String(process.env.CROSS_REPO_TOKEN ?? '').trim()) {
    log(
      `::warning::write-back: no CROSS_REPO_TOKEN, so reads against ${DEFAULT_PRIVATE_REPO} run on this repo's own ` +
        'token and will 404. Those 404s mean "not authorised", not "no such pull request".',
    );
  }

  const result = await runWriteBack({
    listCandidates: () => paginate({ apiKey, query: CANDIDATE_QUERY, variables: {} }),
    listChildren: (parentId) => paginate({ apiKey, query: CHILDREN_QUERY, variables: { parentId } }),
    versionFor,
    classifyRelease,
    readChangesetProse: (candidate, ctx) => realReadChangesetProse(candidate, ctx),
    postReply: realPostReply,
    recordNotification: async ({ issueId, url, title }) => {
      const data = await linearGraphql({
        apiKey,
        query:
          'mutation Mark($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }',
        variables: { input: { issueId, url, title } },
      });
      // A dropped marker is not cosmetic: it is what stops the next run
      // replying to the same reporter again.
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
