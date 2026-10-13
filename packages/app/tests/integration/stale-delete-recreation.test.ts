import { randomUUID } from 'node:crypto';
import {
  type EncodingOption,
  existsSync,
  mkdtempSync,
  type PathLike,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PagesSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterEach, expect, test, vi } from 'vitest';
import { hasAdmittedMarkdownFile } from '../../../server/src/file-watcher.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  ORIGINAL,
  RECREATED,
  startDeletionScenario,
} from './stale-delete-recreation.test-helper.ts';
import { createTestServer } from './test-harness.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: actual.realpathSync.native,
    }),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const cleanups: Array<() => Promise<void>> = [];
const registerCleanup = (cleanup: () => Promise<void>) => {
  cleanups.push(cleanup);
};

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

function foldNameCaseLikeApfs(dir: string) {
  const storedVariant = (path: unknown) => {
    if (typeof path !== 'string' || dirname(path) !== dir) return undefined;
    const name = basename(path);
    const entries = actualFs.readdirSync(dir);
    if (entries.includes(name)) return undefined;
    return entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
  };
  vi.mocked(statSync).mockImplementation(((path, options) => {
    const stored = storedVariant(path);
    return actualFs.statSync(stored === undefined ? path : join(dir, stored), options);
  }) as typeof statSync);
  vi.mocked(realpathSync).mockImplementation(((path: PathLike, options?: EncodingOption) =>
    storedVariant(path) === undefined
      ? actualFs.realpathSync(path, options)
      : join(actualFs.realpathSync(dir), basename(String(path)))) as typeof realpathSync);
  registerCleanup(async () => {
    vi.mocked(statSync).mockImplementation(actualFs.statSync);
    vi.mocked(realpathSync).mockImplementation(actualFs.realpathSync);
  });
}

test.each([
  ['before raw classification', 'raw', true, 'api'],
  ['before handler entry', 'classified', true, 'api'],
  ['while indexing an open page', 'index', true, 'external'],
  ['while indexing an unloaded page', 'index', false, 'external'],
] as const)(
  'preserves a recreated page after a delete held %s',
  async (_timing, hold, initiallyOpen, deletion) => {
    const scenario = await startDeletionScenario(hold, registerCleanup);
    const oldClient = initiallyOpen ? await scenario.open() : undefined;
    if (oldClient) expect(oldClient.ytext.toString()).toBe(ORIGINAL);
    expect(scenario.server.instance.hocuspocus.documents.has(scenario.docName)).toBe(initiallyOpen);
    const oldThread = await scenario.comment('Original page');
    if (deletion === 'api') await scenario.deleteThroughApi();
    else scenario.deleteExternally();
    await scenario.waitUntilHeld();
    if (oldClient && deletion === 'api') await scenario.close(oldClient);

    const fresh = await scenario.create();
    const newThread = await scenario.comment('Recreated page');
    expect(newThread.threadId).not.toBe(oldThread.threadId);
    const before = await scenario.snapshot(fresh);
    expect(before).toMatchObject({
      disk: RECREATED,
      residentPresent: true,
      residentContent: RECREATED,
      lifecycleStatus: null,
      clientContent: RECREATED,
      clientLifecycleStatus: null,
      clientClosed: false,
      listed: true,
      removedCount: 0,
      forwardLinks: ['target'],
    });
    expect(before.threads).toContain(newThread.threadId);

    await scenario.finishDeletion();
    expect(await scenario.snapshot(fresh)).toEqual({
      disk: RECREATED,
      residentPresent: true,
      residentContent: RECREATED,
      lifecycleStatus: null,
      clientContent: RECREATED,
      clientLifecycleStatus: null,
      clientClosed: false,
      listed: true,
      removedCount: 0,
      threads: [newThread.threadId],
      forwardLinks: ['target'],
    });
  },
);

