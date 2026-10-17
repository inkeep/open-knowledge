/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint outside Turbo. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, highestVersion } from './write-back-gate.mjs';

export const STUCK_DRAFT_MAX_AGE_SECONDS = 10800;

const PIPELINE_TAG_RE = /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const BETA_SUFFIX = /-beta\.\d+$/;

export function isPipelineTag(tagName) {
  return PIPELINE_TAG_RE.test(String(tagName ?? '').trim());
}

export function cycleOf(tagName) {
  return String(tagName).replace(/^v/, '').replace(BETA_SUFFIX, '');
}

export function highestPublishedStable(releases) {
  const cycles = [];
  for (const release of releases ?? []) {
    if (release.isDraft || release.isPrerelease) continue;
    if (!isPipelineTag(release.tagName)) continue;
    if (BETA_SUFFIX.test(release.tagName)) continue;
    cycles.push(cycleOf(release.tagName));
  }
  return highestVersion(cycles);
}

export function highestPublishedBeta(releases) {
  const versions = [];
  for (const release of releases ?? []) {
    if (release.isDraft || !release.isPrerelease) continue;
    if (!isPipelineTag(release.tagName)) continue;
    if (!BETA_SUFFIX.test(release.tagName)) continue;
    versions.push(String(release.tagName).trim().replace(/^v/, ''));
  }
  return highestVersion(versions);
}

export function objectAgeSeconds(release, nowMs) {
  const stamp = release.updatedAt ?? release.publishedAt;
  if (!stamp) return null;
  const ageSeconds = (nowMs - Date.parse(stamp)) / 1000;
  return Number.isFinite(ageSeconds) ? ageSeconds : null;
}

export function selectStuckDrafts({ releases, nowMs, maxAgeSeconds }) {
  const maxStable = highestPublishedStable(releases);
  if (maxStable === null) {
    return { maxStable: null, maxBeta: null, sweep: [], keep: [] };
  }
  const maxBeta = highestPublishedBeta(releases);
  const sweep = [];
  const keep = [];
  for (const release of releases ?? []) {
    if (!release.isDraft) continue;
    if (!isPipelineTag(release.tagName)) {
      keep.push({ tagName: release.tagName, cycle: null, reason: 'unrecognized tag shape' });
      continue;
    }
    const cycle = cycleOf(release.tagName);
    const ageSeconds = objectAgeSeconds(release, nowMs);
    if (ageSeconds === null) {
      keep.push({ tagName: release.tagName, cycle, reason: 'no usable timestamp' });
      continue;
    }
    if (!(ageSeconds > maxAgeSeconds)) {
      keep.push({ tagName: release.tagName, cycle, reason: 'younger than the age gate' });
      continue;
    }
    const entry = { tagName: release.tagName, cycle };
    if (BETA_SUFFIX.test(release.tagName)) {
      const version = String(release.tagName).trim().replace(/^v/, '');
      if (maxBeta !== null && compareVersions(version, maxBeta) < 0) {
        sweep.push({ ...entry, supersededBy: `v${maxBeta}` });
      } else {
        keep.push({ ...entry, reason: 'no newer beta has been published' });
      }
      continue;
    }
    if (compareVersions(cycle, maxStable) <= 0) sweep.push({ ...entry, supersededBy: `v${maxStable}` });
    else keep.push({ ...entry, reason: 'cycle not yet covered by a published stable' });
  }
  return { maxStable, maxBeta, sweep, keep };
}

function main() {
  const input = readFileSync(0, 'utf8').trim();
  if (input === '') {
    console.error(
      '::error::select-stuck-drafts: no release listing arrived on stdin. Pipe the JSON array of releases into this script; an empty listing is `[]`.',
    );
    process.exitCode = 1;
    return;
  }
  const releases = JSON.parse(input);
  const maxAgeSeconds = Number(process.env.MAX_AGE_SECONDS ?? STUCK_DRAFT_MAX_AGE_SECONDS);
  const result = selectStuckDrafts({ releases, nowMs: Date.now(), maxAgeSeconds });
  if (result.maxStable === null) {
    console.error(
      'No published stable release yet; keeping all drafts (their bodies feed the first stable changelog).',
    );
    return;
  }
  console.error(
    `Highest published stable version: ${result.maxStable}; highest published beta: ${result.maxBeta ?? 'none'}.`,
  );
  for (const { tagName, reason } of result.keep) {
    console.error(`Keeping ${tagName}: ${reason}.`);
  }
  for (const { tagName, supersededBy } of result.sweep) {
    console.error(`Selected ${tagName} for sweeping: published ${supersededBy} supersedes it.`);
  }
  console.log(result.sweep.map((entry) => entry.tagName).join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
