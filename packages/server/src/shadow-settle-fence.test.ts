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
import { join } from 'node:path';
import { expect, type TestContext, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { createContentFilter } from './content-filter.ts';
import { startWatcher, type WatcherHandle } from './file-watcher.ts';
import {
  buildWipTree,
  commitWip,
  commitWipFromTree,
  destroyShadowRepo,
  initShadowRepo,
  SERVICE_WRITER,
  type ShadowHandle,
  saveVersion,
  shadowGit,
} from './shadow-repo.ts';

const INITIAL_DOCUMENT = '# Initial\n';
const CHANGED_DOCUMENT = '# Changed\n';
const CONFIGURATION = 'content:\n  dir: .\n';
const TEMPLATE = '# Template\n';
const CONTRIBUTOR = {
  id: 'agent-settle-fence-test',
  name: 'Settle fence contributor',
  email: 'contributor@example.test',
};

type Producer = 'service' | 'contributor' | 'checkpoint';
type SettleOutcome = { status: 'resolved' } | { status: 'rejected'; error: unknown };

function diskFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git') return [];
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? diskFiles(root, path) : [path];
  });
}

async function createFixture(context: TestContext, holdConsumer: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shadow-settle-fence-')));
  const entered = { value: false };
  const release = Promise.withResolvers<void>();
  let shadow: ShadowHandle | undefined;
  let watcher: WatcherHandle | undefined;
  let pending: Promise<SettleOutcome> | undefined;
  let settleState = 'not-started';
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
  mkdirSync(join(root, '.ok/templates'), { recursive: true });
  mkdirSync(join(root, '.ok/local'), { recursive: true });
  writeFileSync(join(root, 'doc.md'), INITIAL_DOCUMENT);
  writeFileSync(join(root, '.ok/config.yml'), CONFIGURATION);
  writeFileSync(join(root, '.ok/templates/note.md'), TEMPLATE);
  writeFileSync(join(root, '.ok/local/fixture-state.json'), '{}\n');
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
    root,
    async (event) => {
      if (
        event.kind === 'update' &&
        event.docName === 'doc' &&
        event.content === CHANGED_DOCUMENT
      ) {
        entered.value = true;
        if (holdConsumer) await release.promise;
      }
    },
    createContentFilter({ projectDir: root, contentDir: root }),
    { forceBackend: 'parcel' },
  );
  watcher = subscription;
  expect(subscription.getFileIndex().has('doc')).toBe(true);
  return {
    root,
    shadow: handle,
    entered,
    releaseConsumer: () => release.resolve(),
    beginSettle() {
      settleState = 'pending';
      pending = subscription.settle().then(
        (): SettleOutcome => {
          settleState = 'resolved';
          return { status: 'resolved' };
        },
        (error: unknown): SettleOutcome => {
          settleState = 'rejected';
          return { status: 'rejected', error };
        },
      );
      return pending;
    },
    settleState: () => settleState,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function capture(fixture: Fixture, producer: Producer): Promise<string[]> {
  const git = shadowGit(fixture.shadow);
  if (producer === 'checkpoint') {
    const result = await saveVersion(fixture.shadow, '.', [], 'main', 'Settle fence capture');
    const commit = (await git.raw('rev-parse', result.checkpointRef)).trim();
    expect((await git.raw('cat-file', '-t', commit)).trim()).toBe('commit');
    return [commit, result.checkpointRef];
  }
  const writer = producer === 'service' ? SERVICE_WRITER : CONTRIBUTOR;
  let tree: string | undefined;
  let commit: string;
  if (producer === 'service') {
    commit = await commitWip(fixture.shadow, writer, '.', 'Settle fence capture');
  } else {
    tree = await buildWipTree(fixture.shadow, '.');
    expect((await git.raw('cat-file', '-t', tree)).trim()).toBe('tree');
    commit = await commitWipFromTree(fixture.shadow, writer, tree, 'Settle fence capture');
    expect((await git.raw('rev-parse', `${commit}^{tree}`)).trim()).toBe(tree);
  }
  const ref = `refs/wip/main/${writer.id}`;
  expect((await git.raw('rev-parse', ref)).trim()).toBe(commit);
  expect((await git.raw('cat-file', '-t', commit)).trim()).toBe('commit');
  return tree ? [tree, commit, ref] : [commit, ref];
}

async function inspectCapture(fixture: Fixture, objects: readonly string[], document: string) {
  const git = shadowGit(fixture.shadow);
  const snapshots: { object: string; paths: string[] }[] = [];
  for (const object of objects) {
    const paths = (await git.raw('ls-tree', '-r', '-z', '--name-only', object))
      .split('\0')
      .filter(Boolean);
    for (const [path, content] of [
      ['doc.md', document],
      ['.ok/config.yml', CONFIGURATION],
      ['.ok/templates/note.md', TEMPLATE],
    ]) {
      expect(paths).toContain(path);
      expect(await git.raw('show', `${object}:${path}`)).toBe(content);
    }
    expect(paths).not.toContain('.ok/local/fixture-state.json');
    snapshots.push({ object, paths });
  }
  return snapshots;
}

async function assertPendingFenceOmitted(context: TestContext, producer: Producer) {
  const fixture = await createFixture(context, true);
  await inspectCapture(fixture, await capture(fixture, producer), INITIAL_DOCUMENT);
  writeFileSync(join(fixture.root, 'doc.md'), CHANGED_DOCUMENT);
  await expect.poll(() => fixture.entered.value, { timeout: 10_000 }).toBe(true);
  const before = new Set(diskFiles(fixture.root));
  const settled = fixture.beginSettle();
  const minted = () => diskFiles(fixture.root).filter((path) => !before.has(path));
  await expect.poll(minted, { timeout: 10_000 }).toHaveLength(1);
  const fences = minted();
  for (const fence of fences) expect(readFileSync(join(fixture.root, fence)).length).toBe(0);
  expect(fixture.settleState()).toBe('pending');
  const objects = await capture(fixture, producer);
  const whilePending = await inspectCapture(fixture, objects, CHANGED_DOCUMENT);
  expect(fixture.settleState()).toBe('pending');
  for (const fence of fences) expect(existsSync(join(fixture.root, fence))).toBe(true);
  fixture.releaseConsumer();
  expect(await settled).toEqual({ status: 'resolved' });
  for (const fence of fences) expect(existsSync(join(fixture.root, fence))).toBe(false);
  const afterCleanup = await inspectCapture(fixture, objects, CHANGED_DOCUMENT);
  const admitted = (snapshots: typeof whilePending) =>
    snapshots.flatMap(({ object, paths }) => {
      const capturedFences = paths.filter((path) => fences.includes(path));
      return capturedFences.length ? [{ object, fences: capturedFences }] : [];
    });
  expect({ whilePending: admitted(whilePending), afterCleanup: admitted(afterCleanup) }).toEqual({
    whilePending: [],
    afterCleanup: [],
  });
}

test('service WIP snapshots omit a pending settle fence', async (context) => {
  await assertPendingFenceOmitted(context, 'service');
});

test('contributor WIP snapshots omit a pending settle fence', async (context) => {
  await assertPendingFenceOmitted(context, 'contributor');
});

test('checkpoints omit a pending settle fence', async (context) => {
  await assertPendingFenceOmitted(context, 'checkpoint');
});

async function assertNoPendingContentPreserved(context: TestContext, producer: Producer) {
  const fixture = await createFixture(context, false);
  await inspectCapture(fixture, await capture(fixture, producer), INITIAL_DOCUMENT);
  const before = diskFiles(fixture.root).sort();
  writeFileSync(join(fixture.root, 'doc.md'), CHANGED_DOCUMENT);
  await expect.poll(() => fixture.entered.value, { timeout: 10_000 }).toBe(true);
  const snapshots = await inspectCapture(
    fixture,
    await capture(fixture, producer),
    CHANGED_DOCUMENT,
  );
  for (const { paths } of snapshots) {
    expect(paths.sort()).toEqual(['.ok/config.yml', '.ok/templates/note.md', 'doc.md']);
  }
  expect(diskFiles(fixture.root).sort()).toEqual(before);
  expect(fixture.settleState()).toBe('not-started');
}

test('service WIP snapshots preserve content when no settle is pending', async (context) => {
  await assertNoPendingContentPreserved(context, 'service');
});

test('contributor WIP snapshots preserve content when no settle is pending', async (context) => {
  await assertNoPendingContentPreserved(context, 'contributor');
});

test('checkpoints preserve content when no settle is pending', async (context) => {
  await assertNoPendingContentPreserved(context, 'checkpoint');
});
