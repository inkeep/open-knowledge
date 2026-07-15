#!/usr/bin/env node
/**
 * Determine the STABLE version a beta promotes to, as a single semantic-version
 * bump over the current latest stable — NOT by stripping `-beta.N` from the tag.
 *
 * Why. The old promote path derived the stable version from the tag NAME
 * (`v0.30.1-beta.6` -> `v0.30.1`). That collapses every beta in a cycle to one
 * stable, so only the first beta could ever ship; later betas' work was stranded
 * or swept into the next computed version, and a manual re-promote of a newer
 * beta collided with the already-existing `vX.Y.Z` tag. Instead, the stable
 * version is `bump(latestStableVersion, maxBumpType(<changeset delta>))`, where
 * the delta is the changesets present at the beta's commit but not yet consumed
 * by the latest stable. A patch-only delta bumps the patch (`0.30.1 -> 0.30.2`);
 * a minor changeset in the delta bumps the minor (`-> 0.31.0`). This is the
 * single source of version truth for BOTH manual and auto promotions.
 *
 * The latest stable tag points at the beta SHA it was cut from, so the set of
 * `.changeset/*.md` at that SHA is exactly what that stable shipped; the delta
 * is a plain set difference against the promoted beta's SHA.
 *
 * Usage: node scripts/compute-stable-version.mjs <vX.Y.Z-beta.N>
 * Emits JSON to stdout and, under Actions, appends
 *   skip / stable_version / stable_tag / beta_sha / latest_stable_sha
 * to $GITHUB_OUTPUT. Logs go to stderr. Fail-loud: any git failure other than a
 * clean `merge-base --is-ancestor` false exits non-zero (retry next tick) rather
 * than folding an infra error into a promote/no-op decision.
 *
 * The pure core (`computeStablePromotion`) takes its git boundary as an injected
 * dependency so tests need no live repo (mirrors promote-stable-auto.mjs).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bumpSemver, maxBumpType, parseFrontmatterBumpType } from './compute-next-beta.mjs';

const BETA_TAG_RE = /^v\d+\.\d+\.\d+-beta\.\d+$/;
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/;

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

function stripBetaToVersion(betaTag) {
  const m = /^v(\d+\.\d+\.\d+)-beta\.\d+$/.exec(betaTag);
  if (!m) throw new Error(`not a vX.Y.Z-beta.N tag: ${betaTag}`);
  return m[1];
}

/**
 * Pure decision core. `git` is an injected boundary so tests need no repo:
 *   revParse(ref)        -> commit SHA (string)
 *   newestStableTag()    -> "vX.Y.Z" | ""   (highest plain vX.Y.Z tag)
 *   changesetIds(sha)    -> string[]         (basename-without-.md of .changeset/*.md at sha)
 *   isAncestor(a, b)     -> boolean          (a is ancestor-or-equal of b)
 *   bumpTypeOf(sha, id)  -> 'patch'|'minor'|'major'|null
 *
 * Returns one of:
 *   { skip:false, stableVersion, stableTag, bump, deltaCount, betaSha, latestStableSha }
 *   { skip:false, bootstrap:true, stableVersion, stableTag, betaSha, latestStableSha:"" }
 *   { skip:true, reason, betaSha, latestStableSha }
 */
