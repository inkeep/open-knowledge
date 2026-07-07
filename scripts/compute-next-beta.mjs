#!/usr/bin/env node
/**
 * Compute the next beta base version (X.Y.Z) and render delta release notes
 * by reusing Changesets' canonical rendering machinery.
 *
 * Reads:
 *   - .changeset/pre.json     — initialVersions (anchor) + cycle state
 *   - .changeset/*.md         — pending changesets (frontmatter bump types + body)
 *   - gh release view <prev-beta-tag>  — previous beta's release body, from which
 *                                        we recover the embedded consumed-set marker
 *
 * Algorithm:
 *   1. Enumerate current .changeset/*.md file IDs.
 *   2. Resolve the previous beta tag on the public release repo and
 *      parse its release body for the embedded `<!-- ok-consumed-set: [...] -->`
 *      marker. Missing tag / missing marker → bootstrap (treat everything as new).
 *   3. Compute the delta: IDs in current pile NOT in prior consumed set.
 *      Empty delta → skip dispatch.
 *   4. Transiently rewrite `pre.json#changesets` to the prior consumed set so
 *      `bun changeset version` consumes ONLY the delta when it runs.
 *   5. Run `bun changeset version` — produces per-package CHANGELOG.md prepends
 *      whose top section is the canonical Changesets rendering of the delta.
 *   6. Diff each package's CHANGELOG.md (before vs after) and harvest the new
 *      top section. Union across packages, dedupe by commit hash, drop the
 *      "Updated dependencies" boilerplate.
 *   7. Render: per-bump-type grouping + footer linking to the previous beta +
 *      embedded consumed-set marker for the next cut to read.
 *   8. Read the bumped package.json#version to derive baseVersion + maxBumpType.
 *
 * Emits JSON to stdout (legacy beta-cut workflow contract):
 *   { skip: false, baseVersion: "X.Y.Z", maxBumpType: "patch"|"minor",
 *     pendingCount: N, releaseNotes: "...markdown..." }
 * or, when no new changesets are pending:
 *   { skip: true, reason: "..." }
 *
 * The script MUTATES the working tree (pre.json + CHANGELOG.md + package.json
 * + deletes .changeset/*.md). The CALLER must `git restore .` after reading
 * stdout (the beta-cut workflow does this in an `if: always()` step).
 *
 * The -beta.N counter is intentionally NOT computed here. release.yml on
 * the public release repo resolves it within the ok-release-cadence
 * concurrency slot from existing vX.Y.Z-beta.* tags.
 *
 * Run from cwd public/open-knowledge:
 *   node scripts/compute-next-beta.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const FIXED_GROUP_ANCHOR = '@inkeep/open-knowledge';
const PRE_PATH = '.changeset/pre.json';
const CHANGESET_DIR = '.changeset';
// Repo this release runs against; derived from the workflow env so it follows
// whatever repo the release executes on. Fallback is for local runs only.
const PUBLIC_REPO = process.env.GITHUB_REPOSITORY || 'inkeep/open-knowledge';
const CHANGELOG_PKGS = ['cli', 'core', 'server', 'app', 'desktop'];
const CONSUMED_MARKER_RE = /<!--\s*ok-consumed-set:\s*(\[[^\]]*\])\s*-->/;
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

export function bumpSemver(version, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Invalid version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Invalid bump type: ${type}`);
}

// The cycle's effective bump is the highest declared across all its
// changesets, with a 'patch' floor — any release is at least a patch even
// when a changeset declares no recognizable bump for the fixed group.
export function maxBumpType(bumpTypes) {
  let max = 'patch';
  for (const t of bumpTypes) {
    if (t && BUMP_RANK[t] > BUMP_RANK[max]) max = t;
  }
  return max;
}

// Base version = last stable (anchor) bumped by the cycle's max bump-type.
// Changing this breaks the normative vectors pinned in
// compute-next-beta.test.mjs.
export function computeBaseVersion(anchor, bumpTypes) {
  return bumpSemver(anchor, maxBumpType(bumpTypes));
}

export function parseFrontmatterBumpType(content) {
  // Returns the max bump type ('patch'|'minor'|'major'|null) declared in a
  // changeset's frontmatter, e.g.:
  //   ---
  //   '@inkeep/open-knowledge': minor
  //   '@inkeep/open-knowledge-app': patch
  //   ---
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!fmMatch) return null;
  let maxType = null;
  for (const m of fmMatch[1].matchAll(/:\s*(patch|minor|major)\s*$/gm)) {
    if (!maxType || BUMP_RANK[m[1]] > BUMP_RANK[maxType]) maxType = m[1];
  }
  return maxType;
}

function findPrevBetaTag() {
  const res = spawnSync(
    'gh',
    [
      'release',
      'list',
      '--repo',
      PUBLIC_REPO,
      '--limit',
      '50',
      '--json',
      'tagName,isPrerelease',
      '--jq',
      '[.[] | select(.isPrerelease) | select(.tagName | test("^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+-beta\\\\.[0-9]+$")) | .tagName] | first // ""',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    log(`[warn] gh release list failed (exit ${res.status}); treating as bootstrap.`);
    log(res.stderr);
    return null;
  }
  const tag = res.stdout.trim().replace(/^"|"$/g, '');
  return tag || null;
}

function recoverConsumedSet(tag) {
  const res = spawnSync(
    'gh',
    ['release', 'view', tag, '--repo', PUBLIC_REPO, '--json', 'body', '--jq', '.body'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    log(`[warn] gh release view ${tag} failed (exit ${res.status}); treating as bootstrap.`);
    return null;
  }
  const m = CONSUMED_MARKER_RE.exec(res.stdout);
  if (!m) {
    log(`[warn] ${tag} body has no ok-consumed-set marker; treating as bootstrap.`);
    return null;
  }
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      log(`[warn] ${tag} consumed-set marker is not a string array; treating as bootstrap.`);
      return null;
    }
    return parsed;
  } catch (e) {
    log(`[warn] ${tag} consumed-set marker is not valid JSON: ${e.message}`);
    return null;
  }
}

function readChangelogs() {
  const out = {};
  for (const pkg of CHANGELOG_PKGS) {
    const p = `packages/${pkg}/CHANGELOG.md`;
    out[pkg] = existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  return out;
}

export function extractDeltaSection(content) {
  // CHANGELOG.md shape after `bun changeset version`:
  //   # @inkeep/foo
  //
  //   ## NEW-VERSION
  //   <-- new content (what we want) -->
  //
  //   ## PRIOR-VERSION
  //   <-- old content -->
  //
  // Return everything between the first `## ` heading and the second `## `
  // heading, EXCLUDING the new-version heading line itself (release.yml owns
  // the displayed version on the GitHub Release).
  const lines = content.split('\n');
  let firstH2 = -1;
  let secondH2 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      if (firstH2 === -1) firstH2 = i;
      else {
        secondH2 = i;
        break;
      }
    }
  }
  if (firstH2 === -1) return null;
  const end = secondH2 === -1 ? lines.length : secondH2;
  return lines.slice(firstH2 + 1, end).join('\n');
}

export function parseSection(section) {
  // Parse a CHANGELOG-section body into { 'Patch Changes': [{hash, body}, ...], ... }.
  // Entries are bullets opened by `- ` at column 0; continuation lines start
  // with two spaces of indentation. The Changesets renderer prefixes each
  // direct entry with the short commit hash (`- 67028e1: foo...`).
  const groups = {};
  let currentGroup = null;
  let currentEntry = null;

  function commit() {
    if (!currentEntry) return;
    currentEntry.body = currentEntry.body.replace(/\n+$/, '');
    currentEntry = null;
  }

  for (const line of section.split('\n')) {
    if (line.startsWith('### ')) {
      commit();
      currentGroup = line.slice(4).trim();
      groups[currentGroup] ??= [];
    } else if (line.startsWith('- ') && currentGroup) {
      commit();
      const m = /^- (?:([a-f0-9]{6,}): )?([\s\S]*)$/.exec(line);
      currentEntry = { hash: m?.[1] ?? null, body: m?.[2] ?? line.slice(2) };
      groups[currentGroup].push(currentEntry);
    } else if (currentEntry && (line.startsWith('  ') || line === '')) {
      currentEntry.body += `\n${line.startsWith('  ') ? line.slice(2) : ''}`;
    } else {
      commit();
    }
  }
  commit();
  return groups;
}

export function renderNotes({ packageDeltas, newConsumedSet, prevBetaTag, newCount }) {
  const unioned = {};
  const seenHashes = new Set();
  for (const pkg of CHANGELOG_PKGS) {
    const section = packageDeltas[pkg];
    if (!section) continue;
    const groups = parseSection(section);
    for (const [group, entries] of Object.entries(groups)) {
      unioned[group] ??= [];
      for (const entry of entries) {
        const trimmed = entry.body.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('Updated dependencies')) continue;
        // Fixed-group sibling-bump bullets (`- @inkeep/<pkg>@<version>`) carry
        // the changesets pre-mode-bump version (e.g., `-beta.6`), which is
        // unrelated to the workflow-resolved `-beta.N` tag the release will
        // ship as. They're boilerplate cross-references, not user-facing
        // narrative — drop them.
        if (/^@inkeep\/[\w-]+@\d/.test(trimmed)) continue;
        if (entry.hash) {
          if (seenHashes.has(entry.hash)) continue;
          seenHashes.add(entry.hash);
        }
        unioned[group].push(entry);
      }
    }
  }

  const lines = [];
  if (prevBetaTag) {
    lines.push(
      `Delta since previous beta ([${prevBetaTag}](https://github.com/${PUBLIC_REPO}/releases/tag/${prevBetaTag})) — ${newCount} new changeset${newCount === 1 ? '' : 's'}.`,
    );
  } else {
    lines.push(
      `First beta of the cycle — ${newCount} changeset${newCount === 1 ? '' : 's'}.`,
    );
  }
  lines.push('');

  for (const group of ['Major Changes', 'Minor Changes', 'Patch Changes']) {
    if (!unioned[group]?.length) continue;
    lines.push(`### ${group}`);
    lines.push('');
    for (const entry of unioned[group]) {
      const body = entry.body.trim();
      const indented = body
        .split('\n')
        .map((l, i) => (i === 0 ? l : l === '' ? '' : `  ${l}`))
        .join('\n');
      lines.push(`- ${indented}`);
      lines.push('');
    }
  }

  lines.push(`<!-- ok-consumed-set: ${JSON.stringify(newConsumedSet)} -->`);
  return lines.join('\n');
}

function main() {
  const pre = JSON.parse(readFileSync(PRE_PATH, 'utf8'));
  if (pre.mode !== 'pre') {
    throw new Error(`Expected pre.json mode=pre, got mode=${pre.mode}`);
  }
  const anchor = pre.initialVersions?.[FIXED_GROUP_ANCHOR];
  if (!anchor) {
    throw new Error(`No initialVersion for ${FIXED_GROUP_ANCHOR} in pre.json`);
  }

  const changesetFiles = readdirSync(CHANGESET_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
  if (changesetFiles.length === 0) {
    console.log(JSON.stringify({ skip: true, reason: 'no pending changesets' }));
    return;
  }
  const allIds = changesetFiles.map((f) => f.replace(/\.md$/, ''));
  const allIdsSet = new Set(allIds);

  const prevBetaTag = findPrevBetaTag();
  let priorConsumed = [];
  if (prevBetaTag) {
    const recovered = recoverConsumedSet(prevBetaTag);
    // Filter out IDs that have since vanished from the pile (e.g., a stable
    // promotion cleared them and the cycle restarted). Without this guard
    // Changesets would error on "unknown changeset" in the persisted list.
    if (recovered) priorConsumed = recovered.filter((id) => allIdsSet.has(id));
  }
  const priorSet = new Set(priorConsumed);
  const newIds = allIds.filter((id) => !priorSet.has(id));

  if (newIds.length === 0) {
    console.log(
      JSON.stringify({
        skip: true,
        reason: `no new changesets since ${prevBetaTag ?? 'bootstrap'}`,
      }),
    );
    return;
  }

  // Compute maxBumpType across the WHOLE cycle (delta + prior). baseVersion
  // ships to legacy and must reflect the cycle's eventual stable target — a
  // delta-only patch on a cycle that already accumulated a minor would
  // otherwise emit the wrong base.
  const cycleBumpTypes = allIds.map((id) =>
    parseFrontmatterBumpType(readFileSync(`${CHANGESET_DIR}/${id}.md`, 'utf8')),
  );
  const cycleMaxBump = maxBumpType(cycleBumpTypes);
  const baseVersion = bumpSemver(anchor, cycleMaxBump);

  const changelogsBefore = readChangelogs();

  // Transient pre.json mutation: tell Changesets "these IDs are already
  // consumed in this pre-cycle." It then consumes only the delta when
  // `bun changeset version` runs below. The mutation lives only on disk for
  // this run — the workflow's `git restore .` cleanup discards it.
  writeFileSync(
    PRE_PATH,
    `${JSON.stringify({ ...pre, changesets: priorConsumed }, null, 2)}\n`,
  );

  const versionRes = spawnSync('bun', ['changeset', 'version'], {
    stdio: ['ignore', 2, 2],
  });
  if (versionRes.status !== 0) {
    throw new Error(`bun changeset version exited ${versionRes.status}`);
  }

  const changelogsAfter = readChangelogs();
  const packageDeltas = {};
  for (const pkg of CHANGELOG_PKGS) {
    if (changelogsBefore[pkg] === changelogsAfter[pkg]) continue;
    const delta = extractDeltaSection(changelogsAfter[pkg]);
    if (delta && delta.trim()) packageDeltas[pkg] = delta;
  }

  const newConsumedSet = [...priorConsumed, ...newIds].sort();
  const releaseNotes = renderNotes({
    packageDeltas,
    newConsumedSet,
    prevBetaTag,
    newCount: newIds.length,
  });

  console.log(
    JSON.stringify({
      skip: false,
      baseVersion,
      maxBumpType: cycleMaxBump,
      pendingCount: newIds.length,
      releaseNotes,
    }),
  );
}

// Allow `import { extractDeltaSection } from '...'` from tests without
// triggering the main flow.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
