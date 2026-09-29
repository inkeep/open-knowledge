import fs, {
  type FSWatcher,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { type DiskEvent, lastKnownHash, startWatcher, writeTracker } from './file-watcher.ts';
import { waitWithinTestBudget } from './wait-within-test-budget.test-helper.ts';

const DELIVERY_LIVENESS_BOUND_MS = 6_000;
const DELIVERY_POLL_MS = 40;
const CONFLICTED = '# Daily\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';

interface ModelledDirectoryWatch {
  readonly path: string;
  live: boolean;
  closed: boolean;
  sinceNow: string | null;
}

interface MacosDirectoryWatchModel {
  heldDirectories(): string[];
  directoriesNotYetLive(): string[];
  restore(): void;
}

function directoryFingerprint(dir: string): string | null {
  if (statSync(dir, { throwIfNoEntry: false }) === undefined) return null;
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const entry = lstatSync(join(dir, name), { bigint: true, throwIfNoEntry: false });
      if (entry === undefined) return name;
      return [name, entry.ino, entry.mtimeNs, entry.ctimeNs, entry.size].join('\0');
    })
    .join('/');
}

function installMacosDirectoryWatchModel(): MacosDirectoryWatchModel {
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'watch');
  if (descriptor === undefined) throw new Error('fs.watch descriptor is unavailable');
  const realWatch = fs.watch;
  const directoryWatches: ModelledDirectoryWatch[] = [];

  const completePendingReschedule = (): void => {
    for (const watch of directoryWatches) {
      if (watch.closed || watch.live) continue;
      watch.live = true;
      watch.sinceNow = directoryFingerprint(watch.path);
    }
  };

  const modelledWatch = (...args: unknown[]): FSWatcher => {
    const watcher: FSWatcher = Reflect.apply(realWatch, fs, args);
    const path = resolve(String(args[0]));
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) return watcher;

    const watch: ModelledDirectoryWatch = { path, live: false, closed: false, sinceNow: null };
    directoryWatches.push(watch);
    const emit = watcher.emit.bind(watcher);
    const close = watcher.close.bind(watcher);
    Object.defineProperty(watcher, 'emit', {
      configurable: true,
      writable: true,
      value: (event: string | symbol, ...rest: unknown[]): boolean => {
        if (event !== 'change') return emit(event, ...rest);
        if (!watch.live || directoryFingerprint(path) === watch.sinceNow) return false;
        return emit(event, ...rest);
      },
    });
    Object.defineProperty(watcher, 'close', {
      configurable: true,
      writable: true,
      value: (): void => {
        const firstClose = !watch.closed;
        watch.closed = true;
        close();
        if (firstClose) completePendingReschedule();
      },
    });
    return watcher;
  };

  Object.defineProperty(fs, 'watch', { ...descriptor, value: modelledWatch });
  syncBuiltinESMExports();

  return {
    heldDirectories: () =>
      directoryWatches.filter((watch) => !watch.closed).map((watch) => watch.path),
    directoriesNotYetLive: () =>
      directoryWatches.filter((watch) => !watch.closed && !watch.live).map((watch) => watch.path),
    restore: () => {
      Object.defineProperty(fs, 'watch', descriptor);
      syncBuiltinESMExports();
    },
  };
}

const STANDUP_TEMPLATE =
  '---\ntitle: Standup\ndescription: a standup template\n---\n\n# {{date}}\n';

type BeforeCreation = 'nothing' | 'close-a-directory-watch';

interface ExposedCreation {
  readonly creation: string;
  readonly expected: string;
  readonly fixture?: (contentDir: string) => void;
  readonly create: (contentDir: string) => void;
  readonly matches: (event: DiskEvent) => boolean;
}

