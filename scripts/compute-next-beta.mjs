#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createShippedFixCheck,
  parseReleaseListing,
} from '../.github/scripts/shipped-fix-containment.mjs';
import {
  bumpSemver,
  fixedGroupOf,
  loadChangesets,
  maxBumpType,
  maxReleaseType,
} from './changeset-versions.mjs';
import { gitAt, releasedChangesetIds } from './compute-stable-version.mjs';

const PRE_PATH = '.changeset/pre.json';
const CONFIG_PATH = '.changeset/config.json';
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const PUBLIC_REPO = process.env.GITHUB_REPOSITORY || 'inkeep/open-knowledge';
const CHANGELOG_PKGS = ['cli', 'core', 'server', 'app', 'desktop'];
const CONSUMED_MARKER_RE = /<!--\s*ok-consumed-set:\s*(\[[^\]]*\])\s*-->/;

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

export const RELEASE_LIST_ARGS = [
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
];

export const STABLE_RELEASES_ARGS = [
  'api',
  '-X',
  'GET',
  `repos/${PUBLIC_REPO}/releases?per_page=100`,
  '--paginate',
  '--jq',
  '.[] | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) | {tag_name, draft}',
];

export function releaseViewArgs(tag) {
  return ['release', 'view', tag, '--repo', PUBLIC_REPO, '--json', 'body', '--jq', '.body'];
}

export function recordedReleases(env) {
  const sameArgs = (args, expected) =>
    args.length === expected.length && args.every((arg, i) => arg === expected[i]);
  const status = (name) => {
    const value = env[name];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new Error(
        `${name} is ${value === undefined ? 'missing' : JSON.stringify(value)}, not an exit status: the read-releases job's outputs did not reach this step`,
      );
    }
    return Number(value);
  };
  return (args) => {
    if (sameArgs(args, RELEASE_LIST_ARGS)) {
      return {
        status: status('RELEASE_LIST_STATUS'),
        stdout: env.RELEASE_LIST_STDOUT,
        stderr: env.RELEASE_LIST_STDERR,
      };
    }
    if (env.RELEASE_VIEW_TAG && sameArgs(args, releaseViewArgs(env.RELEASE_VIEW_TAG))) {
      return { status: status('RELEASE_VIEW_STATUS'), stdout: env.RELEASE_VIEW_STDOUT, stderr: '' };
    }
    if (sameArgs(args, STABLE_RELEASES_ARGS)) {
      return {
        status: status('STABLE_RELEASES_STATUS'),
        stdout: env.STABLE_RELEASES_STDOUT,
        stderr: env.STABLE_RELEASES_STDERR,
      };
    }
    throw new Error(`the read-releases job recorded no result for gh ${args.join(' ')}`);
  };
}

function findPrevBetaTag(gh) {
  const res = gh(RELEASE_LIST_ARGS);
  if (res.status !== 0) {
    log(`[warn] gh release list failed (exit ${res.status}); treating as bootstrap.`);
    log(res.stderr);
    return null;
  }
  const tag = res.stdout.trim().replace(/^"|"$/g, '');
  return tag || null;
}