test('a delivered deletion removes the existing page and its comments', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  const original = await scenario.open();
  expect(original.ytext.toString()).toBe(ORIGINAL);
  const thread = await scenario.comment('Original page');
  expect((await scenario.snapshot(original)).threads).toEqual([thread.threadId]);

  await scenario.deleteThroughApi();
  await scenario.finishDeletion();
  const deleted = await scenario.snapshot();
  expect(deleted).toMatchObject({
    disk: null,
    residentPresent: false,
    residentContent: null,
    listed: false,
    removedCount: 1,
    threads: [],
    forwardLinks: [],
  });
});

test('a recreation after deletion completes admits and saves new content', async () => {
  const scenario = await startDeletionScenario('none', registerCleanup);
  const original = await scenario.open();
  const oldThread = await scenario.comment('Original page');
  expect((await scenario.snapshot(original)).threads).toEqual([oldThread.threadId]);
  await scenario.deleteThroughApi();
  await scenario.finishDeletion();
  await scenario.close(original);
  expect((await scenario.snapshot()).threads).toEqual([]);
  scenario.releaseFollowers();

  const recreated = await scenario.create();
  const thread = await scenario.comment('Recreated page');
  expect(await scenario.snapshot(recreated)).toEqual({
    disk: RECREATED,
    residentPresent: true,
    residentContent: RECREATED,
    lifecycleStatus: null,
    clientContent: RECREATED,
    clientLifecycleStatus: null,
    clientClosed: false,
    listed: true,
    removedCount: 0,
    threads: [thread.threadId],
    forwardLinks: ['target'],
  });
  expect((await scenario.readDocument()).content).toBe(RECREATED);
});

test('an external case-only rename moves the page to its new name', async ({ skip }) => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-case-rename-')));
  registerCleanup(async () => rmSync(contentDir, { recursive: true, force: true }));
  const probe = join(contentDir, 'Probe.md');
  writeFileSync(probe, '');
  const caseInsensitive = existsSync(join(contentDir, 'probe.md'));
  unlinkSync(probe);
  if (!caseInsensitive) skip();

  const id = randomUUID();
  const oldName = `Case-${id}`;
  const newName = `case-${id}`;
  writeFileSync(join(contentDir, `${oldName}.md`), ORIGINAL);
  const server = await createTestServer({ contentDir });
  registerCleanup(() => server.cleanup());
  const listed = async () => {
    const response = await fetch(`${server.baseUrl}/api/pages`);
    const pages = PagesSuccessSchema.parse(await response.json());
    const names = pages.pages.map((page) => page.docName);
    return { old: names.includes(oldName), renamed: names.includes(newName) };
  };
  await expect.poll(listed).toEqual({ old: true, renamed: false });

  renameSync(join(contentDir, `${oldName}.md`), join(contentDir, `${newName}.md`));

  await expect.poll(listed).toEqual({ old: false, renamed: true });
});

test('removal currentness treats only an admitted file at the exact name as bound', () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-admitted-')));
  registerCleanup(async () => rmSync(contentDir, { recursive: true, force: true }));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-admitted-outside-')));
  registerCleanup(async () => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(contentDir, 'page.md'), ORIGINAL);
  writeFileSync(join(contentDir, 'excluded.md'), ORIGINAL);
  writeFileSync(join(outside, 'elsewhere.md'), ORIGINAL);
  symlinkSync(join(outside, 'elsewhere.md'), join(contentDir, 'escaping.md'));
  symlinkSync(join(contentDir, 'looping.md'), join(contentDir, 'looping.md'));
  const filter = { isExcluded: (path: string) => path === 'excluded.md' };
  const admitted = (name: string) =>
    hasAdmittedMarkdownFile(name, join(contentDir, `${name}.md`), contentDir, filter);
  foldNameCaseLikeApfs(contentDir);

  expect({
    differentCaseIsFile: statSync(join(contentDir, 'PAGE.md')).isFile(),
    page: admitted('page'),
    absent: admitted('absent'),
    differentCase: admitted('PAGE'),
    excluded: admitted('excluded'),
    escaping: admitted('escaping'),
    looping: admitted('looping'),
  }).toEqual({
    differentCaseIsFile: true,
    page: true,
    absent: false,
    differentCase: false,
    excluded: false,
    escaping: false,
    looping: false,
  });
});
