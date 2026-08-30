/**
 * The decisions behind telling a reporter their fix is out: which of a
 * ticket's attachments is a place a human can be replied to, and whether
 * everything that descended from their report has actually gone out.
 *
 * Why this file does no IO at all. The two failure modes that matter here are
 * both silent-and-public: replying in the wrong place, and telling someone a
 * fix is out while part of what they reported is still open. Neither is caught
 * by watching a workflow go green, so the decisions have to be cheap enough to
 * test exhaustively, which means no Linear client, no fetch, no git, no clock.
 * The sibling `write-back.mjs` owns every boundary and imports this.
 *
 * ATTACHMENT CLASSIFICATION. A Linear ticket's attachments are a mixed bag: the
 * report's origin, the PRs and commits that fixed it, uploaded diagnostic
 * bundles, and links to wherever it was discussed. Confusing a fix reference
 * for an origin is how a bot ends up replying to its own pull request, so
 * GitHub pull and commit URLs are classified as fix references and can never
 * become origins no matter what else is missing.
 *
 * THE FAN-IN GATE. A single report routinely fans into several tickets. Telling
 * the reporter "fixed in v0.36.0" while one of those is still open is worse
 * than staying quiet, because it reads as a claim that everything they raised
 * is handled. So the gate blocks on EVERY non-canceled descendant, not only the
 * Bug-labelled ones: on the live tree this was designed against, two of six
 * children carry no labels at all, and one of those is still open. Gating on
 * the label would have made it invisible. Unlabelled descendants are reported
 * separately so the triage gap stays visible rather than being quietly
 * absorbed.
 *
 * Failing safe here means silence, never a false claim.
 */