const EXPOSED_CREATIONS: readonly ExposedCreation[] = [
  {
    creation: 'a conflicted file created in an already-watched directory',
    expected: "a conflict DiskEvent for '.ok/templates/daily'",
    fixture: (contentDir) =>
      mkdirSync(resolve(contentDir, '.ok', 'templates'), { recursive: true }),
    create: (contentDir) =>
      writeFileSync(resolve(contentDir, '.ok', 'templates', 'daily.md'), CONFLICTED),
    matches: (e) => e.kind === 'conflict' && e.docName === '.ok/templates/daily',
  },
  {
    creation: 'a directory created in the content root',
    expected: "a folder-create DiskEvent for 'fresh'",
    fixture: (contentDir) => {
      mkdirSync(resolve(contentDir, 'sub'), { recursive: true });
      writeFileSync(resolve(contentDir, 'root.md'), '# Root\n');
      writeFileSync(resolve(contentDir, 'sub', 'note.md'), '# Note\n\n[Root](./root)\n');
    },
    create: (contentDir) => mkdirSync(resolve(contentDir, 'fresh')),
    matches: (e) => e.kind === 'folder-create' && e.relativePath === 'fresh',
  },
  {
    creation: 'a template created under a brand-new nested folder',
    expected: "a create or update DiskEvent for 'notes/.ok/templates/standup'",
    create: (contentDir) => {
      const target = resolve(contentDir, 'notes', '.ok', 'templates', 'standup.md');
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, STANDUP_TEMPLATE);
    },
    matches: (e) =>
      (e.kind === 'create' || e.kind === 'update') && e.docName === 'notes/.ok/templates/standup',
  },
];

async function expectDiskEventForCreationAfterStart(
  site: ExposedCreation,
  dirs: { projectDir: string; contentDir: string },
  beforeCreation: BeforeCreation,
): Promise<void> {
  const { projectDir, contentDir } = dirs;
  site.fixture?.(contentDir);
  const contentRoot = realpathSync(contentDir);
  const filter = createContentFilter({ projectDir, contentDir });
  const events: DiskEvent[] = [];
  const model = installMacosDirectoryWatchModel();
  try {
    const handle = await startWatcher(contentDir, async (e) => void events.push(e), filter, {
      forceBackend: 'chokidar',
      platform: 'darwin',
    });
    try {
      if (!model.heldDirectories().includes(contentRoot)) {
        throw new Error(
          `chokidar holds no node:fs watch on the content root ${contentRoot} when startWatcher resolves, so this test is not exercising the directory-watch readiness it models`,
        );
      }
      if (beforeCreation === 'close-a-directory-watch') fs.watch(contentRoot).close();
      const notYetLive = model
        .directoriesNotYetLive()
        .map((dir) => relative(contentRoot, dir) || '.');
      site.create(contentDir);
      await waitWithinTestBudget(
        `${site.expected} (directory watches not yet live when it was created: ${
          notYetLive.length === 0 ? 'none' : notYetLive.join(', ')
        })`,
        () => events.some(site.matches),
        { timeoutMs: DELIVERY_LIVENESS_BOUND_MS, pollMs: DELIVERY_POLL_MS },
      );
    } finally {
      await handle.unsubscribe();
    }
  } finally {
    model.restore();
  }
}

describe('chokidar backend: creations made right after startWatcher resolves, with macOS directory watches registered asynchronously', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chokidar-readiness-'));
    contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    lastKnownHash.clear();
    writeTracker.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  for (const site of EXPOSED_CREATIONS) {
    test(`${site.creation} right after startWatcher resolves dispatches ${site.expected}`, async () => {
      await expectDiskEventForCreationAfterStart(
        site,
        { projectDir: tmpDir, contentDir },
        'nothing',
      );
    });

    test(`${site.creation} after a directory watch close has completed the pending FSEvents reschedule dispatches ${site.expected}`, async () => {
      await expectDiskEventForCreationAfterStart(
        site,
        { projectDir: tmpDir, contentDir },
        'close-a-directory-watch',
      );
    });
  }
});
