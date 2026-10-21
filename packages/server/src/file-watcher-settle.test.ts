import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createContentFilter, isShareableOkArtifact } from './content-filter.ts';
import {
  type DiskEvent,
  getWatcherDecisionRingSnapshot,
  INTERIM_SETTLE_NO_PROGRESS_MS,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import {
  forgetNativeSubscriptions,
  nativeSubscriptionOn,
} from './parcel-watcher-double.test-helper.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('./parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

const DROP_NOTICE = 'Events were dropped by the kernel. File system must be re-scanned.';

let contentDir: string;
const handles: WatcherHandle[] = [];
const latches: Array<() => void> = [];

beforeEach(() => {
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-watcher-settle-')));
  mkdirSync(join(contentDir, '.ok'));
  writeFileSync(join(contentDir, 'left.md'), '# Left\n');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const release of latches.splice(0)) release();
  for (const handle of handles.splice(0)) await handle.unsubscribe();
  forgetNativeSubscriptions();
  rmSync(contentDir, { recursive: true, force: true });
});

async function watchContent(
  backend: 'parcel' | 'chokidar',
  onEvent: (event: DiskEvent) => Promise<void> | undefined = () => undefined,
): Promise<{ watcher: WatcherHandle; events: DiskEvent[] }> {
  const events: DiskEvent[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      events.push(event);
      await onEvent(event);
    },
    createContentFilter({ projectDir: contentDir, contentDir }),
    { forceBackend: backend, platform: 'linux' },
  );
  handles.push(watcher);
  return { watcher, events };
}

function fencesOnDisk(): string[] {
  return readdirSync(join(contentDir, '.ok')).filter((name) =>
    name.startsWith('watcher-settle-fence-'),
  );
}

function decisionsFor(name: string): Array<{ decision: string; kind: string }> {
  return getWatcherDecisionRingSnapshot()
    .filter((record) => record.path.endsWith(name))
    .map(({ decision, kind }) => ({ decision, kind }));
}

function indexOf(watcher: WatcherHandle): { files: string[]; folders: string[] } {
  return {
    files: [...watcher.getAllFilesIndex()].map(([name]) => name),
    folders: [...watcher.getFolderIndex().keys()],
  };
}

function settling(watcher: WatcherHandle): {
  readonly done: () => boolean;
  readonly promise: Promise<void>;
} {
  let done = false;
  const promise = watcher.settle().then(() => {
    done = true;
  });
  return { done: () => done, promise };
}

type SettleState = 'pending' | 'resolved' | { readonly rejected: string };

function observed(settle: Promise<void>): () => SettleState {
  let state: SettleState = 'pending';
  settle.then(
    () => {
      state = 'resolved';
    },
    (err: unknown) => {
      state = { rejected: err instanceof Error ? err.message : String(err) };
    },
  );
  return () => state;
}