const GITHUB_ISSUE_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i;
const GITHUB_PULL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const GITHUB_COMMIT_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})(?:[/?#].*)?$/i;
// Discord permalinks carry guild/channel[/message]; the channel segment is the
// forum thread's own id, which is what a reply is addressed to.
const DISCORD_THREAD_RE =
  /^https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?:\/(\d+))?(?:[/?#].*)?$/i;
const SLACK_ARCHIVE_RE = /^https?:\/\/[^/]*\.slack\.com\/archives\//i;
const LINEAR_UPLOAD_RE = /^https?:\/\/uploads\.linear\.app\//i;

// Accepts both channels' version strings: `0.59.1` and `0.59.0-beta.3`. The
// optional prerelease group is captured so ordering can honour semver
// precedence, where a beta ranks below the stable of the same X.Y.Z.
const RELEASE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

const RELEASES_URL = 'https://github.com/inkeep/open-knowledge/releases';
// Discord caps a message at 2000 characters. Bounding the quoted prose leaves
// room for the surrounding lines on either channel. This is not a rare guard:
// plenty of this project's release notes run past it — see the longer entries
// in packages/cli/CHANGELOG.md — so those replies end in a mid-sentence
// ellipsis and the rest of the note lives only on the releases page.
const MAX_PROSE_CHARS = 1200;

/**
 * What a single attachment URL is, for write-back purposes.
 *
 *   { kind: 'repliable-origin',   channel: 'github-issue' | 'discord-thread', ... }
 *   { kind: 'unrepliable-origin', channel: 'slack-archive' }
 *   { kind: 'evidence',           channel: 'linear-upload' }
 *   { kind: 'fix-reference',      channel: 'pull-request' | 'commit' }
 *   { kind: 'unknown' }
 *
 * `unrepliable-origin` exists as its own answer rather than collapsing into
 * `unknown` so the caller can say WHY it skipped: a Slack archive link names a
 * real report, in a thread someone is waiting in, that this workflow has no way
 * to post into. That is worth a warning rather than silence.
 *
 * An uploaded file is NOT that, and calling it one was a mistake worth naming.
 * `uploads.linear.app` is any file dragged onto any ticket: a screenshot, a
 * diagnostic zip, a log. Nobody is waiting inside it. While the enumeration was
 * narrowed to Bug tickets the difference rarely showed, because a bundle on a
 * bug ticket did imply a report. Workspace-wide it is simply an attachment, and
 * treating it as an origin would both keep every ticket carrying a screenshot on
 * the expensive path and produce a warning saying its "only origin" cannot be
 * replied to, when the ticket never had an origin at all.
 */
export function classifyAttachment(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return { kind: 'unknown', url };

  // Fix references are matched before origins on purpose: a pull request lives
  // on github.com just like an issue does, and reading one as a place to reply
  // would post the notification onto the fix instead of onto the report.
  const pull = GITHUB_PULL_RE.exec(url);
  if (pull) {
    return {
      kind: 'fix-reference',
      channel: 'pull-request',
      url,
      owner: pull[1],
      repo: pull[2],
      number: Number(pull[3]),
    };
  }

  const commit = GITHUB_COMMIT_RE.exec(url);
  if (commit) {
    return {
      kind: 'fix-reference',
      channel: 'commit',
      url,
      owner: commit[1],
      repo: commit[2],
      sha: commit[3].toLowerCase(),
    };
  }

  const issue = GITHUB_ISSUE_RE.exec(url);
  if (issue) {
    return {
      kind: 'repliable-origin',
      channel: 'github-issue',
      url,
      owner: issue[1],
      repo: issue[2],
      number: Number(issue[3]),
    };
  }

  const discord = DISCORD_THREAD_RE.exec(url);
  if (discord) {
    return { kind: 'repliable-origin', channel: 'discord-thread', url, threadId: discord[2] };
  }

  if (SLACK_ARCHIVE_RE.test(url)) {
    return { kind: 'unrepliable-origin', channel: 'slack-archive', url };
  }
  if (LINEAR_UPLOAD_RE.test(url)) {
    return { kind: 'evidence', channel: 'linear-upload', url };
  }

  return { kind: 'unknown', url };
}

/**
 * Split a ticket's attachments into the buckets the write-back needs.
 * Returns { origins, unrepliable, evidence, fixReferences } with the
 * classification objects, in attachment order.
 *
 * `fixReferences` keeps pull requests ahead of commits: a pull request resolves
 * to a merge commit whose mirrored copy is what tag containment walks, while a
 * bare commit URL may be one of many on a single ticket. Both shapes occur in
 * practice, so neither is treated as the only one.
 */
export function partitionAttachments(attachmentUrls = []) {
  const origins = [];
  const unrepliable = [];
  const evidence = [];
  const pulls = [];
  const commits = [];

  for (const raw of attachmentUrls) {
    const classified = classifyAttachment(raw);
    if (classified.kind === 'repliable-origin') origins.push(classified);
    else if (classified.kind === 'unrepliable-origin') unrepliable.push(classified);
    else if (classified.kind === 'evidence') evidence.push(classified);
    else if (classified.kind === 'fix-reference') {
      (classified.channel === 'pull-request' ? pulls : commits).push(classified);
    }
  }

  return { origins, unrepliable, evidence, fixReferences: [...pulls, ...commits] };
}

/**
 * Whether this workflow can actually post to an origin, from the repo it runs in.
 *
 * A Discord thread is reachable through the bot regardless of repo. A GitHub
 * issue is only reachable when it lives in THIS repo: the reply is posted with
 * the job's own `GITHUB_TOKEN`, which has no standing anywhere else.
 *
 * This matters far more now that the candidate query no longer filters by
 * label. The backlog spans several products, and a completed ticket over in
 * another one routinely carries an issue origin in that product's repo. Without
 * this check every one of them would be attempted, 403, and be collected as a
 * failure, turning a correctly-behaving run red on tickets it was never
 * supposed to speak about.
 */
export function isOriginRepliableFrom(origin, selfRepo) {
  if (origin?.channel === 'discord-thread') return true;
  if (origin?.channel !== 'github-issue') return false;
  const self = String(selfRepo ?? '')
    .trim()
    .toLowerCase();
  if (!self) return false;
  return self === `${origin.owner}/${origin.repo}`.toLowerCase();
}

/**
 * The query-string suffix that names a notification marker's origin.
 * Composed here so the sibling `notificationMarkerUrl` (in `write-back.mjs`,
 * which prefixes a release tag to build the full marker URL) and
 * `originAlreadyNotified` below share one encoding rather than two hand-rolled
 * copies drifting apart. `encodeURIComponent` escapes both `?` and `&`, so an
 * origin URL carrying its own query string cannot forge a false match against
 * this suffix.
 */
export function markerSuffixFor(originUrl) {
  return `?notified=${encodeURIComponent(String(originUrl ?? ''))}`;
}

/**
 * Whether this origin carries a notification marker for some earlier
 * version — checked against the origin alone, regardless of which version the
 * marker names, unlike the exact-match idempotency check `notificationMarkerUrl`
 * keys on (origin, version).
 *
 * This is a marker existing, not a reply confirmed delivered, and the two can
 * diverge: a marker is written before its reply posts, and a `postReply`
 * failure in between leaves the marker standing with nothing actually sent
 * (see the `NeedsHumanError` note where the marker is written, in
 * `write-back.mjs`). The caller uses this to decide whether to elide the
 * changeset quote on the assumption that a marker ordinarily means the
 * reporter already read it; in the rare case that assumption is wrong, the
 * operator following up on that `NeedsHumanError` is the one place with
 * standing to catch it, which is why that message says so.
 *
 * A deliberate trade this makes. Before `quote` existed, every reply carried
 * the full note regardless of what an earlier one on the same origin had
 * done, so a beta-leg `postReply` failure cost nothing beyond a delay: the
 * stable leg keyed a different marker and re-sent everything. That accidental
 * repair is what eliding gives up — a reporter whose only delivered reply
 * follows a failed one still learns the version and the tickets it covers,
 * but never what changed. The repair was largely a beta-leg effect: a
 * stable-leg failure ordinarily recomputes the same version and hits the
 * exact-marker skip, so nothing re-sends.
 * Accepted because that failure is visible on its own terms (a red run, an
 * `ACTION REQUIRED` message), not because it is rare.
 */
export function originAlreadyNotified(attachmentUrls, originUrl) {
  const suffix = markerSuffixFor(originUrl);
  return (attachmentUrls ?? []).some((u) => String(u ?? '').endsWith(suffix));
}

/** Numeric semver ordering. String comparison puts v0.9.0 above v0.36.0. */
export function compareVersions(a, b) {
  const ka = releaseVersionKey(a);
  const kb = releaseVersionKey(b);
  if (!ka) throw new Error(`not a version: '${a}'`);
  if (!kb) throw new Error(`not a version: '${b}'`);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

/**
 * Ordering key for a version string, or null if it is not one.
 *
 * The fourth component is 1 for a stable and 0 for a beta, so `0.59.0-beta.9`
 * sorts below `0.59.0` exactly as semver requires. Without it a plain
 * three-part compare calls them equal, and `highestVersion` over a fan-in
 * spanning both channels would pick whichever happened to come first.
 */
function releaseVersionKey(raw) {
  const m = RELEASE_VERSION_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const isStable = m[4] === undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), isStable ? 1 : 0, isStable ? 0 : Number(m[4])];
}

/** Highest of a non-empty version list, normalized without the leading `v`. */
export function highestVersion(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best === null ? null : String(best).trim().replace(/^v/, '');
}

/**
 * Decide whether everything descending from a report has shipped.
 *
 * Inputs:
 *   ticket        { identifier, stateType, labels? }
 *   descendants   [ same shape ]
 *   resolveVersion(node) -> version string | null   (injected; null means
 *                 "could not be derived", which is a reason to withhold, never
 *                 a reason to assume it shipped)
 *   log           injected annotation sink
 *
 * A ticket that has children is the report; its own state tracks triage rather
 * than a ship event, so the decision is made over its descendants. A ticket
 * with no children is evaluated alone, which is the common single-fix case.
 *
 * Three-way per node:
 *   shipped   completed and a version resolves    contributes its version
 *   neutral   canceled (won't-fix or duplicate)   contributes nothing, blocks nothing
 *   blocking  anything else                       withholds
 *
 * Returns { decision, version, coverage, blocking, unresolved, neutral,
 * unlabelledDescendants }. `unresolved` is the subset of `blocking` that is
 * completed but whose version could not be derived: routine "still open" and
 * "we could not work out where this went" deserve different annotations, and
 * the second one means something is wrong with the fix-reference chain.
 */
export function evaluateFanIn({ ticket, descendants = [], resolveVersion, log = () => {} }) {
  if (!ticket?.identifier) throw new Error('evaluateFanIn needs a ticket with an identifier');
  if (typeof resolveVersion !== 'function') throw new Error('evaluateFanIn needs a resolveVersion function');

  const considered = descendants.length > 0 ? descendants : [ticket];

  const coverage = [];
  const versions = [];
  const blocking = [];
  const unresolved = [];
  const neutral = [];
  const unlabelledDescendants = [];

  for (const node of considered) {
    if (descendants.length > 0 && (node.labels ?? []).length === 0) {
      unlabelledDescendants.push(node.identifier);
    }

    if (node.stateType === 'canceled') {
      neutral.push(node.identifier);
      continue;
    }
    if (node.stateType !== 'completed') {
      blocking.push(node.identifier);
      continue;
    }

    const version = resolveVersion(node);
    if (!version) {
      // Completed but unlocatable. Refusing here is the whole point of the
      // gate: naming a version we could not derive is the one outcome worse
      // than saying nothing.
      blocking.push(node.identifier);
      unresolved.push(node.identifier);
      continue;
    }
    coverage.push(node.identifier);
    versions.push(version);
  }

  coverage.sort();
  blocking.sort();
  unresolved.sort();

  if (unlabelledDescendants.length > 0) {
    log(
      `::notice::write-back: ${ticket.identifier} has descendants with no labels (${unlabelledDescendants.join(', ')}); ` +
        'they are gated on anyway, but the triage gap is worth closing.',
    );
  }

  if (blocking.length > 0 || coverage.length === 0) {
    const reason =
      blocking.length > 0
        ? `outstanding: ${blocking.join(', ')}`
        : 'nothing descending from it has shipped';
    log(`::notice::write-back: withholding on ${ticket.identifier} (${reason}).`);
    return {
      decision: 'withhold',
      version: null,
      coverage,
      blocking,
      unresolved,
      neutral,
      unlabelledDescendants,
    };
  }

  return {
    decision: 'notify',
    version: highestVersion(versions),
    coverage,
    blocking,
    unresolved,
    neutral,
    unlabelledDescendants,
  };
}

/**
 * The reply a reporter actually reads.
 *
 * The signature is the redaction mechanism. Everything a reporter should never
 * see lives on the Linear ticket: its internal title, its assignee, the
 * customer it was raised for, notes about work that has not shipped. None of
 * that is a parameter here, so no amount of downstream carelessness can leak
 * it. What can reach the reply is the changeset prose, which is written for
 * the public release notes and is already published, plus the derived
 * version, the ticket identifiers the reporter's own report fanned into, and
 * whether to quote the prose at all. Widening these parameters is the one
 * change to this file that needs a second look.
 *
 * Why `quote` exists. A fix that ships beta-then-stable gets two replies on
 * the same origin, and the second one has nothing new to say: whatever of the
 * note the first reply could fit — the full text, or as much of it as cleared
 * MAX_PROSE_CHARS — already reached this thread. `quote: false` drops the
 * prose block and leaves the rest — the opening line already says the fix is
 * out, the coverage line still lists every ticket it fanned into, and the
 * update instruction still says how to get it. That is a real answer on its
 * own, so the second reply is short rather than empty, and repeats nothing
 * rather than repeating a second, independently-trimmed copy of the first
 * reply's prose. The caller decides `quote` by checking whether an earlier
 * marker exists for this origin, not by channel: a fix that lands straight on
 * a stable (the point-release fast lane skips beta) gets exactly one reply
 * either way, and that one should always quote.
 *
 * The coverage line is not decoration. A report that fanned into three tickets
 * gets one reply, and without the list the reporter has no way to tell whether
 * the other two were handled or quietly dropped.
 *
 * Returns the reply text, or null when there is nothing truthful to say. An
 * empty changeset is the one case: a blank or version-only reply reads as a
 * claim with no content behind it, so the caller warns and posts nothing —
 * checked regardless of `quote`, since a changeset that does not exist is not
 * a fact this reply can stand on even when it isn't quoted.
 */
export function composeReply({
  changeset = {},
  version,
  originChannel,
  coverage = [],
  channel = 'stable',
  quote = true,
}) {
  const normalizedVersion = String(version ?? '')
    .trim()
    .replace(/^v/, '');
  if (!RELEASE_VERSION_RE.test(normalizedVersion)) {
    throw new Error(`composeReply needs a derived version, got '${version}'`);
  }
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`composeReply needs a channel of 'stable' or 'beta', got '${channel}'`);
  }

  const body = String(changeset.body ?? '').trim();
  const title = String(changeset.title ?? '').trim();
  const prose = body || title;
  if (!prose) return null;

  const lines = [openingLine(channel, normalizedVersion)];

  if (quote) {
    const trimmedProse =
      prose.length > MAX_PROSE_CHARS ? `${prose.slice(0, MAX_PROSE_CHARS).trimEnd()}...` : prose;
    lines.push('', trimmedProse);
  }

  if (coverage.length > 0) {
    lines.push('', `Covers ${[...coverage].sort().join(', ')}.`);
  }

  lines.push('', updateInstruction(originChannel, channel, normalizedVersion));

  return lines.join('\n');
}

