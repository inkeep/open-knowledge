import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { renameTrackedPathInGit } from './api-extension.ts';
import { ConflictStore } from './conflict-storage.ts';
import { readProjectGitLog } from './content/project-log.ts';
import { readShadowLog } from './content/shadow-log.ts';
import { TRACKED_MCP_CONFIG_TARGETS } from './mcp-config-reconciler.ts';
import { logSeededReachable } from './rename-log.ts';
import {
  commitWip,
  initShadowRepo,
  type ShadowHandle,
  saveVersion,
  type WriterIdentity,
} from './shadow-repo.ts';
import { computeShareFreshness } from './share/freshness.ts';
import { createGitTriangle, type GitTriangle } from './share/git-fixture.test-helper.ts';
import { computeShareTargetStatus } from './share/target-status.ts';
import { restoreSkillVersion } from './skill-restore.ts';
import { SyncEngine } from './sync-engine.ts';
import { getDocumentHistory } from './timeline-query.ts';

const MAGIC_PREFIX_DOC = ':colon.md';
const EXCLUDE_MAGIC_DOC = ':!bang.md';
const PLAIN_DOC = 'plain.md';

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function addByLiteralPathspec(cwd: string, relPaths: string[]): void {
  git(cwd, ['add', '--', ...relPaths.map((p) => `:(literal)${p}`)]);
}

function originTreePaths(bareDir: string): string[] {
  const out = git(bareDir, ['ls-tree', '-r', '--name-only', 'main']);
  return out === '' ? [] : out.split('\n');
}

let tmpDir = '';
let projectDir = '';
let okDir = '';

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-pathspec-invariance-'));
  projectDir = join(tmpDir, 'project');
  okDir = join(projectDir, '.ok', LOCAL_DIR);
  mkdirSync(okDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const triangles: GitTriangle[] = [];

function newTriangle(): GitTriangle {
  const t = createGitTriangle();
  triangles.push(t);
  return t;
}

afterEach(() => {
  for (const t of triangles.splice(0)) t.cleanup();
});

async function initProjectWithBareRemote(): Promise<string> {
  const bareDir = join(tmpDir, 'bare.git');
  mkdirSync(bareDir, { recursive: true });
  await simpleGit(bareDir).init(true);
  await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

  const g = simpleGit(projectDir);
  await g.init(['--initial-branch=main']);
  await g.raw('config', 'user.name', 'Test');
  await g.raw('config', 'user.email', 'test@test.com');
  writeFileSync(join(projectDir, 'README.md'), '# seed\n', 'utf-8');
  await g.add('.');
  await g.commit('seed');
  await g.addRemote('origin', bareDir);
  await g.push(['--set-upstream', 'origin', 'main']);
  return bareDir;
}

function makePushEngine(): SyncEngine {
  return new SyncEngine({
    projectDir,
    contentDir: projectDir,
    contentFilter: stubContentFilter,
    syncEnabled: true,
  });
}

describe('pathspec name invariance — sync-engine stageContentFiles (site 1)', () => {
  test('a doc whose name starts with ":" is pushed, and does not strand its plain siblings', async () => {
    const bareDir = await initProjectWithBareRemote();
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'colon body\n', 'utf-8');
    writeFileSync(join(projectDir, PLAIN_DOC), 'plain body\n', 'utf-8');

    const engine = makePushEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      expect(originTreePaths(bareDir)).toEqual(
        expect.arrayContaining([MAGIC_PREFIX_DOC, PLAIN_DOC]),
      );
      expect(git(projectDir, ['status', '--porcelain'])).toBe('');
    } finally {
      await engine.destroy();
    }
  });

  test('a doc whose name starts with ":!" is pushed rather than silently dropped', async () => {
    const bareDir = await initProjectWithBareRemote();
    writeFileSync(join(projectDir, EXCLUDE_MAGIC_DOC), 'exclusion-magic body\n', 'utf-8');
    writeFileSync(join(projectDir, PLAIN_DOC), 'plain body\n', 'utf-8');

    const engine = makePushEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      expect(originTreePaths(bareDir)).toEqual(
        expect.arrayContaining([EXCLUDE_MAGIC_DOC, PLAIN_DOC]),
      );
    } finally {
      await engine.destroy();
    }
  });
});