test('settle resolves only after the watcher has finished handling a deletion that reached the disk before it', async () => {
  const left = join(contentDir, 'left.md');
  const handling = Promise.withResolvers<void>();
  latches.push(handling.resolve);
  const { watcher, events } = await watchContent('parcel', (event) =>
    event.kind === 'delete' ? handling.promise : undefined,
  );
  unlinkSync(left);

  const settle = settling(watcher);
  const [fence] = fencesOnDisk();
  expect(fence).toMatch(/^watcher-settle-fence-/);
  const delivered = nativeSubscriptionOn(contentDir).deliver([
    { type: 'delete', path: left },
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  await expect.poll(() => events).toEqual([{ kind: 'delete', path: left, docName: 'left' }]);
  await new Promise<void>((flushed) => setImmediate(flushed));

  expect(settle.done()).toBe(false);
  handling.resolve();
  await delivered;
  await settle.promise;
  expect(events).toEqual([{ kind: 'delete', path: left, docName: 'left' }]);
  expect(fencesOnDisk()).toEqual([]);
  expect([...watcher.getAllFilesIndex()].map(([name]) => name)).toEqual([]);
});

test('settle waits for its own fence, not for whichever batch arrives next', async () => {
  const left = join(contentDir, 'left.md');
  const { watcher, events } = await watchContent('parcel');
  unlinkSync(left);

  const settle = settling(watcher);
  const [fence] = fencesOnDisk();
  await nativeSubscriptionOn(contentDir).deliver([{ type: 'delete', path: left }]);

  expect(events).toEqual([{ kind: 'delete', path: left, docName: 'left' }]);
  expect(settle.done()).toBe(false);
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  await settle.promise;
  expect(settle.done()).toBe(true);
});

test('a dropped-events notice settles a fence the watcher never reported, once recovery has read the disk', async () => {
  const left = join(contentDir, 'left.md');
  const { watcher, events } = await watchContent('parcel');
  unlinkSync(left);

  const settle = settling(watcher);
  await nativeSubscriptionOn(contentDir).deliver([], new Error(DROP_NOTICE));
  await settle.promise;

  expect(events).toEqual([{ kind: 'delete', path: left, docName: 'left' }]);
  expect(fencesOnDisk()).toEqual([]);
});

test('settle rejects when the watcher stops before its fence arrives, and leaves no fence behind', async () => {
  const { watcher } = await watchContent('parcel');

  const settle = watcher.settle();
  expect(fencesOnDisk()).toHaveLength(1);
  handles.splice(handles.indexOf(watcher), 1);
  await watcher.unsubscribe();

  await expect(settle).rejects.toThrow('the file watcher stopped before it saw its settle fence');
  expect(fencesOnDisk()).toEqual([]);
});

test('a watcher error that ends the subscription fails a pending settle and later ones until it is subscribed again, and leaves no fence behind', async () => {
  const { watcher } = await watchContent('parcel');
  const pending = observed(watcher.settle());
  expect(fencesOnDisk()).toHaveLength(1);

  const failure = `inotify_add_watch on '${join(contentDir, 'guides')}' failed: No space left on device`;
  await nativeSubscriptionOn(contentDir).deliver([], new Error(failure));

  const refusal = `the file watcher is subscribing again after an error and cannot settle until it is back: ${failure}`;
  expect(pending()).toEqual({ rejected: refusal });
  expect(fencesOnDisk()).toEqual([]);
  const later = observed(watcher.settle());
  await new Promise<void>((flushed) => setImmediate(flushed));
  expect(later()).toEqual({ rejected: refusal });
  expect(fencesOnDisk()).toEqual([]);
});

const NO_PROGRESS = `the file watcher handled no batch for ${INTERIM_SETTLE_NO_PROGRESS_MS} ms before it saw its settle fence`;

function flushed(): Promise<void> {
  return new Promise<void>((done) => setImmediate(done));
}

test('a settle whose fence the watcher never reports ends after the no-progress window with that cause, and a later settle still works', async () => {
  const { watcher } = await watchContent('parcel');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const lost = observed(watcher.settle());
  expect(fencesOnDisk()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(INTERIM_SETTLE_NO_PROGRESS_MS - 1);
  await flushed();
  expect(lost()).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  await flushed();

  expect(lost()).toEqual({ rejected: NO_PROGRESS });
  expect(fencesOnDisk()).toEqual([]);
  const later = observed(watcher.settle());
  const [fence] = fencesOnDisk();
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  expect(later()).toBe('resolved');
  expect(fencesOnDisk()).toEqual([]);
});

test('a watcher that keeps handling batches is not ended by the no-progress window, and its settle resolves once the fence arrives', async () => {
  const { watcher, events } = await watchContent('parcel');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const settle = observed(watcher.settle());
  const [fence] = fencesOnDisk();
  for (const name of ['first', 'second', 'third']) {
    await vi.advanceTimersByTimeAsync(INTERIM_SETTLE_NO_PROGRESS_MS - 1);
    const page = join(contentDir, `${name}.md`);
    writeFileSync(page, `# ${name}\n`);
    await nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: page }]);
  }
  await vi.advanceTimersByTimeAsync(INTERIM_SETTLE_NO_PROGRESS_MS - 1);
  await flushed();

  expect(settle()).toBe('pending');
  expect(events).toEqual(
    ['first', 'second', 'third'].map((name) => ({
      kind: 'create',
      path: join(contentDir, `${name}.md`),
      docName: name,
      content: `# ${name}\n`,
    })),
  );
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  expect(settle()).toBe('resolved');
});

