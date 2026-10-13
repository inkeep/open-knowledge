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
import { PagesSuccessSchema } from '@inkeep/open-knowledge-core';
import { expect, vi } from 'vitest';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import { createTestServer, type TestServer } from './test-harness.ts';

type BatchKind = 'delete' | 'write';
interface HeldBatch {
  kind: BatchKind;
  claimed: boolean;
  release: () => void;
  completed: Promise<void>;
}

export async function startAssetAdmissionScenario(
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-removal-assets-')));
  const docName = 'child/note';
  const filePath = join(contentDir, `${docName}.md`);
  const assetPath = 'child/image.png';
  mkdirSync(join(contentDir, 'child'));
  writeFileSync(filePath, '# Only Markdown\n');
  writeFileSync(join(contentDir, assetPath), new Uint8Array([1, 2, 3]));
  const batches: HeldBatch[] = [];
  const waiting: Array<{ kind: BatchKind; resolve: (batch: HeldBatch) => void }> = [];
  let tail = Promise.resolve();
  let closing = false;
  let server: TestServer | undefined;
  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) =>
      subscribe(
        parcel,
        dir,
        (error, events) => {
          if (dir !== contentDir) return onEvents(error, events);
          const selected = events.some((event) => event.path === filePath);
          const released = Promise.withResolvers<void>();
          const completed = Promise.withResolvers<void>();
          if (selected && !closing) {
            const kind = events.some((event) => event.path === filePath && event.type === 'delete')
              ? 'delete'
              : 'write';
            const batch: HeldBatch = {
              kind,
              claimed: false,
              release: released.resolve,
              completed: completed.promise,
            };
            batches.push(batch);
            const waiterIndex = waiting.findIndex((waiter) => waiter.kind === kind);
            if (waiterIndex !== -1) {
              batch.claimed = true;
              waiting.splice(waiterIndex, 1)[0].resolve(batch);
            }
          } else {
            released.resolve();
          }
          const work = tail.then(async () => {
            await released.promise;
            await onEvents(error, events);
            completed.resolve();
          });
          tail = work;
          return work;
        },
        options,
        platform,
      ),
    );
  const startWatcher = fileWatcher.startWatcher;
  const watcherSpy = vi
    .spyOn(fileWatcher, 'startWatcher')
    .mockImplementation((root, onDiskEvent, filter, options) =>
      startWatcher(root, onDiskEvent, filter, { ...options, forceBackend: 'parcel' }),
    );
  registerCleanup(async () => {
    closing = true;
    for (const batch of batches) batch.release();
    await runTeardownPhases(
      () => tail,
      async () => {
        await server?.cleanup();
      },
      () => {
        watcherSpy.mockRestore();
        subscriptionSpy.mockRestore();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
    );
  });
  server = await createTestServer({ contentDir });
  const running = server;
  expect(readdirSync(join(contentDir, 'child')).filter((name) => /\.mdx?$/.test(name))).toEqual([
    'note.md',
  ]);

  const nextBatch = (kind: BatchKind): Promise<HeldBatch> => {
    const batch = batches.find((candidate) => candidate.kind === kind && !candidate.claimed);
    if (batch) {
      batch.claimed = true;
      return Promise.resolve(batch);
    }
    return new Promise((resolve) => waiting.push({ kind, resolve }));
  };
  const post = (route: string, body: unknown) =>
    fetch(`${running.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    filePath,
    nextBatch,
    async snapshot() {
      const response = await fetch(`${running.baseUrl}/api/pages`);
      expect(response.status).toBe(200);
      const pages = PagesSuccessSchema.parse(await response.json());
      expect(existsSync(join(contentDir, assetPath))).toBe(true);
      return {
        disk: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
        indexed: pages.pages.some((page) => page.docName === docName),
        assetAdmitted: !running.instance.contentFilter.isExcluded(assetPath),
      };
    },
    async deleteThroughApi() {
      expect((await post('/api/delete-path', { kind: 'file', path: docName })).status).toBe(200);
    },
    async createThroughApi() {
      expect((await post('/api/create-page', { path: `${docName}.md` })).status).toBe(200);
    },
  };
}