describe('pathspec name invariance — share freshness probes (site 2)', () => {
  test('an uncommitted edit to a ":"-named doc reads stale, exactly as a plain doc does', async () => {
    const t = newTriangle();
    t.writeWorkingTree(MAGIC_PREFIX_DOC, 'v1\n');
    t.writeWorkingTree(PLAIN_DOC, 'v1\n');
    addByLiteralPathspec(t.senderDir, [MAGIC_PREFIX_DOC, PLAIN_DOC]);
    t.git(t.senderDir, ['commit', '-m', 'seed both']);
    t.git(t.senderDir, ['push', 'origin', t.branch]);

    t.writeWorkingTree(MAGIC_PREFIX_DOC, 'v2 local edit\n');
    t.writeWorkingTree(PLAIN_DOC, 'v2 local edit\n');

    expect(await computeShareFreshness(t.senderDir, t.branch, PLAIN_DOC, 'doc')).toBe('stale');
    expect(await computeShareFreshness(t.senderDir, t.branch, MAGIC_PREFIX_DOC, 'doc')).toBe(
      'stale',
    );
  });

  test('an untracked doc inside a ":"-named folder makes that folder stale', async () => {
    const t = newTriangle();
    t.writeWorkingTree(':folder/a.md', 'a\n');
    addByLiteralPathspec(t.senderDir, [':folder/a.md']);
    t.git(t.senderDir, ['commit', '-m', 'seed colon folder']);
    t.git(t.senderDir, ['push', 'origin', t.branch]);

    t.writeWorkingTree(':folder/new.md', 'brand new, unstaged\n');

    expect(await computeShareFreshness(t.senderDir, t.branch, ':folder', 'folder')).toBe('stale');
  });
});

describe('pathspec name invariance — share target status (site 12)', () => {
  test('a ":"-named doc deleted on origin reads deleted, not never-on-branch', async () => {
    const t = newTriangle();
    t.writeWorkingTree(MAGIC_PREFIX_DOC, '# will be removed with no successor\n');
    addByLiteralPathspec(t.senderDir, [MAGIC_PREFIX_DOC]);
    t.git(t.senderDir, ['commit', '-m', 'seed colon doc']);
    t.git(t.senderDir, ['push', 'origin', t.branch]);

    const receiver = t.cloneReceiver();

    t.git(t.senderDir, ['rm', '--', `:(literal)${MAGIC_PREFIX_DOC}`]);
    t.git(t.senderDir, ['commit', '-m', 'delete colon doc']);
    t.git(t.senderDir, ['push', 'origin', t.branch]);

    const status = await computeShareTargetStatus(receiver, t.branch, MAGIC_PREFIX_DOC, 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('deleted');
  });
});

describe('pathspec name invariance — project git log (site 10)', () => {
  test('a ":"-named doc has its commit history, not an empty list', async () => {
    await initProjectWithBareRemote();
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'colon v1\n', 'utf-8');
    writeFileSync(join(projectDir, PLAIN_DOC), 'plain v1\n', 'utf-8');
    addByLiteralPathspec(projectDir, [MAGIC_PREFIX_DOC, PLAIN_DOC]);
    git(projectDir, ['commit', '-m', 'add both docs']);

    const plain = await readProjectGitLog(projectDir, PLAIN_DOC, 5);
    const magic = await readProjectGitLog(projectDir, MAGIC_PREFIX_DOC, 5);

    expect(plain.source).toBe('git');
    expect(plain.commits.length).toBe(1);
    expect(magic.source).toBe('git');
    expect(magic.commits.length).toBe(1);
    expect(magic.commits[0]?.subject).toBe('add both docs');
  });
});

