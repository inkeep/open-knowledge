// Bug-lane evaluation for the Bug lane workflow
// (.github/workflows/bug-lane.yml): decide which merged-but-unreleased BUG
// FIXES should ship NOW as an automated cherry-pick point release, without
// waiting for their cycle's stable.
//
// WHY THIS LANE EXISTS. The fast soak tier qualifies whole CUTS, and one minor
// changeset anywhere in the pending pile disqualifies every cut until the
// cycle's stable ships. In a repo where features land daily, that starves the
// tier: a perfectly tagged bug fix merging mid-cycle waits out the full soak
// behind work that has nothing to do with it. This lane qualifies COMMITS
// instead: a fix whose own changesets are patch-only and bug-linked is
// cherry-picked onto the current stable through the existing point-release
// cascade, which synthesizes exactly the commit one linear history cannot
// contain — "last stable plus this fix and nothing else".
//
// WHAT QUALIFIES A COMMIT. Grouped by the commit that ADDED each pending
// changeset:
//   - every changeset the commit added is `patch` (a commit adding any minor
//     is feature work and stays with its cycle), AND
//   - at least one of those changesets traces to a Linear issue carrying the
//     Bug label, through the SAME chain the soak tier uses (changeset ->
//     adding-commit squash subject `(#N)` -> source-monorepo PR URL ->
//     Linear attachmentsForURL -> labels). One definition of "bug-linked",
//     shared by import, so the two lanes can never disagree.
//
// WHY RE-RELEASE IS STRUCTURALLY IMPOSSIBLE. Candidates are enumerated from
// the changesets still PENDING on main; a point-released fix's changeset is
// consumed by main-reset minutes later and disappears from the pile. Behind
// that: commits already contained in the newest stable are pre-filtered here,
// and a pick that would re-apply shipped work comes up empty and is refused by
// point-release's own guards. Every stable this lane produces therefore
// carries novel changesets.
//
// FAIL-SAFE, LIKE THE SOAK-TIER PREDICATE. A wrong SELECTION here never ships
// bad bytes — everything downstream re-guards (clean pick, delta-matches-fix,
// patch-only bump, DMG smoke before publish). So resolution failures degrade
// to "does not qualify" with a warning, and only infrastructure that prevents
// ANY answer (git itself failing) fails the tick loud.
//
// The workflow adds two stages this script deliberately does not own: a
// VERIFY stage that cherry-picks the batch onto the stable in the runner and
// runs the fast test tiers against the synthetic tree (the tree that actually
// ships, which no CI has otherwise run), and the DISPATCH of
// point-release.yml, gated on BUG_LANE_ARMED.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realGit } from '../../scripts/compute-stable-version.mjs';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { makeResolveChangesetPrUrl, makeResolveIssuesForUrl } from './select-beta-to-promote.mjs';

const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const DEFAULT_LINK_REPO = 'inkeep/agents-private';
const BUG_LABEL = 'Bug';

/**
 * Group pending changesets by the commit that added them and decide which
 * commits qualify for the bug lane. Pure; every boundary is injected.
 *
 *   pendingChangesets: [{ id, bump, addingSha, addingSubject }]
 *   isInStable(sha) -> boolean          (commit already contained in stable)
 *   resolveChangesetPrUrl(id) -> url|null
 *   resolveIssuesForUrl(url) -> { issues: [{identifier, labels}] } | { unresolvable }
 *
 * Returns { fixRefs, perCommit, warnings, reason }. `fixRefs` preserves the
 * input order of first appearance, which the caller supplies oldest-first so
 * the cherry-pick sequence matches merge order.
 */
