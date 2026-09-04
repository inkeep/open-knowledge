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

export function listPrebuildRuns({ limit = DEFAULT_CANDIDATE_LIMIT, run = spawnSync } = {}) {
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
  if (res.status !== 0) {
    throw new Error(
      `gh run list for ${PREBUILD_WORKFLOW} failed: ${res.error?.message ?? String(res.stderr || '').trim()}`,
    );
  }
  const parsed = JSON.parse(String(res.stdout || '[]').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

export function makeIsAncestor(run = spawnSync) {
  return (sha, ref) =>
    run('git', ['merge-base', '--is-ancestor', sha, ref], { encoding: 'utf8' }).status === 0;
}

export function makeTreeAt(run = spawnSync) {
  return (ref) => {
    const res = run('git', ['rev-parse', '--verify', `${ref}:${NATIVE_CONFIG_PATH}`], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return null;
    const tree = String(res.stdout || '').trim();
    return tree === '' ? null : tree;
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
