#!/usr/bin/env node
/**
 * Tell a reporter, at most once per channel, that the fix they reported is out.
 *
 * "A reporter", not "a bug reporter": the enumeration below does not narrow on the
 * Bug label, because whether someone hears back should not depend on how triage
 * classified what they raised.
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
  originAlreadyNotified,
  partitionAttachments,
} from './write-back-gate.mjs';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const RELEASES_TAG_BASE = 'https://github.com/inkeep/open-knowledge/releases/tag';
const DEFAULT_PRIVATE_REPO = 'inkeep/agents-private';
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const PAGE_SIZE = 50;

/**
 * The candidate enumeration: every completed ticket, and nothing narrower.
 *
 * It used to add `labels: { name: { eq: "Bug" } }`, and that label was the only
 * thing standing between a reporter and a reply. It is the wrong gate. A
 * community feature request that someone waited months for is exactly as
 * report-shaped as a bug, and triage that files it as `Feature` — or with only
 * a component label — made it permanently invisible here. Relabelling such a
 * ticket `Bug` is the other way out and is worse: the automated point-release
 * lane keys off that same label, so relabelling to fix a notification would
 * also change how the fix ships.
 *
 * What replaces it is not another server-side predicate but the gates that were
 * always downstream, promoted to run first: a ticket needs an origin this
 * workflow can reply to, and a fix reference that resolves to a released build.
 * Those are the two facts a reply actually depends on, and a ticket missing
 * either was never going to be posted to whatever its labels said.
 *
 * The cost of the wider net is enumeration volume, and it is paid in the
 * candidate loop rather than here: the origin check is pure and runs over the
 * attachments this query already returns, so the per-candidate children query
 * and the per-fix-reference `gh api` call are only reached by tickets that came
 * from outside. Linear's filter language has no attachment-existence predicate
 * that could have expressed it server-side, which is the same reason "not yet
 * notified" is absent from the filter and checked client-side.
 */
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
  return `${RELEASES_TAG_BASE}/v${v}${markerSuffixFor(originUrl)}`;
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
/**
 * Whether a fix reference names a repository this workflow can actually read.
 *
 * Two, and only two: this repo, and the private monorepo the mirror flows from.
 * The cross-repo token is an App installation scoped to the latter, so a fix
 * reference pointing anywhere else — and the Linear backlog is full of them,
 * from products that predate this one — is unreadable and always will be.
 *
 * Distinguishing that from an unreadable `agents-private` matters more than it
 * looks. Both surface as a bare 404, but one is a permanent fact about a stale
 * ticket and the other is the missing-permission bug this whole path was built
 * to fix. Suppressing 404s wholesale would have hidden the latter, so the test
 * is repo identity rather than the response.
 */
export function isFixRepoInRemit({ kind, owner, repo }, { defaultRepo = DEFAULT_PRIVATE_REPO, selfRepo } = {}) {
  // A raw commit SHA is resolved against local git history, not a repo API.
  if (kind === 'sha') return true;
  const target = `${owner}/${repo}`.toLowerCase();
  const reachable = [defaultRepo, selfRepo]
    .map((r) => String(r ?? '').trim().toLowerCase())
    .filter(Boolean);
  return reachable.includes(target);
}

/**
 * Is this parsed fix reference a pull request on the MIRROR side — the repo
 * this workflow runs on, when that repo is not also the private origin? The
 * second half matters: in a test or rehearsal run executing inside the private
 * monorepo itself, `GITHUB_REPOSITORY` equals the default private repo, and
 * its pull requests are private references that must keep the trailer-search
 * path.
 */
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
      // A pull request in this repo (the Copybara mirror lands every export
      // through one, and Linear's linkback attaches it to the ticket) merges a
      // commit that is already on the mirror side, so its SHA must not be
      // trailer-searched as if it were a private one: nothing carries
      // `GitOrigin-RevId: <mirror-sha>`, and treating it that way made the
      // whole ticket underivable. Recover the origin SHA from the merge
      // commit's own trailer and resolve THAT, so cherry-picked copies on
      // point-release tags are found too. A merge commit with no trailer — or
      // an ambiguous one that embedded someone else's footer — falls back to
      // containment of the merge SHA itself.
      // A batched sync PR (several rebased commits landing through one PR,
      // which only happens when the serialized mirror is catching up) makes
      // this trailer belong to the LAST sibling in the batch rather than the
      // reporter's fix. Highest-wins across refs keeps that error one-sided:
      // the reporter can be told a slightly later version, never an earlier
      // one that lacks their fix.
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

