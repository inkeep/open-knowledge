import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { createContentFilter } from './content-filter.ts';
import { startWatcher, type WatcherHandle } from './file-watcher.ts';
import {
  destroyShadowRepo,
  initShadowRepo,
  type ShadowHandle,
  saveVersion,
  shadowGit,
} from './shadow-repo.ts';

const INITIAL_DOCUMENT = '# Initial\n';
const CHANGED_DOCUMENT = '# Changed\n';
const CONFIGURATION = 'content:\n  dir: .\n';
const TEMPLATE = '# Template\n';
const ORDINARY_NEIGHBOR = '# Ordinary prefix neighbor\n';
const TEMPLATE_NEIGHBOR = '# Template prefix neighbor\n';

function diskFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git') return [];
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? diskFiles(root, path) : [path];
  });
}

test('checkpoints omit a pending settle fence in a nested content directory', async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shadow-settle-fence-nested-')));
  const content = join(root, 'docs');
  const release = Promise.withResolvers<void>();
  let shadow: ShadowHandle | undefined;
  let watcher: WatcherHandle | undefined;
  let entered = false;
  let settleState = 'not-started';
  let pending: Promise<{ status: string; error?: unknown }> | undefined;
  context.onTestFinished(async () => {
    release.resolve();
    try {
      const outcome = await pending;
      if (outcome?.status === 'rejected') throw outcome.error;
    } finally {
      try {
        await watcher?.unsubscribe();
      } finally {
        if (shadow) destroyShadowRepo(shadow);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  context.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv('OK_FILE_WATCHER_BACKEND', 'parcel');
  mkdirSync(join(content, '.ok/templates'), { recursive: true });
  mkdirSync(join(content, '.ok/local'), { recursive: true });
  const expected = (document: string) => [
    ['docs/note.md', document],
    ['docs/.ok/config.yml', CONFIGURATION],
    ['docs/.ok/templates/note.md', TEMPLATE],
    ['docs/watcher-settle-fence-note.md', ORDINARY_NEIGHBOR],
    ['docs/.ok/templates/watcher-settle-fence-note.md', TEMPLATE_NEIGHBOR],
  ];
  for (const [path, bytes] of expected(INITIAL_DOCUMENT)) writeFileSync(join(root, path), bytes);
  writeFileSync(join(content, '.ok/local/fixture-state.json'), '{}\n');
  execFileSync('git', ['init', '--initial-branch=main', root], {
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    ),
    stdio: 'pipe',
    timeout: 10_000,
  });
  configureTestGitRepository(root);
  const handle = await initShadowRepo(root);
  shadow = handle;
  const subscription = await startWatcher(
    content,
    async (event) => {
      if (
        event.kind === 'update' &&
        event.docName === 'note' &&
        event.content === CHANGED_DOCUMENT
      ) {
        entered = true;
        await release.promise;
      }
    },
    createContentFilter({ projectDir: root, contentDir: content }),
    { forceBackend: 'parcel' },
  );
  watcher = subscription;
  expect(subscription.getFileIndex().has('note')).toBe(true);
  const git = shadowGit(handle);
  const capture = async () => {
    const result = await saveVersion(handle, 'docs', [], 'main', 'Nested settle fence capture');
    const commit = (await git.raw('rev-parse', result.checkpointRef)).trim();
    expect((await git.raw('cat-file', '-t', commit)).trim()).toBe('commit');
    return [commit, result.checkpointRef];
  };
  const inspect = async (objects: string[], document: string) => {
    const snapshots: { object: string; paths: string[] }[] = [];
    for (const object of objects) {
      const paths = (await git.raw('ls-tree', '-r', '-z', '--name-only', object))
        .split('\0')
        .filter(Boolean);
      for (const [path, bytes] of expected(document)) {
        expect(paths).toContain(path);
        expect(await git.raw('show', `${object}:${path}`)).toBe(bytes);
      }
      expect(paths).not.toContain('docs/.ok/local/fixture-state.json');
      snapshots.push({ object, paths });
    }
    return snapshots;
  };
  const baseline = await inspect(await capture(), INITIAL_DOCUMENT);
  for (const snapshot of baseline)
    expect(snapshot.paths.sort()).toEqual(
      expected(INITIAL_DOCUMENT)
        .map(([path]) => path)
        .sort(),
    );
  writeFileSync(join(content, 'note.md'), CHANGED_DOCUMENT);
  await expect.poll(() => entered, { timeout: 10_000 }).toBe(true);
  const before = new Set(diskFiles(root));
  settleState = 'pending';
  pending = subscription.settle().then(
    () => {
      settleState = 'resolved';
      return { status: 'resolved' };
    },
    (error: unknown) => {
      settleState = 'rejected';
      return { status: 'rejected', error };
    },
  );
  const minted = () => diskFiles(root).filter((path) => !before.has(path));
  await expect.poll(minted, { timeout: 10_000 }).toHaveLength(1);
  const fences = minted();
  for (const fence of fences) {
    expect(dirname(join(root, fence))).toBe(join(content, '.ok'));
    expect(readFileSync(join(root, fence)).length).toBe(0);
  }
  expect(settleState).toBe('pending');
  const objects = await capture();
  const whilePending = await inspect(objects, CHANGED_DOCUMENT);
  expect(settleState).toBe('pending');
  for (const fence of fences) expect(existsSync(join(root, fence))).toBe(true);
  release.resolve();
  expect(await pending).toEqual({ status: 'resolved' });
  for (const fence of fences) expect(existsSync(join(root, fence))).toBe(false);
  const afterCleanup = await inspect(objects, CHANGED_DOCUMENT);
  const admitted = (snapshots: typeof whilePending) =>
    snapshots.flatMap(({ object, paths }) => {
      const captured = paths.filter((path) => fences.includes(path));
      return captured.length ? [{ object, fences: captured }] : [];
    });
  expect({ whilePending: admitted(whilePending), afterCleanup: admitted(afterCleanup) }).toEqual({
    whilePending: [],
    afterCleanup: [],
  });
});
