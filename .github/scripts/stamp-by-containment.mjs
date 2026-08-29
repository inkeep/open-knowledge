#!/usr/bin/env node
/**
 * Make the STABLE release on a Linear ticket mean "the earliest stable release
 * whose history contains the fix".
 *
 * Why this exists alongside the release CLI's own sync. `linear-release sync`
 * answers a different question: "which pull requests fall inside this cut's
 * scan range". That is a forward, per-cut delta, and it is the right answer for
 * a BETA — a beta genuinely reports what is new in it. It is the wrong answer
 * for a stable, where the useful fact is which build a user must install to get
 * the fix. Nothing in the CLI computes containment, so a ticket lands on
 * whichever cut happened to sweep it up, and can land on several.
 *
 * Why containment is not a date comparison. "The newest release published after
 * the fix merged" is wrong here: point releases are cut off the previous stable
 * rather than off `main`, so a higher tag can publish later yet not contain the
 * commit. Worse, a fix that is cherry-picked onto a point-release line exists at
 * TWO mirrored commits; comparing only the mainline copy reports a version later
 * than the one that actually first carried the fix. The shared resolver already
 * walks every mirrored copy and returns the lowest containing tag, which is why
 * this imports it rather than re-deriving containment.
 *
 * What it will not do.
 *   - It never touches a BETA attachment. Those are correct per-cut deltas.
 *   - It never acts on a ticket whose fix commit cannot be resolved. Refusing is
 *     the same contract the reporter notifier uses: a stamp nobody can verify is
 *     worse than the absence of one, and removing an existing stamp on a hunch
 *     would destroy a possibly-correct human edit.
 *   - It never creates a release. If the containing stable has no release object
 *     the ticket is reported and skipped; minting releases belongs to the cut.
 *
 * Arming. Dry run is the default and the credential alone does not arm it: this
 * writes to a shared workspace, so an operator wiring up a key should not
 * thereby start rewriting everyone's tickets. Set STAMP_MODE=live for real
 * writes.
 *
 * Usage:
 *   LINEAR_API_KEY=... node .github/scripts/stamp-by-containment.mjs
 *   LINEAR_API_KEY=... STAMP_MODE=live node .github/scripts/stamp-by-containment.mjs
 *
 * Must run inside a full clone (`fetch-depth: 0`, `fetch-tags: true`) — the
 * containment walk needs every stable tag and full history.
 *
 * Fail-loud contract, matching the sibling release scripts: "nothing to
 * reconcile" and "this fix is not in any stable yet" are real ANSWERS and exit
 * 0. A missing credential is an answer too. Any infra error (Linear
 * unreachable, a git failure) exits non-zero rather than collapsing into
 * silence, because a caller cannot tell a quiet run from a broken one.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  realContains,
  realFindMirroredCommits,
  realReleaseTags,
  resolveShippedVersion,
} from './resolve-shipped-version.mjs';

const BETA_VERSION_RE = /-beta\.\d+$/;
const PRIVATE_PR_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const PRIVATE_REPO = 'inkeep/agents-private';

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

/** A release object is a beta iff its version carries a prerelease counter. */
export function isBetaRelease(release) {
  return BETA_VERSION_RE.test(String(release?.version ?? ''));
}

/**
 * Decide what to change on one ticket.
 *
 * `evidence` is the crux, because two very different situations both yield "no
 * containing tag" and only one of them justifies removing a stamp:
 *
 *   shipped            - a containing stable was found.
 *   proven-not-shipped - the fix commit WAS located in the mirror and every tag
 *                        was walked; none contain it. A stable stamp here names
 *                        a release that demonstrably does not carry the fix, so
 *                        it is withdrawn.
 *   unresolvable       - the fix commit could not be located at all (no linked
 *                        pull request, or nothing in the mirror carries its
 *                        trailer). This is an absence of evidence, NOT evidence
 *                        of absence: a merge-queue artifact SHA, a revert, a
 *                        mislinked pull request, or a fix predating the mirror
 *                        all land here while the existing stamp may be right.
 *                        Nothing is touched.
 *
 * Collapsing the last two would silently strip correct stamps, which is the
 * opposite of what this pass exists to do.
 *
 * Returns `{ action, add, remove, reason }` where action is one of
 * `noop | attach | reattach | skip`.
 */
