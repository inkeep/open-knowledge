import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { createMaintenanceCoordinator } from './maintenance-coordinator.ts';
import { commitWip, initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

let tmpDir: string;
let projectRoot: string;
let contentDir: string;
let shadow: ShadowHandle;
let liveWriters: Set<string>;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-consolidate-test-'));
  projectRoot = resolve(tmpDir, 'project');
  contentDir = resolve(projectRoot, 'content/docs');
  mkdirSync(contentDir, { recursive: true });
  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(resolve(contentDir, 'intro.md'), '# Hello\n');
  await git.add('.');
  await git.commit('Initial commit');
  shadow = await initShadowRepo(projectRoot);
  liveWriters = new Set();
});

function makeCoordinator() {
  return createMaintenanceCoordinator({
    getShadow: () => shadow,
    getCurrentBranch: () => 'main',
    contentRoot: 'content/docs',
    isWriterLive: (w) => liveWriters.has(w),
  });
}

async function commitAs(writerId: string, content: string) {
  writeFileSync(resolve(contentDir, 'intro.md'), content);
  await commitWip(
    shadow,
    { id: writerId, name: writerId, email: `${writerId}@openknowledge.local` },
    'content/docs',
    `wip: ${writerId}`,
  );
}

async function wipRefNames(): Promise<string[]> {
  const sg = shadowGit(shadow);
  try {
    return (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/main/'))
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function latestCheckpointKind(): Promise<string | null> {
  const sg = shadowGit(shadow);
  const shas = (
    await sg.raw(
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(objectname)',
      'refs/checkpoints/main/',
    )
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  if (!shas[0]) return null;
  const body = (await sg.raw('log', '-1', '--format=%B', shas[0])).trim();
  return parseCheckpoint(body)?.kind ?? null;
}

describe('auto-consolidation (PRD-6972 FR5 / D9 / D10 / D20)', () => {
  test('8 live agents writing → zero consolidations (below dead-chain threshold)', async () => {
    for (let i = 1; i <= 8; i++) {
      await commitAs(`agent-${i}`, `# edit ${i}\n`);
      liveWriters.add(`agent-${i}`); // all live
    }
    const result = await makeCoordinator().consolidateDeadChains('flush-counter');
    expect(result.consolidated).toBe(false);
    expect(result.skipped).toBe('below-threshold');
    expect(result.deadChains).toBe(0);
  });

  test('sessions end → exactly one consolidation folds the dead chains', async () => {
    for (let i = 1; i <= 8; i++) await commitAs(`agent-${i}`, `# edit ${i}\n`);
    // No live writers → all 8 are dead.
    const result = await makeCoordinator().consolidateDeadChains('session-close');
    expect(result.consolidated).toBe(true);
    expect(result.deadChains).toBe(8);
    expect(result.widthAfter ?? 99).toBeLessThan(result.widthBefore ?? 0);

    // Dead agent WIP refs are gone; an auto-consolidation checkpoint anchors them.
    const refs = await wipRefNames();
    expect(refs.filter((r) => r.includes('/agent-'))).toHaveLength(0);
    expect(await latestCheckpointKind()).toBe('auto-consolidation');
  });

  test('losslessness is provable at the git-DAG layer: pre-fold tips are reachable from the checkpoint', async () => {
    // Symmetry with the shadow-branch-gc ancestry walk: prove the fold orphans
    // nothing by walking the real DAG from the resulting checkpoint, not just by
    // re-reading history through it. Capture each dead agent's pre-fold WIP tip.
    const sg = shadowGit(shadow);
    const preFoldTips: string[] = [];
    for (let i = 1; i <= 8; i++) {
      await commitAs(`agent-${i}`, `# edit ${i}\n`);
      preFoldTips.push((await sg.raw('rev-parse', `refs/wip/main/agent-${i}`)).trim());
    }

    const result = await makeCoordinator().consolidateDeadChains('session-close');
    expect(result.consolidated).toBe(true);
    expect(result.deadChains).toBe(8);

    // The new checkpoint's full ancestry must contain every pre-fold tip — the
    // commits survive as reachable history even though their WIP refs are gone.
    const checkpointSha = (
      await sg.raw(
        'for-each-ref',
        '--sort=-creatordate',
        '--count=1',
        '--format=%(objectname)',
        'refs/checkpoints/main/',
      )
    ).trim();
    const reachable = new Set(
      (await sg.raw('rev-list', checkpointSha)).trim().split('\n').filter(Boolean),
    );
    for (const tip of preFoldTips) {
      expect(reachable.has(tip)).toBe(true);
    }

    // And the object DB is structurally intact — no missing/broken links.
    const fsck = await sg.raw('fsck', '--full', '--connectivity-only');
    expect(fsck).not.toContain('missing');
    expect(fsck).not.toContain('broken');
  });

  test('D20: only dead AGENT chains count — principal- / classified chains survive', async () => {
    for (let i = 1; i <= 5; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    await commitAs('principal-11111111-1111-1111-1111-111111111111', '# p\n');
    await commitAs('file-system', '# fs\n');
    // Nothing live.
    const result = await makeCoordinator().consolidateDeadChains('flush-counter');
    expect(result.consolidated).toBe(true);
    expect(result.deadChains).toBe(5); // only the 5 agents

    const refs = await wipRefNames();
    expect(refs.some((r) => r.endsWith('/principal-11111111-1111-1111-1111-111111111111'))).toBe(
      true,
    );
    expect(refs.some((r) => r.endsWith('/file-system'))).toBe(true);
    expect(refs.filter((r) => r.includes('/agent-'))).toHaveLength(0);
  });

  test('park-tipped agent refs are never folded', async () => {
    for (let i = 1; i <= 5; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    // A 6th agent ref tipped with a park commit (branch-switch state).
    const sg = shadowGit(shadow);
    const tree = (await sg.raw('log', '-1', '--format=%T', 'refs/wip/main/agent-1')).trim();
    const parkSha = (
      await sg
        .env({
          GIT_DIR: shadow.gitDir,
          GIT_AUTHOR_NAME: 'svc',
          GIT_AUTHOR_EMAIL: 'svc@x',
          GIT_COMMITTER_NAME: 'svc',
          GIT_COMMITTER_EMAIL: 'svc@x',
        })
        .raw('commit-tree', tree, '-m', 'park: switching branch')
    ).trim();
    await sg.raw('update-ref', 'refs/wip/main/agent-parked', parkSha);

    const result = await makeCoordinator().consolidateDeadChains('flush-counter');
    expect(result.consolidated).toBe(true);
    expect(result.deadChains).toBe(5); // parked one excluded

    const refs = await wipRefNames();
    expect(refs.some((r) => r.endsWith('/agent-parked'))).toBe(true); // park ref survives
  });

  test('live chains are never touched while dead chains are folded (no orphan)', async () => {
    for (let i = 1; i <= 5; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    await commitAs('agent-live', '# live edit\n');
    liveWriters.add('agent-live'); // this one is live

    const result = await makeCoordinator().consolidateDeadChains('flush-counter');
    expect(result.consolidated).toBe(true);
    expect(result.deadChains).toBe(5);

    // The live agent's chain and its commit survive.
    const refs = await wipRefNames();
    expect(refs.some((r) => r.endsWith('/agent-live'))).toBe(true);
  });

  test('respects ≥10min spacing — a second immediate run is skipped', async () => {
    for (let i = 1; i <= 6; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    const coord = makeCoordinator();
    const first = await coord.consolidateDeadChains('flush-counter');
    expect(first.consolidated).toBe(true);
    // Re-create dead chains and try again immediately.
    for (let i = 7; i <= 12; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    const second = await coord.consolidateDeadChains('flush-counter');
    expect(second.consolidated).toBe(false);
    expect(second.skipped).toBe('spacing');
  });

  test('no-ops when consolidation deps are not configured', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    for (let i = 1; i <= 6; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    const result = await coord.consolidateDeadChains('flush-counter');
    expect(result.consolidated).toBe(false);
    expect(result.skipped).toBe('unconfigured');
  });

  test('a failed fold does NOT consume the spacing window (retries on the next trigger)', async () => {
    // Five dead agent chains qualify. Point the coordinator at a non-existent
    // contentRoot so saveVersion's `git add` fails and the fold throws. The fix
    // consumes spacing only AFTER a successful fold, so the failed run must NOT
    // block the next trigger with 'spacing'.
    for (let i = 1; i <= 5; i++) await commitAs(`agent-${i}`, `# a${i}\n`);
    const coord = createMaintenanceCoordinator({
      getShadow: () => shadow,
      getCurrentBranch: () => 'main',
      contentRoot: 'no-such-content-dir-xyz', // breaks saveVersion's `git add`
      isWriterLive: (w) => liveWriters.has(w),
    });
    const first = await coord.consolidateDeadChains('flush-counter');
    expect(first.consolidated).toBe(false);
    expect(first.skipped).toBe('error');
    // Spacing was NOT consumed → the immediate retry re-attempts (and errors
    // again) instead of short-circuiting with 'spacing'.
    const second = await coord.consolidateDeadChains('flush-counter');
    expect(second.skipped).toBe('error');
    expect(second.skipped).not.toBe('spacing');
  });
});

describe('D16 timeline exclusion of auto-consolidation checkpoints', () => {
  test('WIP rows survive a consolidation with no new visible checkpoint row', async () => {
    // Five dead agents each edit `intro`.
    for (let i = 1; i <= 5; i++) await commitAs(`agent-${i}`, `# edit ${i}\n`);

    const before = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    const beforeWipShas = new Set(before.entries.filter((e) => e.type === 'wip').map((e) => e.sha));
    expect(beforeWipShas.size).toBeGreaterThan(0);

    const result = await makeCoordinator().consolidateDeadChains('flush-counter');
    expect(result.consolidated).toBe(true);

    const after = await getDocumentHistory(shadow, { docName: 'intro' }, 'content/docs');
    // No auto-consolidation checkpoint row is rendered by default.
    expect(after.entries.some((e) => e.checkpoint?.kind === 'auto-consolidation')).toBe(false);
    // The same WIP rows remain visible (their ancestry is reachable through the
    // hidden checkpoint).
    const afterWipShas = new Set(after.entries.filter((e) => e.type === 'wip').map((e) => e.sha));
    for (const sha of beforeWipShas) expect(afterWipShas.has(sha)).toBe(true);

    // The opt-in param surfaces the hidden checkpoint for debugging.
    const withAuto = await getDocumentHistory(
      shadow,
      { docName: 'intro', includeAutoCheckpoints: true },
      'content/docs',
    );
    expect(withAuto.entries.some((e) => e.checkpoint?.kind === 'auto-consolidation')).toBe(true);
  });
});
