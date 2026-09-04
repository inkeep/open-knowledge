#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from './git-clean-env.mjs';
import { FIXED_GROUP_ANCHOR, bumpSemver, maxBumpType, parseFrontmatterBumpType } from './compute-next-beta.mjs';

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

export function computeStablePromotion(betaTag, git) {
  if (!BETA_TAG_RE.test(betaTag)) {
    throw new Error(`Beta tag '${betaTag}' is not in the expected vX.Y.Z-beta.N format.`);
  }
  const betaSha = git.revParse(betaTag);

  const latestStableTag = git.newestStableTag();
  if (!latestStableTag) {
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
    deltaIds,
    deltaCount: deltaIds.length,
    betaSha,
    latestStableSha,
  };
}

export function computePointReleaseVersion({ syntheticSha, latestStableTag, latestStableSha, mode }, git) {
  if (mode !== 'cherry-pick' && mode !== 'revert') {
    throw new Error(`Point-release mode '${mode}' is not one of: cherry-pick, revert.`);
  }
  const sha = String(syntheticSha ?? '').trim();
  if (sha === '') throw new Error('Point-release requires a synthetic commit sha.');
  const stableSha = String(latestStableSha ?? '').trim();
  if (stableSha === '') throw new Error('Point-release requires the latest stable commit sha.');
  const stableTag = String(latestStableTag ?? '').trim();
  if (!STABLE_TAG_RE.test(stableTag)) {
    throw new Error(`latest stable tag '${latestStableTag}' is not in the expected vX.Y.Z format.`);
  }

  const latestStableVersion = stableTag.slice(1);
  const stableIdList = git.changesetIds(stableSha);
  const syntheticIdList = git.changesetIds(sha);
  const stableIds = new Set(stableIdList);
  const syntheticIds = new Set(syntheticIdList);
  const addedIds = syntheticIdList.filter((id) => !stableIds.has(id));
  const removedIds = stableIdList.filter((id) => !syntheticIds.has(id));

  const bump = mode === 'revert' ? 'patch' : maxBumpType(addedIds.map((id) => git.bumpTypeOf(sha, id)));
  const version = bumpSemver(latestStableVersion, bump);
  return { version, tag: `v${version}`, latestStableVersion, addedIds, removedIds, bump };
}

export function evaluateAnchorGuard({ anchorVersion, latestStableTag }) {
  const anchor = String(anchorVersion ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(anchor)) {
    throw new Error(`anchor version '${anchorVersion}' is not a bare X.Y.Z version.`);
  }
  const tag = String(latestStableTag ?? '').trim();
  if (tag === '') {
    return {
      ok: true,
      anchorVersion: anchor,
      latestStableVersion: '',
      drift: 'bootstrap',
      reason: `No stable tag exists yet; the anchor (${anchor}) cannot be stale against it.`,
    };
  }
  if (!STABLE_TAG_RE.test(tag)) {
    throw new Error(`latest stable tag '${latestStableTag}' is not in the expected vX.Y.Z format.`);
  }
  const latestStableVersion = tag.slice(1);
  if (anchor === latestStableVersion) {
    return {
      ok: true,
      anchorVersion: anchor,
      latestStableVersion,
      drift: 'none',
      reason: `Anchor ${anchor} matches the newest stable ${tag}.`,
    };
  }
  const drift = compareVersions(anchor, latestStableVersion) < 0 ? 'behind' : 'ahead';
  return {
    ok: false,
    anchorVersion: anchor,
    latestStableVersion,
    drift,
    reason:
      drift === 'behind'
        ? `Anchor ${anchor} is behind the newest stable ${tag}; a main-reset consolidation is still pending.`
        : `Anchor ${anchor} is ahead of the newest stable ${tag}; a consolidation advanced without a matching stable tag.`,
  };
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8', env: gitCleanEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '');
}

export const realGit = {
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
    const res = spawnSync('git', ['merge-base', '--is-ancestor', a, b], { encoding: 'utf8', env: gitCleanEnv() });
    if (res.status === 0) return true;
    if (res.status === 1) return false;
    throw new Error(
      `git merge-base --is-ancestor ${a} ${b} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
    );
  },
  bumpTypeOf: (sha, id) => parseFrontmatterBumpType(runGit(['show', `${sha}:.changeset/${id}.md`])),
};

export function readAnchorVersion() {
  const pre = JSON.parse(readFileSync('.changeset/pre.json', 'utf8'));
  if (pre.mode !== 'pre') {
    throw new Error(`Expected .changeset/pre.json mode=pre, got mode=${pre.mode}; the anchor is not meaningful.`);
  }
  const anchor = pre.initialVersions?.[FIXED_GROUP_ANCHOR];
  if (!anchor) throw new Error(`No initialVersion for ${FIXED_GROUP_ANCHOR} in .changeset/pre.json`);
  return anchor;
}

function anchorGuardMain() {
  let result;
  try {
    result = evaluateAnchorGuard({
      anchorVersion: readAnchorVersion(),
      latestStableTag: realGit.newestStableTag(),
    });
  } catch (err) {
    console.error(`::error::compute-stable-version --anchor-guard: ${err.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `anchor_ok=${result.ok ? 'true' : 'false'}`,
        `anchor_version=${result.anchorVersion}`,
        `latest_stable_version=${result.latestStableVersion}`,
        `anchor_drift=${result.drift}`,
        '',
      ].join('\n'),
    );
  }

  if (!result.ok) {
    console.error(`::error::${result.reason}`);
    process.exit(2);
  }
  log(result.reason);
}

function pointReleaseMain() {
  let result;
  try {
    const latestStableTag = realGit.newestStableTag();
    if (!latestStableTag) {
      throw new Error('No stable tag exists in this clone; a point release is a patch over an existing stable.');
    }
    result = computePointReleaseVersion(
      {
        syntheticSha: process.argv[4],
        latestStableTag,
        latestStableSha: realGit.revParse(latestStableTag),
        mode: process.argv[3],
      },
      realGit,
    );
  } catch (err) {
    console.error(`::error::compute-stable-version --point-release: ${err.message}`);
    process.exit(1);
  }

  log(
    `Point release -> ${result.tag} (${result.bump} over v${result.latestStableVersion}; ` +
      `${result.addedIds.length} added, ${result.removedIds.length} removed changesets).`,
  );
  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `point_release_version=${result.version}`,
        `point_release_tag=${result.tag}`,
        `latest_stable_version=${result.latestStableVersion}`,
        `bump=${result.bump}`,
        `added_ids=${JSON.stringify(result.addedIds)}`,
        `removed_ids=${JSON.stringify(result.removedIds)}`,
        '',
      ].join('\n'),
    );
  }
}

function main() {
  if (process.argv[2] === '--anchor-guard') {
    anchorGuardMain();
    return;
  }

  if (process.argv[2] === '--point-release') {
    pointReleaseMain();
    return;
  }

  const betaTag = process.argv[2];
  if (!betaTag) {
    log('::error::compute-stable-version: missing beta tag argument (usage: compute-stable-version.mjs <vX.Y.Z-beta.N>).');
    process.exit(1);
  }

  let result;
  try {
    result = computeStablePromotion(betaTag, realGit);
  } catch (err) {
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
      `delta_ids=${JSON.stringify(result.deltaIds ?? [])}`,
    ];
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
