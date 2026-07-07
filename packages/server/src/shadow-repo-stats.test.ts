/**
 * `countStaleAgentWipRefs` — the diagnose dead-agent-chain proxy.
 * Proves the disk-only signal counts stale `agent-*` chains, excludes principals
 * (folded by the 30-day TTL, not the fast auto path), excludes park/non-session
 * refs, and honors the staleness cutoff — all without the live keepalive map.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { countStaleAgentWipRefs } from './shadow-repo-stats.ts';

let tmpDir: string;
let shadow: ShadowHandle;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-stale-stats-'));
  const projectRoot = resolve(tmpDir, 'project');
  const contentDir = resolve(projectRoot, 'content/docs');
  mkdirSync(contentDir, { recursive: true });
  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(resolve(contentDir, 'intro.md'), '# Hello\n');
  await git.add('.');
  await git.commit('Initial commit');
  shadow = await initShadowRepo(projectRoot);
});

/** Point a WIP ref at a commit stamped with an explicit committer date + subject. */
async function createRefAt(refname: string, isoDate: string, subject: string): Promise<void> {
  const sg = shadowGit(shadow);
  const emptyTreeSha = (await sg.raw('hash-object', '-t', 'tree', '-w', '/dev/null')).trim();
  const commitSha = (
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      })
      .raw('commit-tree', emptyTreeSha, '-m', subject)
  ).trim();
  await sg.raw('update-ref', refname, commitSha);
}

const OLD = '2020-01-01T00:00:00+00:00'; // far past the staleness window
const NOW_ISH = new Date().toISOString();
const cutoff = () => Date.now() - 30 * 60 * 1000;

describe('countStaleAgentWipRefs (diagnose dead-agent-chain proxy)', () => {
  test('counts stale agent chains', async () => {
    await createRefAt('refs/wip/main/agent-a', OLD, 'wip: a');
    await createRefAt('refs/wip/main/agent-b', OLD, 'wip: b');
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(2);
  });

  test('stale principal chains are NOT counted (folded by the 30-day TTL, not the fast path)', async () => {
    await createRefAt('refs/wip/main/agent-a', OLD, 'wip: a');
    await createRefAt('refs/wip/main/principal-b', OLD, 'wip: b');
    await createRefAt('refs/wip/main/principal-c', OLD, 'wip: c');
    // Only the one agent chain counts; the two stale principals are expected, not degradation.
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(1);
  });

  test('a fresh (recently-advanced) agent chain is NOT counted', async () => {
    await createRefAt('refs/wip/main/agent-live', NOW_ISH, 'wip: live');
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(0);
  });

  test('non-session writers (file-system, git-upstream, service) are excluded', async () => {
    await createRefAt('refs/wip/main/file-system', OLD, 'wip: fs');
    await createRefAt('refs/wip/main/git-upstream', OLD, 'wip: upstream');
    await createRefAt('refs/wip/main/openknowledge-service', OLD, 'wip: svc');
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(0);
  });

  test('park-tipped agent refs are excluded (branch-switch state, never folded)', async () => {
    await createRefAt('refs/wip/main/agent-parked', OLD, 'park: main -> feature');
    await createRefAt('refs/wip/main/agent-dead', OLD, 'wip: dead');
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(1);
  });

  test('scans across branches (branch-agnostic, mirroring countWipRefs)', async () => {
    await createRefAt('refs/wip/main/agent-x', OLD, 'wip: x');
    await createRefAt('refs/wip/feature/agent-y', OLD, 'wip: y');
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(2);
  });

  test('the staleness cutoff is the boundary: a ref committed after the cutoff is not counted', async () => {
    // Committed 5 min ago — inside the 30-min window, so still "live".
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await createRefAt('refs/wip/main/agent-recent', fiveMinAgo, 'wip: recent');
    expect(await countStaleAgentWipRefs(shadow, cutoff())).toBe(0);
  });

  test('no WIP refs → zero', async () => {
    expect(await countStaleAgentWipRefs(shadow, Date.now())).toBe(0);
  });
});