export async function evaluateBugLane({
  pendingChangesets = [],
  isInStable,
  resolveChangesetPrUrl,
  resolveIssuesForUrl,
  bugLabel = BUG_LABEL,
}) {
  const warnings = [];
  if (pendingChangesets.length === 0) {
    return { fixRefs: [], perCommit: [], warnings, reason: 'no-pending-changesets' };
  }

  const byCommit = new Map();
  for (const cs of pendingChangesets) {
    if (!cs?.addingSha) {
      warnings.push(`no-adding-commit ${cs?.id ?? '?'}`);
      continue;
    }
    if (!byCommit.has(cs.addingSha)) {
      byCommit.set(cs.addingSha, { sha: cs.addingSha, subject: cs.addingSubject ?? '', changesets: [] });
    }
    byCommit.get(cs.addingSha).changesets.push(cs);
  }

  const wanted = String(bugLabel).toLowerCase();
  const perCommit = [];
  const fixRefs = [];

  for (const commit of byCommit.values()) {
    const entry = {
      sha: commit.sha,
      subject: commit.subject,
      changesets: commit.changesets.map((c) => c.id),
      qualifies: false,
      reason: null,
      linkedIssues: [],
    };
    perCommit.push(entry);

    // A commit already inside the stable has nothing left to ship. This is
    // where restored-changeset chores land once their commit predates the
    // stable — picking one would re-apply a whole unrelated batch.
    let contained;
    try {
      contained = isInStable(commit.sha);
    } catch (err) {
      warnings.push(`containment-error ${commit.sha}: ${err.message}`);
      entry.reason = 'containment-error';
      continue;
    }
    if (contained) {
      entry.reason = 'already-in-stable';
      continue;
    }

    if (!commit.changesets.every((c) => c.bump === 'patch')) {
      entry.reason = 'not-patch-only';
      continue;
    }

    // Any one Bug-labeled issue across the commit's changesets qualifies it;
    // per-changeset resolution failures degrade to "this changeset carries no
    // link" rather than disqualifying the tick.
    for (const cs of commit.changesets) {
      let url;
      try {
        url = resolveChangesetPrUrl(cs.id);
      } catch (err) {
        warnings.push(`changeset-pr-error ${cs.id}: ${err.message}`);
        continue;
      }
      if (!url) {
        warnings.push(`changeset-pr-unresolved ${cs.id}`);
        continue;
      }
      let resolved;
      try {
        resolved = await resolveIssuesForUrl(url);
      } catch (err) {
        warnings.push(`issues-error ${url}: ${err.message}`);
        continue;
      }
      if (resolved?.unresolvable) {
        warnings.push(`issues-unresolvable ${url}: ${resolved.unresolvable}`);
        continue;
      }
      for (const issue of resolved?.issues ?? []) {
        const labels = Array.isArray(issue?.labels) ? issue.labels : [];
        if (labels.some((name) => String(name).toLowerCase() === wanted)) {
          entry.linkedIssues.push(issue?.identifier || url);
        }
      }
    }

    if (entry.linkedIssues.length === 0) {
      entry.reason = 'not-bug-linked';
      continue;
    }

    entry.qualifies = true;
    entry.reason = 'patch-only-and-bug-linked';
    fixRefs.push(commit.sha);
  }

  return {
    fixRefs,
    perCommit,
    warnings,
    reason: fixRefs.length > 0 ? 'candidates' : 'no-qualifying-fixes',
  };
}

/**
 * Qualifying sha -> the Bug tickets that qualified it. Only qualifying commits
 * are included: a rejected commit's links describe why it was NOT picked, and
 * surfacing them downstream would invite a reader to think it shipped.
 */
export function ticketsByRef(result) {
  const out = {};
  for (const c of result.perCommit) {
    if (c.qualifies && c.linkedIssues.length > 0) out[c.sha] = [...c.linkedIssues];
  }
  return out;
}

// --- workflow-runtime wiring (real git boundary) ---

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', env: gitCleanEnv() });
}

function realNewestStableTag() {
  for (const line of runGit(['tag', '--list', 'v*', '--sort=-version:refname']).split('\n')) {
    const t = line.trim();
    if (STABLE_TAG_RE.test(t)) return t;
  }
  return null;
}

/**
 * Is this commit's change already in the stable?
 *
 * Asked by CONTENT, not by lineage. A stable is cut by cherry-picking onto the
 * previous stable, so the shipped copy of a fix is a DIFFERENT commit than the
 * one on main and no ancestry test can see it. Asking only the lineage
 * question re-qualifies a fix the lane itself just released; the pick then
 * lands empty, which downstream reads as a conflict and pages a refusal saying
 * the fix depends on later work — the exact opposite of the truth.
 *
 * Exported as a factory, like the resolver boundaries beside it, so the git
 * behavior is exercised against a real repository rather than asserted about.
 */
