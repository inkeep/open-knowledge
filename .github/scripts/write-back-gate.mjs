const GITHUB_ISSUE_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i;
const GITHUB_PULL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const GITHUB_COMMIT_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})(?:[/?#].*)?$/i;
const DISCORD_THREAD_RE =
  /^https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?:\/(\d+))?(?:[/?#].*)?$/i;
const SLACK_ARCHIVE_RE = /^https?:\/\/[^/]*\.slack\.com\/archives\//i;
const LINEAR_UPLOAD_RE = /^https?:\/\/uploads\.linear\.app\//i;

const RELEASE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

const RELEASES_URL = 'https://github.com/inkeep/open-knowledge/releases';

const CONTACT_EMAIL_LINE_RE = /^ {0,3}[-*+]\s+Contact email:(.*)$/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ADDRESS_RE = /^[^\s@<>()[\]:]+@[^\s@<>()[\]]+\.[^\s@<>()[\].]+$/;
const ADDRESS_IN_TEXT_RE = /[^\s@<>()[\]:]+@[^\s@<>()[\]]+\.[^\s@<>()[\].]+/;
const INTERNAL_DOMAIN_RE = /(?:^|\.)inkeep\.[a-z]{2,}$/i;

export function parseContactEmail(description) {
  let fence = null;
  for (const line of String(description ?? '').split(/\r?\n/)) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length)
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const field = CONTACT_EMAIL_LINE_RE.exec(line);
    if (field) return addressFromField(field[1]);
  }
  return null;
}

function addressFromField(raw) {
  const value = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const mailto = /mailto:([^\s<>()]+)/i.exec(value)?.[1];
  let address = mailto ?? ADDRESS_IN_TEXT_RE.exec(value)?.[0] ?? '';
  try {
    address = decodeURIComponent(address);
  } catch {
    return null;
  }
  return ADDRESS_RE.test(address) ? address : null;
}

export function isInternalContactEmail(address) {
  return INTERNAL_DOMAIN_RE.test(
    String(address ?? '')
      .split('@')
      .at(-1),
  );
}

export function contactEmailOrigin(address, reportIdentifier, reportKind = 'bug-report') {
  return {
    kind: 'repliable-origin',
    channel: 'email',
    url: `mailto:${address.toLowerCase()}`,
    address,
    reportIdentifier,
    reportKind,
  };
}

export function classifyAttachment(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return { kind: 'unknown', url };

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

export function isOriginRepliableFrom(origin, selfRepo) {
  if (origin?.channel === 'discord-thread') return true;
  if (origin?.channel !== 'github-issue') return false;
  const self = String(selfRepo ?? '')
    .trim()
    .toLowerCase();
  if (!self) return false;
  return self === `${origin.owner}/${origin.repo}`.toLowerCase();
}

export function markerSuffixFor(originUrl) {
  return `?notified=${encodeURIComponent(String(originUrl ?? ''))}`;
}

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

function releaseVersionKey(raw) {
  const m = RELEASE_VERSION_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const isStable = m[4] === undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), isStable ? 1 : 0, isStable ? 0 : Number(m[4])];
}

export function highestVersion(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best === null ? null : String(best).trim().replace(/^v/, '');
}

export function evaluateFanIn({ ticket, descendants = [], resolveVersion, log = () => {} }) {
  if (!ticket?.identifier) throw new Error('evaluateFanIn needs a ticket with an identifier');
  if (typeof resolveVersion !== 'function')
    throw new Error('evaluateFanIn needs a resolveVersion function');

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

const RESOLVED_STATE_TYPES = new Set(['completed', 'canceled', 'duplicate']);

export function planIssueClose({ issueState, carriers = [], carriersComplete = true }) {
  if (issueState === 'closed') return { close: false, reason: 'already-closed', open: [] };
  if (issueState !== 'open') return { close: false, reason: 'not-an-open-issue', open: [] };
  if (!carriersComplete) return { close: false, reason: 'carriers-truncated', open: [] };
  if (carriers.length === 0) return { close: false, reason: 'no-carrier', open: [] };
  const open = carriers
    .filter((carrier) => !RESOLVED_STATE_TYPES.has(carrier.stateType))
    .map((carrier) => carrier.identifier ?? 'an unreadable ticket')
    .sort();
  if (open.length > 0) return { close: false, reason: 'open-carrier', open };
  return { close: true, reason: null, open: [] };
}

export function composeReply({
  changeset = {},
  version,
  originChannel,
  coverage = [],
  channel = 'stable',
  recoveryFrom = [],
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

  const lines = [
    ...(recoveryFrom.length > 0
      ? [
          `Correction to our earlier update: the release${recoveryFrom.length === 1 ? '' : 's'} we linked (${recoveryFrom.map((v) => `v${v}`).join(', ')}) ${recoveryFrom.length === 1 ? 'is' : 'are'} not available to download.`,
          '',
        ]
      : []),
    openingLine(channel, normalizedVersion, originChannel),
  ];

  if (coverage.length > 0 && originChannel !== 'email') {
    lines.push('', `Covers ${[...coverage].sort().join(', ')}.`);
  }

  lines.push('', updateInstruction(originChannel, channel, normalizedVersion));

  if (originChannel === 'email') {
    lines.push(
      '',
      'You are getting this email because you left this address when you sent the ' +
        'Open Knowledge team a report or feedback. Reply to reach the team.',
    );
  }

  return lines.join('\n');
}

export function composeEmailSubject({
  identifier,
  version,
  channel = 'stable',
  correction = false,
  reportKind = 'bug-report',
}) {
  const v = String(version ?? '')
    .trim()
    .replace(/^v/, '');
  const subject =
    reportKind === 'feedback'
      ? 'what you told us about Open Knowledge'
      : `your Open Knowledge report ${identifier}`;
  if (channel === 'beta') {
    return `${correction ? 'Correction: a' : 'A'} fix for ${subject} is in beta v${v}`;
  }
  const sentence = `${subject} is fixed in v${v}`;
  return correction
    ? `Correction: ${sentence}`
    : `${sentence[0].toUpperCase()}${sentence.slice(1)}`;
}

function updateInstruction(originChannel, channel, version) {
  const lead =
    channel === 'beta'
      ? 'Read the notes and download the beta on'
      : 'To pick it up, update to the latest desktop app. The notes are on';
  const url = `${RELEASES_URL}/tag/v${version}`;
  if (originChannel === 'discord-thread') {
    return `${lead} <${url}>.`;
  }
  if (originChannel === 'email') {
    return channel === 'beta'
      ? `Read the notes and download the beta at ${url}`
      : `To pick it up, get the latest Open Knowledge. The notes are at ${url}`;
  }
  return `${lead} [the release page](${url}).`;
}

function openingLine(channel, version, originChannel) {
  if (channel === 'beta') {
    return (
      `This fix is available in Open Knowledge beta v${version}. ` +
      `${thanks(originChannel)} It will reach the stable channel in an upcoming release, ` +
      `and we will ${originChannel === 'email' ? 'email you again' : 'follow up here'} when it does.`
    );
  }
  return `This shipped in Open Knowledge v${version}. ${thanks(originChannel)}`;
}

function thanks(originChannel) {
  return originChannel === 'email' ? 'Thanks for telling us.' : 'Thanks for the report.';
}