test('a batch whose handling never finishes ends a pending settle at the no-progress window, though new batches keep arriving behind it', async () => {
  const left = join(contentDir, 'left.md');
  const reached = Promise.withResolvers<void>();
  const handling = Promise.withResolvers<void>();
  latches.push(handling.resolve);
  const { watcher } = await watchContent('parcel', (event) => {
    if (event.kind !== 'delete') return undefined;
    reached.resolve();
    return handling.promise;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  unlinkSync(left);

  const settle = observed(watcher.settle());
  const [fence] = fencesOnDisk();
  void nativeSubscriptionOn(contentDir).deliver([
    { type: 'delete', path: left },
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  await reached.promise;
  for (const name of ['first', 'second']) {
    await vi.advanceTimersByTimeAsync(INTERIM_SETTLE_NO_PROGRESS_MS / 2 - 1);
    const page = join(contentDir, `${name}.md`);
    writeFileSync(page, `# ${name}\n`);
    void nativeSubscriptionOn(contentDir).deliver([{ type: 'create', path: page }]);
  }
  await flushed();
  expect(settle()).toBe('pending');
  await vi.advanceTimersByTimeAsync(2);
  await flushed();

  expect(settle()).toEqual({ rejected: NO_PROGRESS });
  expect(fencesOnDisk()).toEqual([]);
});

test('a settle whose fence cannot be written fails with that error and leaves nothing behind', async () => {
  rmSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok'), 'not a directory\n');
  const { watcher } = await watchContent('parcel');

  await expect(watcher.settle()).rejects.toMatchObject({ code: 'EEXIST' });
  expect(readFileSync(join(contentDir, '.ok'), 'utf8')).toBe('not a directory\n');
});

test('with no settle pending, a batch and a dropped-events recovery are handled as before settling existed, and nothing is written under .ok', async () => {
  const fresh = join(contentDir, 'fresh.md');
  const left = join(contentDir, 'left.md');
  const guides = join(contentDir, 'guides');
  const start = join(guides, 'start.md');
  const notes = join(contentDir, 'notes.txt');
  const strayName = 'watcher-settle-fence-left-by-an-earlier-run';
  const stray = join(contentDir, '.ok', strayName);
  const { watcher, events } = await watchContent('parcel');
  writeFileSync(fresh, '# Fresh\n');
  writeFileSync(left, '# Left again\n');
  mkdirSync(guides);
  writeFileSync(start, '# Start\n');
  writeFileSync(notes, 'notes\n');
  writeFileSync(stray, '');

  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'create', path: fresh },
    { type: 'update', path: left },
    { type: 'create', path: guides },
    { type: 'create', path: start },
    { type: 'create', path: notes },
    { type: 'create', path: stray },
  ]);
  unlinkSync(notes);
  await nativeSubscriptionOn(contentDir).deliver([], new Error(DROP_NOTICE));

  expect(events).toEqual([
    { kind: 'create', path: fresh, docName: 'fresh', content: '# Fresh\n' },
    { kind: 'create', path: start, docName: 'guides/start', content: '# Start\n' },
    {
      kind: 'update',
      path: left,
      docName: 'left',
      content: '# Left again\n',
      previousIndexedFields: { title: 'Left' },
    },
    { kind: 'folder-create', path: guides, relativePath: 'guides' },
    { kind: 'asset-create', path: notes, relativePath: 'notes.txt' },
    {
      kind: 'file-create',
      path: notes,
      relativePath: 'notes.txt',
      size: 6,
      modifiedTs: expect.any(Number),
      inode: expect.any(String),
    },
    { kind: 'asset-delete', path: notes, relativePath: 'notes.txt' },
    { kind: 'file-delete', path: notes, relativePath: 'notes.txt' },
  ]);
  expect(decisionsFor(strayName)).toEqual([{ decision: 'drop-filter-excluded', kind: 'create' }]);
  expect(indexOf(watcher)).toEqual({
    files: ['left', 'fresh', 'guides/start'],
    folders: ['.ok', 'guides'],
  });
  expect(readdirSync(join(contentDir, '.ok'))).toEqual([strayName]);
});

test('a settle fence reaches no consumer of .ok files, while a template edit in the same batch is still dispatched', async () => {
  const template = join(contentDir, '.ok', 'templates', 'note.md');
  mkdirSync(join(contentDir, '.ok', 'templates'));
  mkdirSync(join(contentDir, '.ok', 'schemas'));
  mkdirSync(join(contentDir, 'docs', '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(contentDir, '.ok', 'schemas', 'frontmatter.json'), '{}\n');
  writeFileSync(join(contentDir, 'docs', '.ok', 'frontmatter.yml'), 'type: doc\n');
  writeFileSync(template, '# Note template\n');
  const { watcher, events } = await watchContent('parcel');
  const indexBefore = indexOf(watcher);

  const settle = observed(watcher.settle());
  const [fence] = fencesOnDisk();
  writeFileSync(template, '# Note template, revised\n');
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'update', path: template },
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  expect(settle()).toBe('resolved');
  expect(fencesOnDisk()).toEqual([]);
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'delete', path: join(contentDir, '.ok', fence) },
  ]);

  expect(events).toEqual([
    {
      kind: 'update',
      path: template,
      docName: '.ok/templates/note',
      content: '# Note template, revised\n',
      previousIndexedFields: { title: 'Note template' },
    },
  ]);
  expect(decisionsFor(fence)).toEqual([
    { decision: 'drop-filter-excluded', kind: 'create' },
    { decision: 'drop-filter-excluded', kind: 'delete' },
  ]);
  expect(indexOf(watcher)).toEqual(indexBefore);
  expect(readdirSync(join(contentDir, '.ok')).sort()).toEqual([
    'config.yml',
    'schemas',
    'templates',
  ]);
  expect(isShareableOkArtifact(`.ok/${fence}`)).toBe(false);
  expect(isShareableOkArtifact('.ok/config.yml')).toBe(true);
});

test('a chokidar watcher refuses to settle, since it cannot order its batches', async () => {
  const { watcher } = await watchContent('chokidar');

  await expect(watcher.settle()).rejects.toThrow(
    'settling disk events needs the parcel watcher backend, and this watcher runs on chokidar',
  );
  expect(fencesOnDisk()).toEqual([]);
});
