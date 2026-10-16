#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from './git-clean-env.mjs';
import { bumpSemver, loadChangesets, maxBumpType, maxReleaseType } from './changeset-versions.mjs';

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

export function runGit(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitCleanEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '');
}

export function changesetIdsFromTreePaths(paths) {
  const ids = [];
  for (const path of paths) {
    const file = path.trim().replace(/^\.changeset\//, '');
    if (!file.startsWith('.') && file.endsWith('.md') && !/^README\.md$/i.test(file)) {
      ids.push(file.replace('.md', ''));
    }
  }
  return ids;
}

export function gitAt(cwd) {
  return {
    revParse: (ref) => runGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd).trim(),
    newestStableTag: () => {
      for (const line of runGit(['tag', '--list', 'v*', '--sort=-version:refname'], cwd).split('\n')) {
        const t = line.trim();
        if (STABLE_TAG_RE.test(t)) return t;
      }
      return '';
    },
    changesetIds: (sha) =>
      changesetIdsFromTreePaths(runGit(['ls-tree', '--name-only', sha, '--', '.changeset/'], cwd).split('\n')),
    changesetBlobs: (sha) => {
      const blobs = new Map();
      for (const line of runGit(['ls-tree', sha, '--', '.changeset/'], cwd).split('\n')) {
        const [meta, path] = line.split('\t');
        const [id] = changesetIdsFromTreePaths([path ?? '']);
        if (id !== undefined) blobs.set(id, meta.split(' ')[2]);
      }
      return blobs;
    },
    isAncestor: (a, b) => {
      const res = spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, encoding: 'utf8', env: gitCleanEnv() });
      if (res.status === 0) return true;
      if (res.status === 1) return false;
      throw new Error(
        `git merge-base --is-ancestor ${a} ${b} failed (exit ${res.status}): ${String(res.stderr || '').trim()}`,
      );
    },
    changesetText: (sha, id) => runGit(['show', `${sha}:./.changeset/${id}.md`], cwd),
    stableTags: () =>
      runGit(['tag', '--list', 'v*'], cwd)
        .split('\n')
        .map((line) => line.trim())
        .filter((tag) => STABLE_TAG_RE.test(tag)),
    bumpTypeOf: (sha, id) =>
      maxReleaseType(loadChangesets().parse(runGit(['show', `${sha}:./.changeset/${id}.md`], cwd)).releases),
  };
}

export function releasedChangesetIds(git, { excludeTags = [], releasedTags = null } = {}) {
  const excluded = new Set(excludeTags);
  const released = new Set();
  for (const tag of releasedTags ?? git.stableTags()) {
    if (excluded.has(tag)) continue;
    for (const id of git.changesetIds(tag)) released.add(id);
  }
  return released;
}

export function unreleasedChangesetIds(git, sha, { excludeTags = [], releasedTags = null } = {}) {
  const released = releasedChangesetIds(git, { excludeTags, releasedTags });
  return git.changesetIds(sha).filter((id) => !released.has(id));
}

export const realGit = gitAt();

const VERDICT_TYPES = new Set(['patch', 'minor', 'major', null]);

const BUMP_VERDICTS = {
  env: 'BUMP_VERDICTS',
  output: 'bump_verdicts',
  job: 'read-bumps',
  noun: 'bump verdict',
  value: 'bump types',
};

export function parseVerdicts(raw, { env, output, job, noun, value }) {
  if (String(raw ?? '').trim() === '') {
    throw new Error(
      `${env} is empty: the ${job} job wrote no ${output} output, or this step does not ` +
        `receive needs.${job}.outputs.${output}.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`${noun}s are not JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${noun}s must be a JSON object mapping changeset blob ids to ${value}.`);
  }
  for (const [blob, type] of Object.entries(parsed)) {
    if (!VERDICT_TYPES.has(type)) {
      throw new Error(`${noun} for blob ${blob} is ${JSON.stringify(type)}, not patch, minor, major or null.`);
    }
  }
  return new Map(Object.entries(parsed));
}

export const parseBumpVerdicts = (raw) => parseVerdicts(raw, BUMP_VERDICTS);

export const serializeBumpVerdicts = (verdicts) => JSON.stringify(Object.fromEntries(verdicts));

export function recordVerdicts(git, method, verdicts) {
  return {
    ...git,
    [method]: (sha, id) => {
      const type = git[method](sha, id);
      verdicts.set(git.changesetBlobs(sha).get(id), type);
      return type;
    },
  };
}

export function withVerdicts(git, method, verdicts, { noun }) {
  return {
    ...git,
    [method]: (sha, id) => {
      const blob = git.changesetBlobs(sha).get(id);
      if (blob === undefined || !verdicts.has(blob)) {
        throw new Error(
          `no ${noun} for .changeset/${id}.md at ${sha} (blob ${blob ?? 'absent'}); the job that ran the ` +
            `Changesets reader did not read this changeset, so its ${noun} is unknown here.`,
        );
      }
      return verdicts.get(blob);
    },
  };
}

export const recordBumpVerdicts = (git, verdicts) => recordVerdicts(git, 'bumpTypeOf', verdicts);

export const withBumpVerdicts = (git, verdicts) =>
  withVerdicts(git, 'bumpTypeOf', verdicts, BUMP_VERDICTS);

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
  if (process.argv[2] === '--point-release') {
    pointReleaseMain();
    return;
  }

  const betaTag = process.argv[2];
  if (!betaTag) {
    log('::error::compute-stable-version: missing beta tag argument (usage: compute-stable-version.mjs <vX.Y.Z-beta.N>).');
    process.exit(1);
  }

  const verdicts = new Map();
  let result;
  try {
    const git =
      process.env.BUMP_VERDICTS === undefined
        ? recordBumpVerdicts(realGit, verdicts)
        : withBumpVerdicts(realGit, parseBumpVerdicts(process.env.BUMP_VERDICTS));
    result = computeStablePromotion(betaTag, git);
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
      `bump_verdicts=${serializeBumpVerdicts(verdicts)}`,
    ];
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