describe('pathspec name invariance — conflict resolution (site 8)', () => {
  test("resolving a ':'-named index conflict with 'theirs' clears the unmerged entry", async () => {
    await initProjectWithBareRemote();
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'base\n', 'utf-8');
    addByLiteralPathspec(projectDir, [MAGIC_PREFIX_DOC]);
    git(projectDir, ['commit', '-m', 'base colon doc']);

    git(projectDir, ['checkout', '-b', 'side']);
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'their version\n', 'utf-8');
    addByLiteralPathspec(projectDir, [MAGIC_PREFIX_DOC]);
    git(projectDir, ['commit', '-m', 'side edit']);

    git(projectDir, ['checkout', 'main']);
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'my version\n', 'utf-8');
    addByLiteralPathspec(projectDir, [MAGIC_PREFIX_DOC]);
    git(projectDir, ['commit', '-m', 'main edit']);

    try {
      git(projectDir, ['merge', 'side']);
    } catch {}
    expect(git(projectDir, ['ls-files', '-u'])).not.toBe('');

    const store = new ConflictStore(projectDir, 'main');
    store.addConflict({ file: MAGIC_PREFIX_DOC, detectedAt: new Date().toISOString() });

    await expect(store.resolveConflict(MAGIC_PREFIX_DOC, 'theirs')).resolves.toBeUndefined();

    expect(git(projectDir, ['ls-files', '-u'])).toBe('');
    expect(store.count()).toBe(0);
  });
});

describe('pathspec name invariance — commitBlockingPaths (site 3)', () => {
  const BLOCKING_NAME = ':colon.json';

  const markdownOnlyFilter = {
    isExcluded: (path: string) => !path.endsWith('.md'),
    isDirExcluded: (_path: string) => false,
  };

  async function setupColonNamedOverlap(): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);
    await bare.raw('symbolic-ref', 'HEAD', 'refs/heads/main');

    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, BLOCKING_NAME), '{"a":1}\n', 'utf-8');
    writeFileSync(join(sisterDir, 'foo.md'), 'base\n', 'utf-8');
    await sister.add('-A');
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });
    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    writeFileSync(join(sisterDir, BLOCKING_NAME), '{"a":99}\n', 'utf-8');
    await sister.add('-A');
    await sister.commit('remote edit');
    await sister.push('origin', 'main');

    writeFileSync(join(projectDir, BLOCKING_NAME), '{"a":2}\n', 'utf-8');
  }

  test('a ":"-named blocking path is committed on request and the pause is cleared', async () => {
    await setupColonNamedOverlap();
    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: markdownOnlyFilter,
      mode: 'full',
    });
    try {
      await engine.start();
      await engine.pullOnce('sync');
      expect(engine.getStatus().blockingPaths).toEqual([BLOCKING_NAME]);

      await expect(engine.commitBlockingPaths()).resolves.not.toBeNull();
      expect(git(projectDir, ['show', `HEAD:${BLOCKING_NAME}`])).toBe('{"a":2}');
      expect(engine.getStatus().blockingPaths).toBeUndefined();
    } finally {
      await engine.destroy();
    }
  });
});

describe('pathspec name invariance — shadow-repo per-path history (sites 9, 10, 11)', () => {
  const human: WriterIdentity = {
    id: 'human-ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  };

  async function shadowWithBothDocs(): Promise<{ shadow: ShadowHandle; wipSha: string }> {
    const g = simpleGit(projectDir);
    await g.init(['--initial-branch=main']);
    await g.raw('config', 'user.name', 'Test');
    await g.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# seed\n', 'utf-8');
    await g.add('README.md');
    await g.commit('seed');

    const shadow = await initShadowRepo(projectDir);
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'colon v1\n', 'utf-8');
    writeFileSync(join(projectDir, PLAIN_DOC), 'plain v1\n', 'utf-8');
    const wipSha = await commitWip(shadow, human, '.', 'WIP: edit both docs', 'main');
    return { shadow, wipSha };
  }

  test('getDocumentHistory returns the WIP entry for a ":"-named doc (site 9)', async () => {
    const { shadow } = await shadowWithBothDocs();

    const plain = await getDocumentHistory(shadow, { docName: 'plain' }, '.');
    const magic = await getDocumentHistory(shadow, { docName: ':colon' }, '.');

    expect(plain.entries.length).toBe(1);
    expect(magic.entries.length).toBe(1);
    expect(magic.entries[0]?.type).toBe('wip');
  });

  test('readShadowLog returns the WIP commit for a ":"-named doc (site 10)', async () => {
    await shadowWithBothDocs();

    const plain = await readShadowLog(projectDir, PLAIN_DOC, 5);
    const magic = await readShadowLog(projectDir, MAGIC_PREFIX_DOC, 5);

    expect(plain.source).toBe('shadow-repo');
    expect(plain.commits.length).toBe(1);
    expect(magic.source).toBe('shadow-repo');
    expect(magic.commits.length).toBe(1);
  });

  test('logSeededReachable finds commits touching a ":"-named doc (site 11)', async () => {
    const { shadow, wipSha } = await shadowWithBothDocs();

    const plain = await logSeededReachable(shadow, ['--format=%H'], [wipSha], PLAIN_DOC);
    const magic = await logSeededReachable(shadow, ['--format=%H'], [wipSha], MAGIC_PREFIX_DOC);

    expect(plain.trim()).not.toBe('');
    expect(magic.trim()).not.toBe('');
  });
});

