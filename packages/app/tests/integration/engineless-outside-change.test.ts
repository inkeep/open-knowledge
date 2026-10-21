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
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { getMetrics } from '../../../server/src/metrics';
import { saveInMemoryCheckpoint } from '../../../server/src/shadow-repo';
import { createManualClock, type ManualClock } from '../../../server/src/watcher-clock.test-helper';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;
let client: TestClient | undefined;
const homes: string[] = [];

afterEach(async () => {
  await client?.cleanup();
  client = undefined;
  await server?.cleanup();
  server = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function ownHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-engineless-home-')));
  homes.push(home);
  return home;
}

function backupsIn(home: string): string[] {
  const root = join(home, '.ok', 'edit-backups', 'discarded');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'));
}

function blockBackups(home: string): void {
  mkdirSync(join(home, '.ok'), { recursive: true });
  writeFileSync(join(home, '.ok', 'edit-backups'), 'not a folder');
}

function unblockBackups(home: string): void {
  rmSync(join(home, '.ok', 'edit-backups'), { force: true });
}

interface Rig {
  s: TestServer;
  c: TestClient;
  double: ReturnType<typeof createWatcherDouble>;
  clock: ManualClock;
  path: string;
}

interface HistoryVersion {
  kind: string | undefined;
  side: unknown;
  fileType: unknown;
  content: string;
}

const CASES = [
  {
    file: 'diagrams/flow.mmd',
    fileType: 'mermaid',
    saved: 'graph TD\n  A-->B\n',
    edit: { find: 'A-->B', replace: 'A-->C' },
    outside: 'graph TD\n  A-->D\n',
  },
  {
    file: 'boards/plan.excalidraw',
    fileType: 'excalidraw',
    saved: '{"type":"excalidraw","version":2,"elements":[{"id":"a","type":"rectangle","x":0}]}\n',
    edit: { find: '"x":0', replace: '"x":10' },
    outside:
      '{"type":"excalidraw","version":2,"elements":[{"id":"a","type":"rectangle","x":20}]}\n',
  },
  {
    file: 'notes/todo.txt',
    fileType: 'text',
    saved: 'first line\nsecond line\n',
    edit: { find: 'second line', replace: 'second line, edited here' },
    outside: 'first line\nsecond line, edited outside\n',
  },
] as const;

function liveText(s: TestServer, docName: string): string | null {
  return s.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? null;
}

async function openSaved(
  file: string,
  saved: string,
  options: {
    freshnessIntervalMs?: number | null;
    historyFails?: () => boolean;
    stalenessSweepIntervalMs?: number;
    keepContentDir?: boolean;
    home?: string;
  } = {},
): Promise<Rig> {
  const double = createWatcherDouble();
  const clock = createManualClock(Date.now());
  const historyFails = options.historyFails;
  const s = await createTestServer({
    gitEnabled: true,
    watcherBackend: double.backend,
    watcherClock: clock,
    freshnessIntervalMs: options.freshnessIntervalMs ?? null,
    debounce: 300_000,
    maxDebounce: 600_000,
    stalenessSweepIntervalMs: options.stalenessSweepIntervalMs,
    keepContentDir: options.keepContentDir,
    configHomedirOverride: options.home,
    mergeHistoryWriter:
      historyFails === undefined
        ? undefined
        : (shadow, contentRoot, params) =>
            historyFails()
              ? Promise.reject(new Error('history is unavailable'))
              : saveInMemoryCheckpoint(shadow, contentRoot, params),
  });
  server = s;
  const path = join(s.contentDir, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, saved, 'utf-8');
  const c = await createTestClient(s.port, file, {
    skipInvariantWatcher: true,
    resetOnCleanup: false,
  });
  client = c;
  await pollUntil(() => c.ytext.toString() === saved, 10_000, 25, `${file} to load`);
  return { s, c, double, clock, path };
}

function editInClient(c: TestClient, find: string, replace: string): void {
  c.doc.transact(() => {
    const at = c.ytext.toString().indexOf(find);
    c.ytext.delete(at, find.length);
    c.ytext.insert(at, replace);
  });
}

async function flushPendingStore(s: TestServer, docName: string): Promise<void> {
  const id = `onStoreDocument-${docName}`;
  if (s.instance.hocuspocus.debouncer.isDebounced(id)) {
    await s.instance.hocuspocus.debouncer.executeNow(id);
  }
}

async function historyVersions(s: TestServer, docName: string): Promise<HistoryVersion[]> {
  const res = await fetch(
    `${s.baseUrl}/api/history?docName=${encodeURIComponent(docName)}&type=checkpoint&limit=100`,
  );
  const body = (await res.json()) as {
    entries?: Array<{
      sha: string;
      checkpoint?: { kind?: string; metadata?: { side?: unknown; fileType?: unknown } };
    }>;
  };
  const versions: HistoryVersion[] = [];
  for (const row of body.entries ?? []) {
    const content = await fetch(
      `${s.baseUrl}/api/history/${row.sha}?docName=${encodeURIComponent(docName)}`,
    ).then((r) => r.json() as Promise<{ content: string }>);
    versions.push({
      kind: row.checkpoint?.kind,
      side: row.checkpoint?.metadata?.side,
      fileType: row.checkpoint?.metadata?.fileType,
      content: content.content,
    });
  }
  return versions;
}

async function noticesFor(s: TestServer, docName: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${s.baseUrl}/api/doc-notices`);
  const body = (await res.json()) as { notices?: Array<Record<string, unknown>> };
  return (body.notices ?? []).filter((notice) => notice.docName === docName);
}

describe('an outside write to a file with no merge engine, under unsaved edits', () => {
  for (const kase of CASES) {
    test(`${kase.file}: the save keeps the edits live and on disk and moves the outside version to history`, async () => {
      const { s, c, path } = await openSaved(kase.file, kase.saved);
      const undo = new Y.UndoManager(c.ytext);
      editInClient(c, kase.edit.find, kase.edit.replace);
      const here = kase.saved.replace(kase.edit.find, kase.edit.replace);
      await pollUntil(
        () => liveText(s, kase.file) === here,
        10_000,
        25,
        'the edit to reach the server',
      );
      writeFileSync(path, kase.outside, 'utf-8');

      await flushPendingStore(s, kase.file);

      await pollUntil(
        () => readFileSync(path, 'utf-8') === here,
        10_000,
        25,
        'the save to write the edits',
      );
      expect(liveText(s, kase.file)).toBe(here);
      expect(c.ytext.toString()).toBe(here);
      expect(undo.undoStack).toHaveLength(1);
      expect(await historyVersions(s, kase.file)).toEqual([
        {
          kind: 'external-change-no-engine',
          side: 'theirs',
          fileType: kase.fileType,
          content: kase.outside,
        },
      ]);
      const notices = await noticesFor(s, kase.file);
      expect(notices).toEqual([
        expect.objectContaining({
          kind: 'moved-to-history',
          side: 'theirs',
          reason: 'no-merge-engine',
          file: kase.file,
        }),
      ]);
      undo.undo();
      await pollUntil(() => liveText(s, kase.file) === kase.saved, 10_000, 25, 'the undo to land');
    });
  }
});

describe('an outside version that history cannot take', () => {
  const kase = CASES[0];
  const here = kase.saved.replace(kase.edit.find, kase.edit.replace);

  async function saveOverOutsideWrite(rig: Rig, outside: string | Buffer = kase.outside) {
    editInClient(rig.c, kase.edit.find, kase.edit.replace);
    await pollUntil(() => liveText(rig.s, kase.file) === here, 10_000, 25, 'the edit');
    writeFileSync(rig.path, outside);
    await flushPendingStore(rig.s, kase.file);
  }

  test('goes to the backup folder, the edits are written, and the notice names the backup', async () => {
    const home = ownHome();
    const rig = await openSaved(kase.file, kase.saved, { historyFails: () => true, home });

    await saveOverOutsideWrite(rig);

    await pollUntil(
      () => readFileSync(rig.path, 'utf-8') === here,
      10_000,
      25,
      'the save to write the edits',
    );
    expect(backupsIn(home)).toEqual([kase.outside]);
    expect(await historyVersions(rig.s, kase.file)).toEqual([]);
    expect(await noticesFor(rig.s, kase.file)).toEqual([
      expect.objectContaining({
        kind: 'moved-to-backup',
        side: 'theirs',
        reason: 'no-merge-engine',
        backup: expect.stringMatching(
          /^~\/\.ok\/edit-backups\/discarded\/projects\/[0-9a-f]{8}\/diagrams__flow\.mmd\/.+\.mmd$/,
        ),
      }),
    ]);
  });

  test('with no backup folder either, the save is held with a notice and the edits are in the rescue buffer at shutdown', async () => {
    const home = ownHome();
    blockBackups(home);
    const rig = await openSaved(kase.file, kase.saved, {
      historyFails: () => true,
      keepContentDir: true,
      home,
    });
    const contentDir = rig.s.contentDir;
    const rescued = join(resolveShadowDir(contentDir), 'rescue', kase.file);
    try {
      await saveOverOutsideWrite(rig);
      await pollUntil(
        async () => (await noticesFor(rig.s, kase.file)).length > 0,
        10_000,
        25,
        'the held-save notice',
      );
      expect(await noticesFor(rig.s, kase.file)).toEqual([
        expect.objectContaining({ kind: 'save-held', cause: 'no-history-or-backup' }),
      ]);
      expect(readFileSync(rig.path, 'utf-8')).toBe(kase.outside);

      await client?.cleanup();
      client = undefined;
      await server?.cleanup();
      server = undefined;

      expect(existsSync(rescued)).toBe(true);
      expect(readFileSync(rescued, 'utf-8')).toBe(here);
      expect(readFileSync(rig.path, 'utf-8')).toBe(kase.outside);
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  });

  test('a held save is retried and lands once history can take the outside version, replacing the held notice', async () => {
    const home = ownHome();
    blockBackups(home);
    let failing = true;
    const rig = await openSaved(kase.file, kase.saved, {
      historyFails: () => failing,
      stalenessSweepIntervalMs: 100,
      home,
    });
    await saveOverOutsideWrite(rig);
    await pollUntil(
      async () => (await noticesFor(rig.s, kase.file)).some((n) => n.kind === 'save-held'),
      10_000,
      25,
      'the held-save notice',
    );
    expect(readFileSync(rig.path, 'utf-8')).toBe(kase.outside);

    failing = false;

    await pollUntil(
      () => readFileSync(rig.path, 'utf-8') === here,
      10_000,
      25,
      'the retried save to write the edits',
    );
    expect(await historyVersions(rig.s, kase.file)).toEqual([
      {
        kind: 'external-change-no-engine',
        side: 'theirs',
        fileType: 'mermaid',
        content: kase.outside,
      },
    ]);
    expect(await noticesFor(rig.s, kase.file)).toEqual([
      expect.objectContaining({ kind: 'moved-to-history', reason: 'no-merge-engine' }),
    ]);
  });

  test('a held save is retried and lands once the backup folder can take the outside version', async () => {
    const home = ownHome();
    blockBackups(home);
    const rig = await openSaved(kase.file, kase.saved, {
      historyFails: () => true,
      stalenessSweepIntervalMs: 100,
      home,
    });
    await saveOverOutsideWrite(rig);
    await pollUntil(
      async () => (await noticesFor(rig.s, kase.file)).some((n) => n.kind === 'save-held'),
      10_000,
      25,
      'the held-save notice',
    );

    unblockBackups(home);

    await pollUntil(
      () => readFileSync(rig.path, 'utf-8') === here,
      10_000,
      25,
      'the retried save to write the edits',
    );
    expect(backupsIn(home)).toEqual([kase.outside]);
    expect(await noticesFor(rig.s, kase.file)).toEqual([
      expect.objectContaining({ kind: 'moved-to-backup', reason: 'no-merge-engine' }),
    ]);
  });
});

describe('a held save on a document that already shows a kept-version notice', () => {
  const kase = CASES[0];
  const here = kase.saved.replace(kase.edit.find, kase.edit.replace);

  test('shows both notices while the hold lasts, and the kept-version notice stays when it clears', async () => {
    const home = ownHome();
    let failing = false;
    const rig = await openSaved(kase.file, kase.saved, {
      historyFails: () => failing,
      stalenessSweepIntervalMs: 100,
      home,
    });
    editInClient(rig.c, kase.edit.find, kase.edit.replace);
    await pollUntil(() => liveText(rig.s, kase.file) === here, 10_000, 25, 'the edit');
    writeFileSync(rig.path, kase.outside, 'utf-8');
    await flushPendingStore(rig.s, kase.file);
    await pollUntil(() => readFileSync(rig.path, 'utf-8') === here, 10_000, 25, 'the first save');

    failing = true;
    blockBackups(home);
    const again = here.replace('A-->C', 'A-->E');
    editInClient(rig.c, 'A-->C', 'A-->E');
    await pollUntil(() => liveText(rig.s, kase.file) === again, 10_000, 25, 'the second edit');
    writeFileSync(rig.path, 'graph TD\n  A-->F\n', 'utf-8');
    await flushPendingStore(rig.s, kase.file);
    await pollUntil(
      async () => (await noticesFor(rig.s, kase.file)).some((n) => n.kind === 'save-held'),
      10_000,
      25,
      'the held-save notice',
    );
    expect((await noticesFor(rig.s, kase.file)).map((n) => n.kind).sort()).toEqual([
      'moved-to-history',
      'save-held',
    ]);

    failing = false;

    await pollUntil(
      () => readFileSync(rig.path, 'utf-8') === again,
      10_000,
      25,
      'the retried save to write the edits',
    );
    await pollUntil(
      async () => !(await noticesFor(rig.s, kase.file)).some((n) => n.kind === 'save-held'),
      10_000,
      25,
      'the held-save notice to clear',
    );
    expect(await noticesFor(rig.s, kase.file)).toEqual([
      expect.objectContaining({ kind: 'moved-to-history', reason: 'no-merge-engine' }),
    ]);
  });
});

describe('an outside version that is not UTF-8', () => {
  const kase = CASES[2];
  const here = kase.saved.replace(kase.edit.find, kase.edit.replace);

  test('holds the save with a notice, is not retried at each sweep, and saves once the file changes', async () => {
    const home = ownHome();
    const rig = await openSaved(kase.file, kase.saved, { stalenessSweepIntervalMs: 50, home });
    editInClient(rig.c, kase.edit.find, kase.edit.replace);
    await pollUntil(() => liveText(rig.s, kase.file) === here, 10_000, 25, 'the edit');
    const utf16 = Buffer.from('\ufefffirst line\r\n', 'utf16le');
    writeFileSync(rig.path, utf16);
    await flushPendingStore(rig.s, kase.file);
    await pollUntil(
      async () => (await noticesFor(rig.s, kase.file)).some((n) => n.kind === 'save-held'),
      10_000,
      25,
      'the held-save notice',
    );
    expect(await noticesFor(rig.s, kase.file)).toEqual([
      expect.objectContaining({ kind: 'save-held', cause: 'not-utf8' }),
    ]);
    const retriesBefore = getMetrics().heldSaveRetries;
    await new Promise((settle) => setTimeout(settle, 400));
    expect(getMetrics().heldSaveRetries).toBe(retriesBefore);
    expect(readFileSync(rig.path).equals(utf16)).toBe(true);

    writeFileSync(rig.path, kase.outside, 'utf-8');

    await pollUntil(
      () => readFileSync(rig.path, 'utf-8') === here,
      10_000,
      25,
      'the save to land once the file changed',
    );
    expect(await historyVersions(rig.s, kase.file)).toEqual([
      {
        kind: 'external-change-no-engine',
        side: 'theirs',
        fileType: 'text',
        content: kase.outside,
      },
    ]);
  });
});

describe('an outside write to an open, unedited file with no merge engine', () => {
  const kase = CASES[0];

  test('a focus re-read applies it live with no history entry and no notice', async () => {
    const { s, c, path } = await openSaved(kase.file, kase.saved);
    writeFileSync(path, kase.outside, 'utf-8');

    const res = await fetch(`${s.baseUrl}/api/documents/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docNames: [kase.file] }),
    });
    expect(await res.json()).toEqual({ checked: 1, found: 1 });

    await pollUntil(() => c.ytext.toString() === kase.outside, 10_000, 25, 'the re-read to apply');
    expect(await historyVersions(s, kase.file)).toEqual([]);
    expect(await noticesFor(s, kase.file)).toEqual([]);
  });

  test('a native change event applies it live', async () => {
    const { s, c, double, path } = await openSaved(kase.file, kase.saved);
    writeFileSync(path, kase.outside, 'utf-8');

    double.subscriptionFor(s.contentDir).deliver([{ type: 'update', path }]);

    await pollUntil(() => c.ytext.toString() === kase.outside, 10_000, 25, 'the event to apply');
    expect(await noticesFor(s, kase.file)).toEqual([]);
  });

  test('with native events silenced, the timed re-check applies it live', async () => {
    const { c, clock, path } = await openSaved(kase.file, kase.saved, {
      freshnessIntervalMs: 5_000,
    });
    writeFileSync(path, kase.outside, 'utf-8');

    clock.advance(5_000);

    await pollUntil(
      () => c.ytext.toString() === kase.outside,
      10_000,
      25,
      'the timed re-check to apply the outside bytes',
    );
    expect(readFileSync(path, 'utf-8')).toBe(kase.outside);
  });
});