export function planTicketReconciliation({
  attachedReleases,
  shippedTag,
  evidence,
  releaseByVersion,
}) {
  if (evidence === 'unresolvable') {
    return { action: 'skip', add: [], remove: [], reason: 'unresolvable-fix-commit' };
  }

  const stables = (attachedReleases ?? []).filter((r) => !isBetaRelease(r));

  if (!shippedTag) {
    return stables.length === 0
      ? { action: 'noop', add: [], remove: [], reason: 'not-in-any-stable' }
      : {
          action: 'reattach',
          add: [],
          remove: stables.map((r) => r.id),
          reason: 'not-in-any-stable',
        };
  }

  const wantVersion = shippedTag.replace(/^v/, '');
  const want = releaseByVersion.get(wantVersion);
  if (!want) {
    return { action: 'skip', add: [], remove: [], reason: `no-release-object:${wantVersion}` };
  }

  const already = stables.some((r) => r.id === want.id);
  const wrong = stables.filter((r) => r.id !== want.id);
  if (already && wrong.length === 0) {
    return { action: 'noop', add: [], remove: [], reason: 'already-correct' };
  }
  return {
    action: already ? 'reattach' : 'attach',
    add: already ? [] : [want.id],
    remove: wrong.map((r) => r.id),
    reason: `earliest-containing:${wantVersion}`,
  };
}

/** Summary counts for the closing report. */
export function summarize(plans) {
  const counts = { noop: 0, attach: 0, reattach: 0, skip: 0 };
  for (const p of plans) counts[p.plan.action] = (counts[p.plan.action] ?? 0) + 1;
  return counts;
}

// --- IO shell ---

async function linear(query, variables) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      authorization: process.env.LINEAR_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`linear HTTP ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.errors) throw new Error(`linear graphql: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

/**
 * PR -> merge commit, through the API because the private repo is not checked
 * out here.
 *
 * Distinguishes the two outcomes the caller must not conflate: an unmerged PR
 * has no fix commit and returns null, while a failed call THROWS. Swallowing a
 * rate limit or an expired token would make every ticket look unlinked, and the
 * run would report a wall of benign-looking skips instead of going red.
 *
 * Separate from the sibling resolver's equivalent because this one has to
 * inject the cross-repo token the bridge App mints.
 */
