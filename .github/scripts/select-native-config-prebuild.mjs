// Picks the native-config prebuild run whose `.node` bundle a release may stage.
//
// The cross-platform binaries come from the standalone native-config-prebuild
// workflow, which runs only when `packages/native-config/**` (or its own
// workflow file) changes on `main`. Both publish paths — release.yml's npm cut
// and desktop-release.yml's `prepare` — stage that bundle, and both must answer
// the same question: which green prebuild run was built from the native-config
// source that is actually in the commit being released?
//
// Extracted here (rather than inline bash, duplicated in two workflows) so the
// answer is unit-tested, mirroring the select-beta-to-promote.mjs precedent.
// Both workflows execute on the public mirror after a push to main, so they are
// structurally unexercisable pre-merge — a test on the pure core is the only
// verification this logic can get before it runs against a real release.
// point-release-plan.mjs imports the same core for its `native-config-drift`
// preflight, so the prediction and the publish cannot disagree.
//
// WHY NEWEST-ANCESTOR, NOT NEWEST. The previous implementation took the single
// newest green run (`gh run list --limit 1`) and hard-failed a stable cut when
// that run's commit was not an ancestor of the release commit. That inverts on
// every stable tag cut BEFORE the most recent native-config change: the newest
// prebuild is then a DESCENDANT of the release commit, so the ancestor test
// fails and the release is refused even though an older prebuild built from
// byte-identical native-config source is sitting right there. It wedged
// v0.58.10 and v0.58.11 (2026-08-20), whose tags predate the Linux-terminal
// change (#3648) that produced the newest prebuild; the correct bundle was the
// 2026-07-24 run, an ancestor of both. Walking newest -> oldest and taking the
// first ANCESTOR yields the newest prebuild at-or-before the release commit,
// which — because the prebuild runs on every native-config change — is exactly
// the run whose source the release ships.
//
// WHY THE TREE COMPARISON. Ancestry alone is necessary but not sufficient: if a
// prebuild run FAILED for some native-config change, the newest *green* ancestor
// is older than that change and its binaries no longer match the release's Rust
// source. Comparing the `packages/native-config` tree object makes the guard's
// own claim — "built from source that is actually in this release" — something
// the code verifies rather than assumes. Trees only move forward, so when the
// newest ancestor's tree already differs no older one can match; the walk then
// finds nothing and the caller degrades (beta) or refuses (stable), which is the
// honest answer when no matching bundle exists.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Workflow whose artifacts carry the per-platform `.node` binaries. */
const PREBUILD_WORKFLOW = 'native-config-prebuild.yml';

// The operator-facing name, kept without the `.yml` so the refusal reads the way
// it always has — these strings end up in a Slack page and a job annotation.
const PREBUILD_NAME = 'native-config-prebuild';

/** Tree compared between a candidate run's commit and the release commit. */
const NATIVE_CONFIG_PATH = 'packages/native-config';

// The prebuild is path-filtered, so green runs on main are rare (four in the
// repo's history as of 2026-08). Thirty covers years of native-config churn at
// the cost of one `gh run list` page.
export const DEFAULT_CANDIDATE_LIMIT = 30;

/**
 * Pure core: the newest candidate that both descends into the release commit
 * and carries the release's native-config source.
 *
 * `candidates` must be newest-first, the order `gh run list` returns.
 * `isAncestor` and `treeAt` are the injected git boundary; `treeAt` returns
 * null when the path or the commit is not resolvable, which is a skip rather
 * than an error — a prebuild commit can legitimately be absent or unrelated
 * (a descendant of the release, or a rewritten main line).
 *
 * Returns `{ runId, headSha }`, or null when nothing qualifies.
 */
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

/**
 * Why nothing qualified, phrased for the operator reading the page.
 *
 * The newest candidate is named because it is the run they will find by hand,
 * and "the newest one is not it" is the part that otherwise looks like a bug.
 */
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

/**
 * Why no run was selected, distinguishing the two ways that happens.
 *
 * An unreadable release ref is NOT "no prebuild matches": it means we could not
 * read `packages/native-config` at the commit being released, so nothing could
 * have matched. Falling through to describeNoSelection there names the newest
 * prebuild run as the thing that does not fit and sends the operator off to
 * re-run a prebuild — the same confident-but-wrong diagnosis this module exists
 * to stop, one layer down.
 */
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

/**
 * Green prebuild runs on `main`, newest first.
 *
 * `--event push` and `--branch main` are load-bearing, not cosmetic: the
 * prebuild also runs on `pull_request`, including external PRs against the
 * public mirror, so without them a candidate could be unmerged source — a
 * supply-chain gap for native code executed on every CLI invocation.
 *
 * An unreadable answer is not an empty answer, so a non-zero `gh` throws
 * rather than silently reading as "no runs exist".
 */
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

/** git boundary: containment, tolerating an unresolvable commit as "no". */
export function makeIsAncestor(run = spawnSync) {
  return (sha, ref) =>
    run('git', ['merge-base', '--is-ancestor', sha, ref], { encoding: 'utf8' }).status === 0;
}

/** git boundary: the `packages/native-config` tree object at a ref, or null. */
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

/**
 * CLI: prints `<runId>\t<headSha>` on success.
 *
 * A non-zero exit means "stage nothing" and carries the reason on stderr. Both
 * callers route that into their own degrade-or-fail branch, which keeps the
 * beta-degrades / stable-refuses split where it already lives rather than
 * splitting the release policy across two files.
 */
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
