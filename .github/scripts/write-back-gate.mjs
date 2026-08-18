/**
 * The decisions behind telling a bug reporter their fix shipped: which of a
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

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

const RELEASES_URL = 'https://github.com/inkeep/open-knowledge/releases';
// Discord caps a message at 2000 characters. Bounding the quoted prose leaves
// room for the surrounding lines on either channel and keeps a pathological
// changeset from turning the reply into a wall.
const MAX_PROSE_CHARS = 1200;

/**
 * What a single attachment URL is, for write-back purposes.
 *
 *   { kind: 'repliable-origin',   channel: 'github-issue' | 'discord-thread', ... }
 *   { kind: 'unrepliable-origin', channel: 'slack-archive' | 'linear-upload' }
 *   { kind: 'fix-reference',      channel: 'pull-request' | 'commit' }
 *   { kind: 'unknown' }
 *
 * `unrepliable-origin` exists as its own answer rather than collapsing into
 * `unknown` so the caller can say WHY it skipped. A Slack archive link and a
 * diagnostic bundle both name a real report; there is simply nowhere in them to
 * post a reply, and that is worth a warning rather than silence.
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
    return { kind: 'unrepliable-origin', channel: 'linear-upload', url };
  }

  return { kind: 'unknown', url };
}

/**
 * Split a ticket's attachments into the three buckets the write-back needs.
 * Returns { origins, unrepliable, fixReferences } with the classification
 * objects, in attachment order.
 *
 * `fixReferences` keeps pull requests ahead of commits: a pull request resolves
 * to a merge commit whose mirrored copy is what tag containment walks, while a
 * bare commit URL may be one of many on a single ticket. Both shapes occur in
 * practice, so neither is treated as the only one.
 */
export function partitionAttachments(attachmentUrls = []) {
  const origins = [];
  const unrepliable = [];
  const pulls = [];
  const commits = [];

  for (const raw of attachmentUrls) {
    const classified = classifyAttachment(raw);
    if (classified.kind === 'repliable-origin') origins.push(classified);
    else if (classified.kind === 'unrepliable-origin') unrepliable.push(classified);
    else if (classified.kind === 'fix-reference') {
      (classified.channel === 'pull-request' ? pulls : commits).push(classified);
    }
  }

  return { origins, unrepliable, fixReferences: [...pulls, ...commits] };
}

/** Numeric semver ordering. String comparison puts v0.9.0 above v0.36.0. */
export function compareVersions(a, b) {
  const pa = SEMVER_RE.exec(String(a ?? '').trim());
  const pb = SEMVER_RE.exec(String(b ?? '').trim());
  if (!pa) throw new Error(`not a version: '${a}'`);
  if (!pb) throw new Error(`not a version: '${b}'`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
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
 * it. What can reach the reply is the changeset prose, which is written for the
 * public release notes and is already published, plus the derived version and
 * the ticket identifiers the reporter's own report fanned into. Widening these
 * parameters is the one change to this file that needs a second look.
 *
 * The coverage line is not decoration. A report that fanned into three tickets
 * gets one reply, and without the list the reporter has no way to tell whether
 * the other two were handled or quietly dropped.
 *
 * Returns the reply text, or null when there is nothing truthful to say. An
 * empty changeset is the one case: a blank or version-only reply reads as a
 * claim with no content behind it, so the caller warns and posts nothing.
 */
export function composeReply({ changeset = {}, version, originChannel, coverage = [] }) {
  const normalizedVersion = String(version ?? '')
    .trim()
    .replace(/^v/, '');
  if (!SEMVER_RE.test(normalizedVersion)) {
    throw new Error(`composeReply needs a derived version, got '${version}'`);
  }

  const body = String(changeset.body ?? '').trim();
  const title = String(changeset.title ?? '').trim();
  const prose = body || title;
  if (!prose) return null;

  const trimmedProse =
    prose.length > MAX_PROSE_CHARS ? `${prose.slice(0, MAX_PROSE_CHARS).trimEnd()}...` : prose;

  const lines = [
    `This shipped in Open Knowledge v${normalizedVersion}. Thanks for the report.`,
    '',
    trimmedProse,
  ];

  if (coverage.length > 0) {
    lines.push('', `Covers ${[...coverage].sort().join(', ')}.`);
  }

  lines.push('', updateInstruction(originChannel));

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
function updateInstruction(originChannel) {
  if (originChannel === 'discord-thread') {
    return `To pick it up, update to the latest desktop app from <${RELEASES_URL}>.`;
  }
  return `To pick it up, update to the latest desktop app from [the releases page](${RELEASES_URL}).`;
}
