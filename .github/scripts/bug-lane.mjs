import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realGit } from '../../scripts/compute-stable-version.mjs';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { makeResolveChangesetPrUrl, makeResolveIssuesForUrl } from './select-beta-to-promote.mjs';

const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const DEFAULT_LINK_REPO = 'inkeep/agents-private';
const BUG_LABEL = 'Bug';

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

export function ticketsByRef(result) {
  const out = {};
  for (const c of result.perCommit) {
    if (c.qualifies && c.linkedIssues.length > 0) out[c.sha] = [...c.linkedIssues];
  }
  return out;
}

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

export function makeIsInStable(stable, git = (args) => spawnSync('git', args, { encoding: 'utf8', env: gitCleanEnv() })) {
  return (sha) => {
    const ancestry = git(['merge-base', '--is-ancestor', sha, stable]);
    if (ancestry.status === 0) return true;
    if (ancestry.status !== 1) {
      throw new Error(
        `git merge-base --is-ancestor ${sha} ${stable} failed (exit ${ancestry.status}): ${ancestry.error?.message ?? String(ancestry.stderr || '').trim()}`,
      );
    }
    const equivalent = git(['cherry', stable, sha, `${sha}^`]);
    if (equivalent.status !== 0) return false;
    return String(equivalent.stdout || '')
      .trimStart()
      .startsWith('-');
  };
}

function realPendingChangesets() {
  const ids = runGit(['ls-tree', '--name-only', 'HEAD', '.changeset/'])
    .split('\n')
    .map((s) => s.trim())
    .filter((p) => p.endsWith('.md') && !p.endsWith('README.md'))
    .map((p) => p.replace(/^\.changeset\//, '').replace(/\.md$/, ''));

  const entries = [];
  for (const id of ids) {
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
