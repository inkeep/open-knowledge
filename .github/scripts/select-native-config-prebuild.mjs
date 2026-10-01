import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PREBUILD_WORKFLOW = 'native-config-prebuild.yml';

const PREBUILD_NAME = 'native-config-prebuild';

const NATIVE_CONFIG_PATH = 'packages/native-config';

export const DEFAULT_CANDIDATE_LIMIT = 30;

export function selectPrebuildRun({ candidates = [], isAncestor, treeAt, releaseRef = 'HEAD' }) {
  const releaseTree = treeAt(releaseRef);
  if (releaseTree === null) return null;

  for (const candidate of candidates) {
    const runId = String(candidate?.databaseId ?? '').trim();
    const headSha = String(candidate?.headSha ?? '').trim();
    if (runId === '' || headSha === '') continue;
    if (!isAncestor(headSha, releaseRef)) continue;
    if (treeAt(headSha) !== releaseTree) continue;
    return { runId, headSha };
  }
  return null;
}

export function describeNoSelection(candidates = []) {
  const newest = candidates.find((c) => String(c?.headSha ?? '').trim() !== '');
  if (!newest) {
    return `no successful ${PREBUILD_NAME} run on main found`;
  }
  return (
    `no successful ${PREBUILD_NAME} run on main carries this release's ${NATIVE_CONFIG_PATH} ` +
    `source (newest green run ${newest.databaseId} @ ${newest.headSha} does not); ` +
    `re-run the prebuild on a commit contained in this release`
  );
}

export function describeSelectionFailure({ candidates = [], treeAt, releaseRef = 'HEAD' }) {
  if (treeAt(releaseRef) === null) {
    return (
      `could not read ${NATIVE_CONFIG_PATH} at the release commit (${releaseRef}); ` +
      `the release ref is what did not resolve, not the prebuild runs — ` +
      `check that the ref exists and that the checkout reaches it (fetch-depth)`
    );
  }
  return describeNoSelection(candidates);
}

const LIST_ATTEMPTS = 3;

function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function listPrebuildRuns({
  limit = DEFAULT_CANDIDATE_LIMIT,
  run = spawnSync,
  sleep = sleepSyncMs,
} = {}) {
  let lastFailure = '';
  for (let attempt = 1; attempt <= LIST_ATTEMPTS; attempt += 1) {
    const res = run(
      'gh',
      [
        'run',
        'list',
        `--workflow=${PREBUILD_WORKFLOW}`,
        '--branch',
        'main',
        '--event',
        'push',
        '--status',
        'success',
        '--limit',
        String(limit),
        '--json',
        'databaseId,headSha',
      ],
      { encoding: 'utf8' },
    );
    if (res.status === 0) {
      const parsed = JSON.parse(String(res.stdout || '[]').trim() || '[]');
      return Array.isArray(parsed) ? parsed : [];
    }
    lastFailure = res.error?.message ?? String(res.stderr || '').trim();
    if (attempt < LIST_ATTEMPTS) sleep(attempt * 1000);
  }
  throw new Error(
    `gh run list for ${PREBUILD_WORKFLOW} failed after ${LIST_ATTEMPTS} attempts: ${lastFailure}`,
  );
}

function failureOf(res) {
  if (res.error) return `failed to spawn: ${res.error.message}`;
  if (res.signal) return `killed by signal ${res.signal}`;
  const stderr = String(res.stderr || '').trim();
  return `failed (exit ${res.status})${stderr ? `: ${stderr}` : ''}`;
}

function makeGitAnswer(run) {
  return (args) => {
    const res = run('git', args, { encoding: 'utf8' });
    if (res.error || res.signal || (res.status !== 0 && res.status !== 1)) {
      throw new Error(`git ${args.join(' ')} ${failureOf(res)}`);
    }
    return { yes: res.status === 0, stdout: String(res.stdout || '').trim() };
  };
}

export function makeIsAncestor(run = spawnSync) {
  const git = makeGitAnswer(run);
  return (sha, ref) =>
    git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).yes &&
    git(['merge-base', '--is-ancestor', sha, ref]).yes;
}

export function makeTreeAt(run = spawnSync) {
  const git = makeGitAnswer(run);
  return (ref) => {
    const { yes, stdout } = git([
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}:${NATIVE_CONFIG_PATH}`,
    ]);
    return yes && stdout !== '' ? stdout : null;
  };
}

export function main(argv = process.argv.slice(2), io = {}) {
  const { list = listPrebuildRuns, isAncestor = makeIsAncestor(), treeAt = makeTreeAt() } = io;
  const refFlag = argv.indexOf('--release-ref');
  const releaseRef = refFlag === -1 ? 'HEAD' : (argv[refFlag + 1] ?? 'HEAD');

  const candidates = list();
  const selection = selectPrebuildRun({ candidates, isAncestor, treeAt, releaseRef });
  if (!selection) {
    return { ok: false, reason: describeSelectionFailure({ candidates, treeAt, releaseRef }) };
  }
  return { ok: true, line: `${selection.runId}\t${selection.headSha}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = main();
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      process.exit(1);
    }
    process.stdout.write(`${result.line}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