export function computeStablePromotion(betaTag, git) {
  if (!BETA_TAG_RE.test(betaTag)) {
    throw new Error(`Beta tag '${betaTag}' is not in the expected vX.Y.Z-beta.N format.`);
  }
  const betaSha = git.revParse(betaTag);

  const latestStableTag = git.newestStableTag();
  if (!latestStableTag) {
    // Bootstrap: no prior stable — the first stable is the beta's own X.Y.Z
    // (the cycle target compute-next-beta already resolved from the anchor).
    const stableVersion = stripBetaToVersion(betaTag);
    return {
      skip: false,
      bootstrap: true,
      stableVersion,
      stableTag: `v${stableVersion}`,
      bump: null,
      deltaCount: null,
      betaSha,
      latestStableSha: '',
    };
  }
  if (!STABLE_TAG_RE.test(latestStableTag)) {
    throw new Error(`newestStableTag returned a non-stable tag: ${latestStableTag}`);
  }
  const latestStableVersion = latestStableTag.slice(1);
  const latestStableSha = git.revParse(latestStableTag);

  // Already shipped: the beta's commit is the latest stable's commit or an
  // ancestor of it. Nothing newer to promote — clean no-op (this replaces the
  // old "does vX.Y.Z tag exist" boundary, which no longer maps 1:1 to a beta).
  if (git.isAncestor(betaSha, latestStableSha)) {
    return {
      skip: true,
      reason: `${betaTag} (${betaSha.slice(0, 12)}) is already shipped in stable ${latestStableTag}.`,
      betaSha,
      latestStableSha,
    };
  }

  const stableIds = new Set(git.changesetIds(latestStableSha));
  const deltaIds = git.changesetIds(betaSha).filter((id) => !stableIds.has(id));
  if (deltaIds.length === 0) {
    return {
      skip: true,
      reason: `${betaTag} introduces no changesets beyond ${latestStableTag}; nothing to promote.`,
      betaSha,
      latestStableSha,
    };
  }

  const bump = maxBumpType(deltaIds.map((id) => git.bumpTypeOf(betaSha, id)));
  const stableVersion = bumpSemver(latestStableVersion, bump);
  return {
    skip: false,
    stableVersion,
    stableTag: `v${stableVersion}`,
    bump,
    // The exact changeset IDs this stable consumes. main-reset (on
    // agents-private, which has no OK release tags) can't recompute the delta
    // itself, so promote-stable forwards this list in the main-reset dispatch so
    // that reset consolidates ONLY these changesets and leaves later ones pending.
    deltaIds,
    deltaCount: deltaIds.length,
    betaSha,
    latestStableSha,
  };
}

// --- workflow-runtime wiring (real git boundary) ---

function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '');
}

const realGit = {
  revParse: (ref) => runGit(['rev-parse', '--verify', `${ref}^{commit}`]).trim(),
  newestStableTag: () => {
    for (const line of runGit(['tag', '--list', 'v*', '--sort=-version:refname']).split('\n')) {
      const t = line.trim();
      if (STABLE_TAG_RE.test(t)) return t;
    }
    return '';
  },
  changesetIds: (sha) => {
    const ids = [];
    for (const line of runGit(['ls-tree', '-r', '--name-only', sha, '--', '.changeset']).split('\n')) {
      const m = /^\.changeset\/(.+)\.md$/.exec(line.trim());
      if (m && m[1] !== 'README') ids.push(m[1]);
    }
    return ids;
  },
  isAncestor: (a, b) => {
    // Distinguish a clean "not an ancestor" (exit 1) from an infra failure
    // (any other non-zero) — the latter must fail loud, not read as "false".
    const res = spawnSync('git', ['merge-base', '--is-ancestor', a, b], { encoding: 'utf8' });
    if (res.status === 0) return true;
    if (res.status === 1) return false;
    throw new Error(
      `git merge-base --is-ancestor ${a} ${b} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
    );
  },
  bumpTypeOf: (sha, id) => parseFrontmatterBumpType(runGit(['show', `${sha}:.changeset/${id}.md`])),
};

function main() {
  const betaTag = process.argv[2];
  if (!betaTag) {
    log('::error::compute-stable-version: missing beta tag argument (usage: compute-stable-version.mjs <vX.Y.Z-beta.N>).');
    process.exit(1);
  }

  let result;
  try {
    result = computeStablePromotion(betaTag, realGit);
  } catch (err) {
    // Fail loud: an infra/format error means we cannot trust the decision.
    console.error(`::error::compute-stable-version: ${err.message}`);
    process.exit(1);
  }

  if (result.skip) {
    log(`No-op: ${result.reason}`);
  } else if (result.bootstrap) {
    log(`Promote ${betaTag} -> ${result.stableTag} (bootstrap: first stable, no prior stable tag).`);
  } else {
    log(
      `Promote ${betaTag} -> ${result.stableTag} (${result.bump} bump over v${result.latestStableSha.slice(0, 12)}; ${result.deltaCount} changeset delta).`,
    );
  }

  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `skip=${result.skip ? 'true' : 'false'}`,
      `stable_version=${result.stableVersion ?? ''}`,
      `stable_tag=${result.stableTag ?? ''}`,
      `beta_sha=${result.betaSha ?? ''}`,
      `latest_stable_sha=${result.latestStableSha ?? ''}`,
      // JSON array of changeset IDs consumed by this stable (empty for skip /
      // bootstrap). promote-stable forwards it to main-reset for incremental
      // consolidation.
      `delta_ids=${JSON.stringify(result.deltaIds ?? [])}`,
    ];
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

// Run main() only as a CLI, not when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