function prMergeSha({ owner, repo, number }) {
  const env = { ...process.env };
  if (process.env.CROSS_REPO_TOKEN) env.GH_TOKEN = process.env.CROSS_REPO_TOKEN;
  let out;
  try {
    out = execFileSync('gh', ['api', `repos/${owner}/${repo}/pulls/${number}`, '--jq', '.merged_at,.merge_commit_sha'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err?.stderr || '');
    // A deleted or never-visible PR is an answer; anything else is infra.
    if (/HTTP 404/i.test(stderr)) return null;
    throw new Error(`gh api repos/${owner}/${repo}/pulls/${number} failed: ${stderr.trim().slice(0, 200)}`);
  }
  const [mergedAt, sha] = out.split('\n').map((s) => s.trim());
  if (!mergedAt || mergedAt === 'null') return null;
  return /^[0-9a-f]{40}$/i.test(sha || '') ? sha.toLowerCase() : null;
}

// Attachments are fetched separately rather than nested three deep. Linear
// scores query complexity as roughly the product of the page sizes, and
// releases x issues x attachments in one shot exceeds the cap outright.
// Every connection carries an explicit page size whose `hasNextPage` is
// checked, because a silently truncated list would drop a ticket's fix pull
// request and demote it to a benign-looking skip.
const RELEASES_QUERY = `query($after:String){
  releases(first:25, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{ id name version
      issues(first:50){ pageInfo{ hasNextPage } nodes{ id identifier } } } } }`;

const ATTACHMENTS_QUERY = `query($ids:[ID!], $after:String){
  issues(filter:{ id:{ in:$ids } }, first:25, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{ id attachments(first:50){ pageInfo{ hasNextPage } nodes{ url } } } } }`;

async function fetchAttachments(issueIds) {
  const byIssue = new Map();
  for (let i = 0; i < issueIds.length; i += 25) {
    const ids = issueIds.slice(i, i + 25);
    let after = null;
    for (;;) {
      const page = (await linear(ATTACHMENTS_QUERY, { ids, after })).issues;
      for (const n of page.nodes) {
        if (n.attachments.pageInfo.hasNextPage) {
          throw new Error(`issue ${n.id} has more attachments than one page; paginate before trusting this run`);
        }
        byIssue.set(n.id, n.attachments.nodes.map((a) => a.url));
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  return byIssue;
}

async function fetchPipeline() {
  const releases = [];
  let after = null;
  for (;;) {
    const page = (await linear(RELEASES_QUERY, { after })).releases;
    releases.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  for (const r of releases) {
    if (r.issues.pageInfo.hasNextPage) {
      throw new Error(`release ${r.name} has more issues than one page; paginate before trusting this run`);
    }
  }

  const issueIds = [...new Set(releases.flatMap((r) => r.issues.nodes.map((i) => i.id)))];
  const attachmentsByIssue = await fetchAttachments(issueIds);
  const releaseByVersion = new Map(releases.map((r) => [String(r.version), r]));
  const tickets = new Map();
  for (const r of releases) {
    for (const i of r.issues.nodes) {
      const t = tickets.get(i.identifier) ?? {
        id: i.id,
        identifier: i.identifier,
        prs: [
          ...new Set((attachmentsByIssue.get(i.id) ?? []).filter((u) => PRIVATE_PR_RE.test(u ?? ''))),
        ],
        attachedReleases: [],
      };
      t.attachedReleases.push(r);
      tickets.set(i.identifier, t);
    }
  }
  return { releaseByVersion, tickets: [...tickets.values()] };
}

/**
 * Earliest stable tag containing any of a ticket's fix commits, plus how much
 * we actually know.
 *
 * `not-mirrored` from the resolver means the commit was never located, so it
 * contributes NO evidence — only a `not-in-any-stable` verdict, which required
 * finding the commit and walking every tag, can justify withdrawing a stamp.
 */
function resolveTicket(ticket, releaseTags, rank) {
  let best = null;
  let provenNotShipped = false;
  for (const url of ticket.prs) {
    const m = PRIVATE_PR_RE.exec(url);
    if (!m) continue;
    const [owner, repo] = [m[1], m[2]];
    if (`${owner}/${repo}` !== PRIVATE_REPO) continue;
    const sha = prMergeSha({ owner, repo, number: Number(m[3]) });
    if (!sha) continue;
    const r = resolveShippedVersion({
      privateSha: sha,
      // Written out rather than shorthand: the resolver's parameter is named for
      // the stable channel it defaults to, but it documents the raw
      // `git tag --list v*` output as what it wants, betas included.
      stableTags: releaseTags,
      findMirroredCommits: realFindMirroredCommits,
      contains: realContains,
    });
    if (r.shipped) {
      if (best === null || rank.get(r.tag) < rank.get(best)) best = r.tag;
    } else if (r.reason === 'not-in-any-stable') {
      provenNotShipped = true;
    }
  }
  if (best) return { evidence: 'shipped', shippedTag: best };
  if (provenNotShipped) return { evidence: 'proven-not-shipped', shippedTag: null };
  return { evidence: 'unresolvable', shippedTag: null };
}

async function main() {
  const live = process.env.STAMP_MODE === 'live';
  if (!process.env.LINEAR_API_KEY) {
    log('::notice::LINEAR_API_KEY is not set - nothing to reconcile.');
    return;
  }

  const releaseTags = realReleaseTags();
  const sorted = releaseTags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t.trim())).map((t) => t.trim());
  const rank = new Map(sorted.map((t, i) => [t, i]));

  const { releaseByVersion, tickets } = await fetchPipeline();
  log(`Considering ${tickets.length} ticket(s) across ${releaseByVersion.size} release(s).`);

  const plans = [];
  for (const ticket of tickets) {
    const { evidence, shippedTag } = resolveTicket(ticket, releaseTags, rank);
    const plan = planTicketReconciliation({
      attachedReleases: ticket.attachedReleases,
      shippedTag,
      evidence,
      releaseByVersion,
    });
    plans.push({ ticket, plan });
  }

  for (const { ticket, plan } of plans) {
    if (plan.action === 'noop') continue;
    const attached = ticket.attachedReleases.map((r) => r.name).join(', ');
    log(`${live ? 'APPLY' : 'DRY '} ${ticket.identifier}: ${plan.action} (${plan.reason}) [was: ${attached}]`);
    if (!live || (plan.add.length === 0 && plan.remove.length === 0)) continue;
    await linear(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: ticket.id, in: { addedReleaseIds: plan.add, removedReleaseIds: plan.remove } },
    );
  }

  const counts = summarize(plans);
  log(
    `${live ? 'Applied' : 'Dry run'}: ${counts.attach} attach, ${counts.reattach} reattach, ` +
      `${counts.skip} skipped, ${counts.noop} already correct.`,
  );
  if (!live) log('Set STAMP_MODE=live to apply.');
  console.log(JSON.stringify({ live, counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::stamp-by-containment: ${err.message}`);
    process.exit(1);
  });
}