describe('pathspec name invariance — index removal of vanished paths (site 4)', () => {
  test('the deletion of a ":"-named doc is committed and pushed', async () => {
    const bareDir = await initProjectWithBareRemote();
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'colon body\n', 'utf-8');
    writeFileSync(join(projectDir, PLAIN_DOC), 'plain body\n', 'utf-8');
    addByLiteralPathspec(projectDir, [MAGIC_PREFIX_DOC, PLAIN_DOC]);
    git(projectDir, ['commit', '-m', 'add both docs']);
    git(projectDir, ['push', 'origin', 'main']);

    rmSync(join(projectDir, MAGIC_PREFIX_DOC));

    const engine = makePushEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      const landed = originTreePaths(bareDir);
      expect(landed).toContain(PLAIN_DOC);
      expect(landed).not.toContain(MAGIC_PREFIX_DOC);
    } finally {
      await engine.destroy();
    }
  });
});

describe('pathspec name invariance — non-content merge auto-resolve (site 5)', () => {
  const NON_CONTENT_NAME = ':colon.json';

  async function setupNonContentDivergence(fileName: string): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);
    await bare.raw('symbolic-ref', 'HEAD', 'refs/heads/main');

    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, fileName), '{"a":1}\n', 'utf-8');
    writeFileSync(join(sisterDir, 'foo.md'), 'base\n', 'utf-8');
    await sister.add('-A');
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });
    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    writeFileSync(join(sisterDir, fileName), '{"a":99}\n', 'utf-8');
    await sister.add('-A');
    await sister.commit('modify on remote');
    await sister.push('origin', 'main');

    writeFileSync(join(projectDir, fileName), '{"a":2}\n', 'utf-8');
    await project.add('-A');
    await project.commit('modify locally');
  }

  test('a modify/modify conflict on a ":"-named non-content file auto-resolves to theirs', async () => {
    await setupNonContentDivergence(NON_CONTENT_NAME);

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
    });
    try {
      await engine.start();
      await engine.pullOnce('sync');

      const status = engine.getStatus();
      expect(status.pausedReason).toBeUndefined();
      expect(status.pullError ?? '').toBe('');
      expect(git(projectDir, ['ls-files', '-u'])).toBe('');
    } finally {
      await engine.destroy();
    }
  });
});

