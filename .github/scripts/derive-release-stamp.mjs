#!/usr/bin/env node
/**
 * Decide which Linear release a cut stamps its tickets onto, and how far back
 * to scan for them.
 *
 * Why the tag is used verbatim. The obvious identity for a beta cut is its
 * "eventual" stable version — strip `-beta.N` and key on what remains. That
 * number is a PREDICTION made at cut time (`anchor + max bump of the pending
 * pile`); the real stable version is computed later, at promote time, against a
 * delta that has moved since. Keying a release on it attributes tickets to
 * versions that never shipped them, and always in the same direction: too
 * early. A tag's own name has no such failure mode — `v0.46.0-beta.3` is
 * literally the ref that was cut, so it is used as-is.
 *
 * Why the scan range depends on the channel. The lower bound is an exclusive
 * `<base>..<tag>` boundary for the commit scan that finds ticket identifiers.
 *
 *   beta   -> the previous tag of any kind. The beta release then holds what is
 *             NEW in that beta, so a ticket lands on the beta it FIRST shipped
 *             in rather than on every subsequent one.
 *   stable -> the previous STABLE tag, skipping betas. A stable promotion
 *             batches every changeset since the last stable, so its scan has to
 *             reach back that far; stopping at the most recent beta would miss
 *             every ticket from earlier betas in the cycle.
 *
 * The two together give a ticket exactly two attachments — the beta it first
 * appeared in and the stable that shipped it — with no predicted version
 * anywhere in the chain.
 *
 * Usage:
 *   node .github/scripts/derive-release-stamp.mjs <tag>
 *
 * Must run inside a full clone (`fetch-depth: 0`, `fetch-tags: true`) — both
 * lower-bound strategies read the tag list and the history behind it.
 *
 * Emits JSON to stdout and, under Actions, appends
 *   channel / version / name / base_ref
 * to $GITHUB_OUTPUT. Logs go to stderr.
 *
 * Fail-loud contract, matching the sibling release scripts: "this is the first
 * stable ever, so there is no lower bound" is a real ANSWER and exits 0 with an
 * empty base_ref, which the sync action reads as "use your own default". A tag
 * that cannot be parsed exits non-zero rather than being coerced — stamping the
 * wrong release is worse than not stamping.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

/**
 * Classify a release tag and derive the identity its Linear release carries.
 *
 * `version` keeps the prerelease suffix for a beta. That is the whole point:
 * the suffix is what makes a beta's identity a fact rather than a forecast.
 *
 * Throws on anything that is not one of the two recognized shapes. A release
 * cadence that silently stamps an unrecognized ref would attribute tickets to a
 * release nobody can find.
 */
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

/** Numeric semver key for a stable tag, or null if it is not one. */
function stableKey(rawTag) {
  const m = STABLE_TAG_RE.exec(String(rawTag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Highest stable tag strictly below `tag`, or null when none exists.
 *
 * Comparison is numeric per component, never lexicographic — `v0.10.0` sorts
 * above `v0.9.0`, which a string sort gets backwards and which this repo's
 * version range has already crossed.
 *
 * Beta tags are skipped entirely rather than ordered among the stables: the
 * caller wants the previous PRODUCTION boundary, and a beta is not one.
 */
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

/**
 * Full stamp decision. Boundaries are injected:
 *   describePreviousTag(tag) -> string | null   (nearest tag of any kind below `tag`)
 *
 * `describePreviousTag` is only consulted on the beta path, so a stable
 * promotion needs no history walk at all — just the tag list.
 */
export function deriveReleaseStamp({ tag, tags, describePreviousTag }) {
  const parsed = parseReleaseTag(tag);
  const baseRef =
    parsed.channel === 'beta'
      ? (describePreviousTag(parsed.name) ?? null)
      : previousStableTag({ tags, tag: parsed.name });
  return { ...parsed, baseRef: baseRef || null };
}

// --- workflow-runtime wiring (real git boundary) ---

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

// The nearest tag reachable from the commit BEFORE this one, which is the
// exclusive lower bound the scan wants.
//
// `git describe` exits 128 for both "there is genuinely no tag back there" and
// for real infra failures, so the exit code alone cannot discriminate the way
// `merge-base --is-ancestor`'s exit 1 does for the sibling script. The two
// legitimate empty answers are matched on git's own sentinels instead:
// no tag in the ancestry, and a root commit that has no `^` parent. Anything
// else — an unreadable object, a killed process — throws, because silently
// reading it as "no lower bound" would widen the scan without saying so.
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

/**
 * The step-output contract the workflow consumes.
 *
 * An absent lower bound is emitted as an EMPTY `base_ref`, which the sync action
 * reads as "use your own default". Emitting a placeholder like `HEAD` instead
 * would narrow the first-ever scan to nothing, so this coalesce is load-bearing
 * and lives here, out of `main()`, to stay directly testable.
 */
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

// Run main() only as a CLI, not when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
