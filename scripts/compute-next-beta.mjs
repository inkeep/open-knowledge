#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

export const FIXED_GROUP_ANCHOR = '@inkeep/open-knowledge';
const PRE_PATH = '.changeset/pre.json';
const CHANGESET_DIR = '.changeset';
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

export function maxBumpType(bumpTypes) {
  let max = 'patch';
  for (const t of bumpTypes) {
    if (t && BUMP_RANK[t] > BUMP_RANK[max]) max = t;
  }
  return max;
}

export function computeBaseVersion(anchor, bumpTypes) {
  return bumpSemver(anchor, maxBumpType(bumpTypes));
}

export function parseFrontmatterBumpType(content) {
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
    } else if (currentEntry) {
      currentEntry.body += `\n${line.startsWith('  ') ? line.slice(2) : line}`;
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

  const cycleBumpTypes = allIds.map((id) =>
    parseFrontmatterBumpType(readFileSync(`${CHANGESET_DIR}/${id}.md`, 'utf8')),
  );
  const cycleMaxBump = maxBumpType(cycleBumpTypes);
  const baseVersion = bumpSemver(anchor, cycleMaxBump);

  const changelogsBefore = readChangelogs();

  writeFileSync(
    PRE_PATH,
    `${JSON.stringify({ ...pre, changesets: priorConsumed }, null, 2)}\n`,
  );

  const versionRes = spawnSync('pnpm', ['exec', 'changeset', 'version'], {
    stdio: ['ignore', 2, 2],
  });
  if (versionRes.status !== 0) {
    throw new Error(`pnpm exec changeset version exited ${versionRes.status}`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
