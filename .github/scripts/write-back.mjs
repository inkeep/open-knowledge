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
 * git failure, a malformed GraphQL response) throws and exits non-zero rather
 * than being folded into silence, because a caller cannot tell a quiet run from
 * a broken one and would never look again.
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
 * Returns { posted, skipped, dryRun } where `skipped` carries a reason per
 * candidate, so a run that did nothing can be read as either "correctly quiet"
 * or "quietly broken".
 */
export async function runWriteBack({
  listCandidates,
  listChildren,
  versionFor,
  readChangesetProse,
  postReply,
  recordNotification,
  live = false,
  log = () => {},
}) {
  const posted = [];
  const skipped = [];
  const skip = (identifier, reason) => skipped.push({ identifier, reason });

  for (const candidate of await listCandidates()) {
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
      continue;
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
      continue;
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
      await postReply(origin, text);
      log(`::notice::write-back: replied to ${origin.url} for ${candidate.identifier} (v${gate.version}).`);
      posted.push({ identifier: candidate.identifier, origin: origin.url, version: gate.version, dryRun: false });
    }
  }

  return { posted, skipped, dryRun: !live };
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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function realResolvePrMergeSha({ owner, repo, number }) {
  let out;
  try {
    out = gh(['api', `repos/${owner}/${repo}/pulls/${number}`, '--jq', '.merged_at,.merge_commit_sha']);
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

/**
 * The prose quoted back to the reporter is the changeset the fix shipped with,
 * which is already public release-notes copy. It is read from the fix pull
 * request's own `.changeset/*.md` addition rather than from the ticket, so no
 * internal field is ever in reach.
 */
function realReadChangesetProse(_candidate, { fixReferences }) {
  const pull = fixReferences.find((ref) => ref.channel === 'pull-request');
  if (!pull) return null;

  let names;
  try {
    names = gh([
      'api',
      `repos/${pull.owner}/${pull.repo}/pulls/${pull.number}/files`,
      '--paginate',
      '--jq',
      '.[].filename',
    ]);
  } catch (err) {
    throw new Error(`gh api pulls/${pull.number}/files failed: ${String(err?.stderr || err?.message || '').trim()}`);
  }

  const changesetPath = names
    .split('\n')
    .map((s) => s.trim())
    .find((name) => /^\.changeset\/[^/]+\.md$/.test(name) && !name.endsWith('/README.md'));
  if (!changesetPath) return null;

  let raw;
  try {
    raw = gh([
      'api',
      // Read at the PR head rather than at the default branch: the changeset
      // file is consumed and deleted when the release that shipped it was cut.
      `repos/${pull.owner}/${pull.repo}/contents/${changesetPath}?ref=refs/pull/${pull.number}/head`,
      '--jq',
      '.content',
    ]);
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

  const result = await runWriteBack({
    listCandidates: () => paginate({ apiKey, query: CANDIDATE_QUERY, variables: {} }),
    listChildren: (parentId) => paginate({ apiKey, query: CHILDREN_QUERY, variables: { parentId } }),
    versionFor,
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

  console.log(JSON.stringify({ dryRun: result.dryRun, posted: result.posted.length, skipped: result.skipped }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::write-back: ${err.message}`);
    process.exit(1);
  });
}