/**
 * Betas are cut several times a day, so three of them can span less than a day
 * and a quiet weekend would age a reporter out of the window before anyone was
 * told. The stable lookback counts releases that land roughly weekly, which is
 * why the same number does not serve both. Nothing is lost by the wider beta
 * floor: the marker, not the window, is what stops a second reply.
 */
export const DEFAULT_BETA_LOOKBACK = 10;

/**
 * Which channel a release tag belongs to, or null when it is neither.
 *
 * A bare `vX.Y.Z` is the stable promotion; `vX.Y.Z-beta.N` is a beta cut. Any
 * other shape (a release candidate someone tags by hand, a moved pointer) is
 * refused rather than guessed at, because every downstream decision keys off
 * this answer and a wrong one addresses the reporter about the wrong build.
 */
export function deriveChannel(releaseTag) {
  const tag = String(releaseTag ?? '').trim();
  if (STABLE_TAG_RE.test(tag)) return 'stable';
  if (/^v\d+\.\d+\.\d+-beta\.\d+$/.test(tag)) return 'beta';
  return null;
}

/** True when a version string names a stable build rather than a beta. */
export function isStableVersion(raw) {
  return /^\d+\.\d+\.\d+$/.test(
    String(raw ?? '')
      .trim()
      .replace(/^v/, ''),
  );
}

/**
 * `v0.36.0` and `0.36.0` both mean the same release; anything else means none.
 * Beta versions are accepted too, so the beta channel's window can scope
 * against the prerelease tags it is actually cutting.
 */