/**
 * The desktop app is the promoted install path, so it is the only one named
 * here. A reporter who runs the CLI instead still upgrades from the same
 * release, and the npm command would only widen a reply whose job is to say the
 * thing shipped.
 *
 * Both channels render markdown, so the difference is the link form: GitHub
 * renders an inline link, while a bare URL on Discord expands into an embed
 * card unless it is wrapped in angle brackets.
 */
function updateInstruction(originChannel, channel = 'stable', version = '') {
  // A beta is not on the update channel the desktop app follows, so "update to
  // the latest" would send a reporter to a build that does not carry the fix.
  // The beta build has to be downloaded deliberately, and the wording says so.
  const action =
    channel === 'beta'
      ? `To try it ahead of that, download the v${version} beta from`
      : 'To pick it up, update to the latest desktop app from';
  const tail = channel === 'beta' ? ' once its installers have finished uploading' : '';
  if (originChannel === 'discord-thread') {
    return `${action} <${RELEASES_URL}>${tail}.`;
  }
  return `${action} [the releases page](${RELEASES_URL})${tail}.`;
}

/**
 * The claim the reply opens with, which is the part a reporter reads.
 *
 * The two channels make genuinely different claims and must not share wording.
 * A stable reply says the fix is out, full stop. A beta reply has to carry three
 * things at once: it is fixed, the build carrying it is a beta rather than the
 * channel their app follows, and a second message is coming when the stable
 * ships. That last one is a promise the stable leg keeps, and it is what makes
 * the two messages read as a sequence rather than as the same news sent twice.
 */
function openingLine(channel, version) {
  if (channel === 'beta') {
    // Deliberately not "available now". The dispatch this runs off fires when the
    // release is still a DRAFT, minutes to an hour before its installers finish
    // uploading, so a reporter sent to the releases page at that moment finds
    // nothing there. Saying it is going out, and that the build appears when its
    // installers do, is true at every point in that window.
    return (
      `This is fixed, and it is going out now on the Open Knowledge beta channel as v${version}. ` +
      'Thanks for the report. It will reach the stable channel in an upcoming release, ' +
      'and we will follow up here when it does.'
    );
  }
  return `This shipped in Open Knowledge v${version}. Thanks for the report.`;
}