export function makeIsInStable(stable, git = (args) => spawnSync('git', args, { encoding: 'utf8', env: gitCleanEnv() })) {
  return (sha) => {
    // Ancestry first: exact, cheap, and the common case for a fix that has not
    // been released yet. Three-way, matching the sibling selectors: exit 0 is
    // contained, exit 1 a clean miss, anything else an infrastructure failure
    // that must not read as "not contained" — the pure core degrades that
    // commit with a containment-error warning instead.
    const ancestry = git(['merge-base', '--is-ancestor', sha, stable]);
    if (ancestry.status === 0) return true;
    if (ancestry.status !== 1) {
      throw new Error(
        `git merge-base --is-ancestor ${sha} ${stable} failed (exit ${ancestry.status}): ${ancestry.error?.message ?? String(ancestry.stderr || '').trim()}`,
      );
    }
    // `git cherry <upstream> <head> <limit>` restricted to this one commit: it
    // prints "- <sha>" when an equivalent patch is already upstream and
    // "+ <sha>" when it is not. This is git's own duplicate detection, the
    // same equivalence rebase uses to drop already-applied commits.
    //
    // A failure here is deliberately NOT rethrown. Ancestry has already
    // answered "no", so falling through returns exactly what this function
    // returned before patch-equivalence existed — never a regression — and the
    // verify stage's empty-pick guard still catches whatever slips past.
    // Throwing would turn a rare git hiccup into a containment-error that
    // disqualifies a genuinely shippable fix.
    const equivalent = git(['cherry', stable, sha, `${sha}^`]);
    if (equivalent.status !== 0) return false;
    return String(equivalent.stdout || '')
      .trimStart()
      .startsWith('-');
  };
}

/**
 * The pending pile at HEAD, oldest adding commit first so the cherry-pick
 * batch replays in merge order. `%x1f` keeps subjects with any character out
 * of the field framing.
 */
function realPendingChangesets() {
  const ids = runGit(['ls-tree', '--name-only', 'HEAD', '.changeset/'])
    .split('\n')
    .map((s) => s.trim())
    .filter((p) => p.endsWith('.md') && !p.endsWith('README.md'))
    .map((p) => p.replace(/^\.changeset\//, '').replace(/\.md$/, ''));

  const entries = [];
  for (const id of ids) {
    // The canonical bump parser (max rank across every package the changeset
    // names). A first-match parse would read a mixed patch+minor changeset as
    // patch and let feature work into the lane.
    const bump = realGit.bumpTypeOf('HEAD', id);
    const line = runGit([
      'log',
      '--diff-filter=A',
      '-1',
      '--format=%H%x1f%ct%x1f%s',
      '--',
      `.changeset/${id}.md`,
    ]).trim();
    const [sha, commitTime, subject] = line.split('\x1f');
    entries.push({ id, bump, addingSha: sha || null, addingTime: Number(commitTime) || 0, addingSubject: subject ?? '' });
  }
  entries.sort((a, b) => a.addingTime - b.addingTime);
  return entries;
}

async function main() {
  const stable = realNewestStableTag();
  if (!stable) {
    console.log('::notice::bug-lane: no stable tag exists yet; nothing to point-release over.');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'fix_refs=\nstable=\n');
    return;
  }

  const result = await evaluateBugLane({
    pendingChangesets: realPendingChangesets(),
    isInStable: makeIsInStable(stable),
    resolveChangesetPrUrl: makeResolveChangesetPrUrl(process.env.LINK_REPO || DEFAULT_LINK_REPO),
    resolveIssuesForUrl: makeResolveIssuesForUrl(process.env.LINEAR_API_KEY),
  });

  for (const w of result.warnings) console.log(`::warning::bug-lane: ${w}`);
  for (const c of result.perCommit) {
    console.log(
      `::notice::bug-lane: ${c.sha.slice(0, 9)} "${c.subject.slice(0, 72)}" -> ${c.reason}` +
        `${c.linkedIssues.length > 0 ? ` [${c.linkedIssues.join(', ')}]` : ''}`,
    );
  }
  console.log(
    result.fixRefs.length > 0
      ? `::notice::bug-lane: ${result.fixRefs.length} qualifying fix(es) over ${stable}: ${result.fixRefs.join(', ')}`
      : `::notice::bug-lane: no qualifying fixes this tick (${result.reason}).`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `fix_refs=${result.fixRefs.join(',')}`,
        `stable=${stable}`,
        // sha -> the Bug tickets that qualified it, so a refusal page can name
        // the bug a reader recognises instead of only a SHA. One line: the map
        // is bounded by the qualifying set, which is single digits.
        `fix_tickets=${JSON.stringify(ticketsByRef(result))}`,
        '',
      ].join('\n'),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::bug-lane: ${err.message}`);
    process.exit(1);
  });
}