function normalizeVersion(raw) {
  const trimmed = String(raw ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(trimmed) ? trimmed : null;
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

  // `stableTags` is the raw `git tag --list v*` output, which carries the betas
  // too. The stable channel has to drop them here or its floor would be
  // computed over a list ten times denser than the stables it is counting, and
  // a lookback of three would reach back hours instead of weeks.
  const eligible = resolvedChannel === 'beta' ? () => true : (version) => isStableVersion(version);
  const known = [
    ...new Set(stableTags.map(normalizeVersion).filter(Boolean).filter(eligible)),
  ].sort(compareVersions);
  const atOrBelow = known.filter((v) => compareVersions(v, release) <= 0);
  // Keep the release plus `lookback` older ones; the entry just below that
  // block is the exclusive floor. Too little history to reach back that far
  // means everything at or below the release stays in.
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

/**
 * A failure that no later run will pick up, so a person has to.
 *
 * Every other per-candidate failure happens before the marker is written, which
 * means the next release run enumerates that ticket again and tries again by
 * itself. This one happens after, so the ticket looks notified to every future
 * run while the reporter was never actually told. The two need opposite
 * responses — wait versus act — and an operator reading a red job should not
 * have to infer which from the wording of an error message.
 */
export class NeedsHumanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsHumanError';
  }
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
  channel = 'stable',
  selfRepo = process.env.GITHUB_REPOSITORY,
  live = false,
  log = () => {},
}) {
  // No default. A missing window is not "notify about everything", it is a
  // caller that forgot to scope the run, and the difference between those two
  // readings is the entire back catalogue.
  if (typeof classifyRelease !== 'function') {
    throw new Error('runWriteBack requires classifyRelease; see makeReleaseWindow.');
  }
  // Also no default. An unknown repo would make every GitHub origin look like
  // somebody else's, so the run would skip the entire candidate list as
  // `origin-elsewhere` and exit 0 looking like a quiet, healthy release. Refusing
  // is the only reading of a missing GITHUB_REPOSITORY that cannot be mistaken
  // for good news.
  // The two-value domain every downstream ternary decides over. Checking it here
  // rather than at the first `composeReply` means a misconfigured caller is
  // refused before the children query and the changeset reads, not after them.
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

  // One candidate per attempt, so a ticket whose fix reference cannot be read
  // does not decide the fate of every reporter behind it in the list. The
  // failure is collected rather than swallowed: the caller fails the run once
  // everyone reachable has been told, which is strictly more than aborting on
  // the first bad reference told anyone.
  const processCandidate = async (candidate) => {
    const {
      origins: attachedOrigins,
      unrepliable,
      fixReferences,
    } = partitionAttachments(candidate.attachmentUrls ?? []);
    const origins = attachedOrigins.filter((origin) => isOriginRepliableFrom(origin, selfRepo));

    // Two cheap gates run before any network call, and their order is what makes
    // a label-free candidate list affordable. Everything below them costs a
    // GraphQL round trip for the children and a `gh api` call per fix reference;
    // everything at this point is a pure read of attachments the enumeration
    // already returned.
    //
    // First: is there anywhere to reply at all? A ticket with no origin, or one
    // whose only origins are issues in another product's repo, can never be
    // posted to from here no matter what else is true of it. A Slack archive is
    // the one shape that deliberately does NOT exit here: someone really is
    // waiting in that thread, so it stays on the full path and its warning can
    // still name the version they would have been told about, which is the whole
    // point of distinguishing it from silence. An uploaded file is not an origin
    // at all and exits here with everything else.
    if (origins.length === 0 && unrepliable.length === 0) {
      if (attachedOrigins.length > 0) {
        log(
          `::debug::write-back: ${candidate.identifier} reports from ` +
            `${attachedOrigins.map((o) => o.url).join(', ')}, outside ${selfRepo || 'this repo'}; ` +
            'this job has no standing to post there.',
        );
        skip(candidate.identifier, 'origin-elsewhere');
      } else {
        // Not every fix has a reporter. This is the ordinary case, not a fault.
        skip(candidate.identifier, 'no-origin');
      }
      return;
    }

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
        // "Nobody ever linked a pull request to this" and "a link exists and the
        // chain behind it is broken" both surface as an underivable version, and
        // they want opposite responses: the first is the ordinary state of a
        // ticket closed without a code change, the second is a fault worth
        // chasing. Now that the candidate list is no longer narrowed by label,
        // the first is much the commoner of the two, and folding it into a
        // warning would bury the fault under thousands of lines of routine.
        // Scoped to the unresolved nodes, not the whole tree. A fan-in where one
        // sibling resolved and another has no link at all would otherwise be
        // reported against the sibling that is fine, and the warning would tell
        // an operator to go check attachments that do not exist.
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

    // A beta run only has news when the earliest build carrying the fix is
    // itself a beta. When the first containing tag is a stable — a point release
    // that cherry-picked the fix straight onto the stable line, which happens
    // whenever the automated fix lane ships one — there is no beta to point at,
    // and the stable leg is the one that owns telling this reporter. Saying
    // "available now in beta v0.58.1" about a stable version would be wrong
    // twice: the channel and the promise of a follow-up.
    if (channel === 'beta' && isStableVersion(gate.version)) {
      skip(candidate.identifier, 'stable-covers-it');
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

    // Reaching here with no repliable origin means the ticket has only
    // unrepliable ones: the early gate above already returned on every other
    // shape. Kept on the full path precisely so this warning can name the
    // version, which is what makes it a report of a reachability gap rather than
    // one more line of silence.
    if (origins.length === 0) {
      // Names every origin that exists and cannot be answered, not just the
      // unrepliable ones. A ticket can carry a foreign-repo issue as well, and
      // calling the Slack link its "only" origin would hide that.
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
      // A marker for this origin under any OTHER version ordinarily means an
      // earlier reply already quoted the changeset here — a beta reply, most
      // often. It is a marker existing, not a reply confirmed delivered (see
      // the NeedsHumanError note below); this elides the quote on the
      // assumption that a marker usually means the reporter already read it,
      // rather than never eliding at all.
      const quotedBefore = originAlreadyNotified(attachmentUrls, origin.url);
      if (quotedBefore) {
        log(
          `::debug::write-back: ${origin.url} already carries a marker for an earlier version ` +
            `(${candidate.identifier}); any reply for this origin will omit the changeset quote.`,
        );
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
              quote: !quotedBefore,
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
            `(v${gate.version}, covers ${gate.coverage.join(', ')}, quoted=${!quotedBefore}).`,
        );
        posted.push({
          identifier: candidate.identifier,
          origin: origin.url,
          version: gate.version,
          dryRun: true,
          quoted: !quotedBefore,
        });
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
        // Past the point of no return. Re-raise as its own type, because the
        // generic "could not be processed" this lands in reads as retryable and
        // this one is not: the marker stands, so no later run will pick it up
        // and the only remaining fix is a reply posted by hand.
        throw new NeedsHumanError(
          `marker for ${origin.url} was written but the reply did NOT send (${err.message}). ` +
            'No future run will retry it; post the reply by hand — and since this marker now makes a ' +
            'later automated reply on this same origin assume its quote already landed, include it.',
        );
      }
      log(
        `::notice::write-back: replied to ${origin.url} for ${candidate.identifier} ` +
          `(v${gate.version}, quoted=${!quotedBefore}).`,
      );
      posted.push({
        identifier: candidate.identifier,
        origin: origin.url,
        version: gate.version,
        dryRun: false,
        quoted: !quotedBefore,
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

/**
 * A run that could not process every candidate is a failed run, even though it
 * ran to the end and may well have posted to most reporters. The verdict is
 * returned rather than thrown where it is decided, so that "errors must still
 * turn the job red" is one expression a test can hold on to instead of a branch
 * inside an entry point nothing can call.
 *
 * Red is red either way, but the two dispositions want opposite responses and
 * the message says which. A run that is red only because Linear wobbled needs
 * nobody to do anything; a marker written without its reply needs a person, and
 * saying so in the same breath as the failure is the difference between that
 * being noticed and it being read as one more flake.
 */
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

// --- workflow-runtime wiring (real Linear / git / gh / Discord boundary) ---

export const LINEAR_RETRY_ATTEMPTS = 3;
export const LINEAR_RETRY_BASE_MS = 500;
export const LINEAR_RETRY_CAP_MS = 8000;

/**
 * How long any one outbound request may go unanswered.
 *
 * A connection that is refused or dropped surfaces immediately, but one that is
 * accepted and then goes silent is left running by undici for five minutes:
 * half this job's entire budget, spent without a single word in the log. Two of
 * them outlast the job, so an unbounded request does not merely delay the retry,
 * it guarantees the retry is never spent and the run dies as a bare Actions
 * timeout carrying none of the disposition it exists to report.
 *
 * The ceiling is far above any answer either endpoint has a reason to be slow
 * about, so reaching it means silence rather than load.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Which HTTP replies from Linear are worth asking again about.
 *
 * A 4xx is Linear having read the request and rejected it — a bad credential, a
 * malformed query, a filter the schema does not have. Asking again produces the
 * same answer, so retrying only delays a correct failure and buries its message
 * under attempts. A 5xx is the opposite: the one seen in the wild was an Envoy
 * `connection termination` raised before authentication ran at all, so the edge
 * never reached the backend and the request as written was never judged. 429 is
 * Linear naming a wait out loud.
 *
 * The distinction earns its keep at this scale rather than in principle. One
 * enumeration makes several hundred sequential requests; meeting at least one
 * blip across them is nearer to expected than to unlucky, and a single one used
 * to fail the entire job.
 */
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

/**
 * Whether a throw out of `fetch` describes a connection that failed rather than
 * a request that was answered.
 *
 * Nothing was interpreted in that case — no status, no body — so the request is
 * in exactly the state a 5xx leaves it in and gets the same treatment. undici
 * reports these as a bare `TypeError: fetch failed` and hangs the real reason
 * off `cause`, so the chain is walked rather than the top-level message read.
 * An unrecognised throw is deliberately NOT retried: absent a reason to think
 * the connection was at fault, repeating it is guesswork.
 *
 * A request abandoned at its own deadline is matched by name rather than by
 * code: `AbortSignal.timeout` rejects with a DOMException whose `code` is the
 * numeric legacy 23, which the table of string codes below cannot see. Its
 * sibling `AbortError` is pointedly absent, because an abort no clock asked for
 * was somebody's decision and repeating the request would be overriding it.
 */
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

/** `Retry-After` in its delta-seconds form; the HTTP-date form falls through to backoff. */
export function parseRetryAfterSeconds(header) {
  const seconds = Number(String(header ?? '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * How long to wait before the next attempt.
 *
 * Half the exponential window plus a random slice of the other half. The random
 * part keeps concurrent retriers from re-colliding in lockstep after a shared
 * outage; keeping the first half fixed guarantees the wait is never so short
 * that the retry is just a second helping of the same hammering. An explicit
 * `Retry-After` wins over the computed window but is still capped, so a large
 * one cannot park the job for the length of its own timeout.
 */
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

/**
 * One Linear GraphQL call, retried when the failure says nothing about the
 * request itself.
 *
 * Both call sites are safe to repeat. The reads are reads. The one mutation
 * creates an attachment whose URL is deterministic in (origin, version), and
 * Linear treats that URL as an idempotent key against the issue — the same
 * property the cross-run at-most-once guarantee already rests on, which is
 * strictly stronger than repeating the call inside a single run. Retrying it
 * also closes a hole that not retrying leaves open: a marker that was written
 * but whose reply was lost in transit reads to the next run as `already
 * notified`, so the reporter is never told and nothing says so.
 *
 * Payload-level `errors` are never retried. A 200 carrying them means the query
 * was understood and refused, which is the 4xx case wearing a different status.
 */
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
        // Minted per attempt, so a retry starts with a fresh deadline rather
        // than inheriting the spent one. It stays live through the body reads
        // below, which is what bounds a reply that begins and then stops.
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
        // The status is the part that decides retryability, so reading the body
        // must not be able to take it away: the same dropped connection that
        // produced a 5xx can drop again mid-body.
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
        // A body that died in transit is the connection failing a beat later
        // than the cases above and gets the same treatment. A body that arrived
        // whole and simply is not JSON is not, and its SyntaxError says so.
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
        // Read at the PR head rather than at the default branch: the changeset
        // file is consumed and deleted when the release that shipped it was cut.
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
    // The bot token never leaves Railway, so this goes through the deployed
    // bot's authenticated endpoint rather than carrying a Discord credential
    // into Actions. The release-announcement webhook is NOT an alternative: a
    // webhook is bound to one channel and could only reach threads inside it,
    // so a reply sent that way would land where the reporter never looks.
    const url = process.env.DISCORD_NOTIFY_URL;
    const token = process.env.DISCORD_NOTIFY_TOKEN;
    if (!url || !token) throw new Error('DISCORD_NOTIFY_URL / DISCORD_NOTIFY_TOKEN are required to reply on Discord');
    // Deadlined but deliberately not retried: this runs after the marker is
    // written, so a second send could double-post. The deadline is what turns a
    // bot that stopped answering into the needs-human disposition the caller
    // raises, instead of a silent hang in the one state (marked, not delivered)
    // that nobody can infer from a job that simply ran out of time.
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