function recoverConsumedSet(tag, gh) {
  const res = gh(releaseViewArgs(tag));
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

export function previousBeta(gh) {
  const prevBetaTag = findPrevBetaTag(gh);
  return { prevBetaTag, recovered: prevBetaTag ? recoverConsumedSet(prevBetaTag, gh) : null };
}

export function publishedStableTags(gh, readListing) {
  const unusable = (reason) => {
    console.error(
      `::warning::compute-next-beta: ${reason}. Counting every stable tag as released, so while the newest stable ` +
        "is still a draft this beta's notes and consumed set leave out that stable's changesets.",
    );
    return null;
  };
  const res = gh(STABLE_RELEASES_ARGS);
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    return unusable(
      `listing the stable Releases failed (exit ${res.status}${stderr ? `: ${stderr}` : ''})`,
    );
  }
  try {
    return readListing(res.stdout);
  } catch (err) {
    return unusable(
      `the stable Release listing is unusable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export function betaBase({ changesets, newestStableTag, releasedIds, anchorIds }) {
  if (!STABLE_TAG_RE.test(String(newestStableTag ?? ''))) {
    throw new Error(
      `'${newestStableTag}' is not a vX.Y.Z stable tag; a beta is numbered from the newest stable tag, ` +
        'so the checkout needs every tag.',
    );
  }
  const pending = changesets.filter(({ id }) => !releasedIds.has(id));
  const beyondAnchor = pending.filter(({ id }) => !anchorIds.has(id));
  const bump = maxBumpType(beyondAnchor.map(({ releases }) => maxReleaseType(releases)));
  return {
    pending,
    beyondAnchorCount: beyondAnchor.length,
    maxBumpType: bump,
    baseVersion: bumpSemver(newestStableTag.slice(1), bump),
  };
}

export function transientPreState({ fixedGroup, anchorVersion, consumed }) {
  return {
    mode: 'pre',
    tag: 'beta',
    initialVersions: Object.fromEntries(fixedGroup.map((name) => [name, anchorVersion])),
    changesets: consumed,
  };
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
      if (/^ {2}- @inkeep\/[\w-]+@\d\S*$/.test(line)) continue;
      currentEntry.body += `\n${line.startsWith('  ') ? line.slice(2) : line}`;
    } else {
      commit();
    }
  }
  commit();
  return groups;
}

const INERTIA_REPO = 'inkeep/agents-private';
const RUN_ID_RE = /^[1-9][0-9]{0,18}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export function provingRun({ run, sha } = {}) {
  const runText = String(run ?? '');
  const shaText = String(sha ?? '');
  if (runText === '' && shaText === '') return { line: null, problem: null };
  if (!RUN_ID_RE.test(runText)) {
    return { line: null, problem: `the proving run ${JSON.stringify(runText)} is not a run id` };
  }
  if (!COMMIT_SHA_RE.test(shaText)) {
    return {
      line: null,
      problem: `the proving commit ${JSON.stringify(shaText)} is not a full commit SHA`,
    };
  }
  return {
    line: `Proved by internal Inertia run [${runText}](https://github.com/${INERTIA_REPO}/actions/runs/${runText}) at agents-private commit \`${shaText}\`.`,
    problem: null,
  };
}

export function renderNotes({
  packageDeltas,
  newConsumedSet,
  prevBetaTag,
  newCount,
  provenance = null,
}) {
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
    lines.push(`First beta of the cycle — ${newCount} changeset${newCount === 1 ? '' : 's'}.`);
  }
  lines.push('');
  if (provenance) lines.push(provenance, '');

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

async function main() {
  const git = gitAt();
  const newestStableTag = git.newestStableTag();
  const gh = recordedReleases(process.env);

  const changesets = await loadChangesets().read(process.cwd());
  const stableTags = new Set(git.stableTags());
  const publishedTags = publishedStableTags(gh, (stdout) =>
    createShippedFixCheck({
      listReleases: () => parseReleaseListing(stdout),
      git: { stableTags: () => stableTags },
    }).publishedStableTags(),
  );
  const {
    pending,
    beyondAnchorCount,
    maxBumpType: cycleMaxBump,
    baseVersion,
  } = betaBase({
    changesets,
    newestStableTag,
    releasedIds: releasedChangesetIds(git, { releasedTags: publishedTags }),
    anchorIds: new Set(newestStableTag ? git.changesetIds(newestStableTag) : []),
  });
  log(
    `Beta base ${baseVersion}: ${cycleMaxBump} over the newest stable tag ${newestStableTag}, from ` +
      `${beyondAnchorCount} of ${pending.length} pending changesets (the rest are already in its tree). Released means ` +
      `in the tree of ${publishedTags === null ? 'any stable tag' : `one of ${publishedTags.length} published stable tags`}.`,
  );
  if (pending.length === 0) {
    console.log(JSON.stringify({ skip: true, reason: 'no pending changesets' }));
    return;
  }
  const pendingIds = pending.map(({ id }) => id);
  const pendingSet = new Set(pendingIds);

  const { prevBetaTag, recovered } = previousBeta(gh);
  const priorConsumed = recovered ? recovered.filter((id) => pendingSet.has(id)) : [];
  const priorSet = new Set(priorConsumed);
  const newIds = pendingIds.filter((id) => !priorSet.has(id));

  if (newIds.length === 0) {
    console.log(
      JSON.stringify({
        skip: true,
        reason: `no new changesets since ${prevBetaTag ?? 'bootstrap'}`,
      }),
    );
    return;
  }

  const changelogsBefore = readChangelogs();

  for (const { id } of changesets) {
    if (!pendingSet.has(id)) rmSync(`.changeset/${id}.md`);
  }
  writeFileSync(
    PRE_PATH,
    `${JSON.stringify(
      transientPreState({
        fixedGroup: fixedGroupOf(JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))),
        anchorVersion: newestStableTag.slice(1),
        consumed: priorConsumed,
      }),
      null,
      2,
    )}\n`,
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
  const proof = provingRun({ run: process.env.OK_PROVED_BY_RUN, sha: process.env.OK_PROVED_AT });
  if (proof.problem)
    console.error(
      `::warning::compute-next-beta: ${proof.problem}, so the notes name no proving run`,
    );
  const releaseNotes = renderNotes({
    packageDeltas,
    newConsumedSet,
    prevBetaTag,
    newCount: newIds.length,
    provenance: proof.line,
  });

  console.log(
    JSON.stringify({
      skip: false,
      baseVersion,
      maxBumpType: cycleMaxBump,
      newestStableTag,
      pendingCount: newIds.length,
      releaseNotes,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    console.error(
      `::error::compute-next-beta: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
