#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

export function parseReleaseTag(rawTag) {
  const tag = String(rawTag ?? '').trim();
  if (!tag) throw new Error('missing release tag');

  const beta = BETA_TAG_RE.exec(tag);
  if (beta) return { channel: 'beta', version: tag.slice(1), name: tag };

  const stable = STABLE_TAG_RE.exec(tag);
  if (stable) return { channel: 'stable', version: tag.slice(1), name: tag };

  throw new Error(
    `unrecognized release tag '${tag}' (expected vX.Y.Z or vX.Y.Z-beta.N)`,
  );
}

function stableKey(rawTag) {
  const m = STABLE_TAG_RE.exec(String(rawTag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function previousStableTag({ tags, tag }) {
  const ceiling = stableKey(tag);
  if (!ceiling) {
    throw new Error(`previousStableTag needs a stable tag, got '${tag}'`);
  }
  let best = null;
  for (const candidate of tags ?? []) {
    const key = stableKey(candidate);
    if (!key) continue;
    if (compareKeys(key, ceiling) >= 0) continue;
    if (best === null || compareKeys(key, best.key) > 0) {
      best = { tag: String(candidate).trim(), key };
    }
  }
  return best ? best.tag : null;
}

export function deriveReleaseStamp({ tag, tags, describePreviousTag }) {
  const parsed = parseReleaseTag(tag);
  const baseRef =
    parsed.channel === 'beta'
      ? (describePreviousTag(parsed.name) ?? null)
      : previousStableTag({ tags, tag: parsed.name });
  return { ...parsed, baseRef: baseRef || null };
}

function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
    );
  }
  return String(res.stdout || '');
}

function realTags() {
  return runGit(['tag', '--list', 'v*'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const NO_PREVIOUS_TAG_SENTINELS = [/No names found/i, /unknown revision/i];

function realDescribePreviousTag(tag) {
  const res = spawnSync('git', ['describe', '--tags', '--abbrev=0', `${tag}^`], {
    encoding: 'utf8',
  });
  if (res.status === 0) return String(res.stdout || '').trim() || null;
  const stderr = String(res.stderr || '');
  if (NO_PREVIOUS_TAG_SENTINELS.some((re) => re.test(stderr))) return null;
  throw new Error(
    `git describe --tags --abbrev=0 ${tag}^ failed (exit ${res.status}): ${stderr.trim()}`,
  );
}

export function formatOutputLines(result) {
  return [
    `channel=${result.channel}`,
    `version=${result.version}`,
    `name=${result.name}`,
    `base_ref=${result.baseRef ?? ''}`,
  ];
}

function main() {
  let result;
  try {
    result = deriveReleaseStamp({
      tag: process.argv[2],
      tags: realTags(),
      describePreviousTag: realDescribePreviousTag,
    });
  } catch (err) {
    console.error(`::error::derive-release-stamp: ${err.message}`);
    process.exit(1);
  }

  log(
    `tag=${result.name} channel=${result.channel} version=${result.version} base_ref=${result.baseRef ?? '<none>'}`,
  );
  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${formatOutputLines(result).join('\n')}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