describe('pathspec name invariance — pull-only overlay restore (site 6)', () => {
  interface OverlayOutcome {
    outcome: string;
    pullErrorEmpty: boolean;
    pausedReason: string | undefined;
    onDisk: string;
  }

  async function pullOnlyOverlayScenario(label: string, docName: string): Promise<OverlayOutcome> {
    const root = join(tmpDir, label);
    const bareDir = join(root, 'bare.git');
    const sisterDir = join(root, 'sister');
    const cloneDir = join(root, 'project');
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(sisterDir, { recursive: true });

    const bare = simpleGit(bareDir);
    await bare.init(true);
    await bare.raw('symbolic-ref', 'HEAD', 'refs/heads/main');

    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, docName), 'v1\n', 'utf-8');
    await sister.add('-A');
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    await simpleGit(root).clone(bareDir, cloneDir);
    mkdirSync(join(cloneDir, '.ok', LOCAL_DIR), { recursive: true });
    const project = simpleGit(cloneDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    writeFileSync(join(sisterDir, docName), 'v2 remote\n', 'utf-8');
    await sister.add('-A');
    await sister.commit('remote edit');
    await sister.push('origin', 'main');

    writeFileSync(join(cloneDir, docName), 'v2 local overlay\n', 'utf-8');

    const engine = new SyncEngine({
      projectDir: cloneDir,
      contentDir: cloneDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
      mode: 'pull-only',
    });
    try {
      await engine.start();
      const outcome = await engine.pullOnce('pull');
      const status = engine.getStatus();
      return {
        outcome,
        pullErrorEmpty: (status.pullError ?? '') === '',
        pausedReason: status.pausedReason,
        onDisk: readFileSync(join(cloneDir, docName), 'utf-8'),
      };
    } finally {
      await engine.destroy();
    }
  }

  test('a ":"-named overlapping overlay pulls exactly as a plain-named one does', async () => {
    const plain = await pullOnlyOverlayScenario('plain-arm', PLAIN_DOC);
    expect(plain.outcome).not.toBe('error');
    expect(plain.onDisk).toBe(
      '<<<<<<< HEAD\nv2 local overlay\n=======\nv2 remote\n>>>>>>> origin/main\n',
    );

    const magic = await pullOnlyOverlayScenario('magic-arm', MAGIC_PREFIX_DOC);
    expect(magic).toEqual(plain);
  });
});

describe('pathspec name invariance — tracked-path rename probe (site 15)', () => {
  test('a ":"-named doc renames through git instead of degrading to a filesystem rename', async () => {
    await initProjectWithBareRemote();
    writeFileSync(join(projectDir, MAGIC_PREFIX_DOC), 'colon body\n', 'utf-8');
    writeFileSync(join(projectDir, PLAIN_DOC), 'plain body\n', 'utf-8');
    addByLiteralPathspec(projectDir, [MAGIC_PREFIX_DOC, PLAIN_DOC]);
    git(projectDir, ['commit', '-m', 'add both docs']);

    const plain = await renameTrackedPathInGit(
      projectDir,
      join(projectDir, PLAIN_DOC),
      join(projectDir, 'plain-renamed.md'),
    );
    const magic = await renameTrackedPathInGit(
      projectDir,
      join(projectDir, MAGIC_PREFIX_DOC),
      join(projectDir, 'colon-renamed.md'),
    );

    expect(plain).toBe(true);
    expect(magic).toBe(true);
    expect(git(projectDir, ['status', '--porcelain']).split('\n').sort()).toEqual([
      'R  :colon.md -> colon-renamed.md',
      'R  plain.md -> plain-renamed.md',
    ]);
  });
});

describe('pathspec argv sites with no product-producible hostile input today', () => {
  const human: WriterIdentity = {
    id: 'human-ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  };
  const WILDCARD_SKILL = 'star*';
  const SIBLING_SKILL = 'starfish';

  test('restoring a wildcard-named skill restores only its own files', async () => {
    const g = simpleGit(projectDir);
    await g.init(['--initial-branch=main']);
    await g.raw('config', 'user.name', 'Test');
    await g.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# seed\n', 'utf-8');
    await g.add('README.md');
    await g.commit('seed');

    const shadow = await initShadowRepo(projectDir);
    for (const name of [WILDCARD_SKILL, SIBLING_SKILL]) {
      mkdirSync(join(projectDir, '.ok', 'skills', name), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf-8');
    }
    const saved = await saveVersion(shadow, '.', [human], 'main', 'seed skills');
    expect(saved.checkpointRef).toBeTruthy();

    const restored = await restoreSkillVersion({
      shadow,
      contentDir: projectDir,
      contentRoot: '.',
      name: WILDCARD_SKILL,
      version: saved.checkpointRef,
    });

    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.restoredFiles).toEqual(['SKILL.md']);
  });

  test('every tracked MCP config target is free of pathspec magic (sites 6b, 7)', () => {
    for (const target of TRACKED_MCP_CONFIG_TARGETS) {
      expect(target.startsWith(':')).toBe(false);
      expect(/[*?[\]]/.test(target)).toBe(false);
    }
  });
});
