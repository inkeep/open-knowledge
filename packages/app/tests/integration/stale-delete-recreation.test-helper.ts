import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Document } from '@hocuspocus/server';
import {
  CommentThreadMetaSchema,
  DocumentReadSuccessSchema,
  ForwardLinksSuccessSchema,
  MetricsReconciliationSuccessSchema,
  PagesSuccessSchema,
  ThreadListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { expect, vi } from 'vitest';
import { CommentService } from '../../../server/src/comments/comment-service.ts';
import { DerivedDocumentIndex } from '../../../server/src/derived-document-index.ts';
import * as fileWatcher from '../../../server/src/file-watcher.ts';
import { resetMetrics } from '../../../server/src/metrics.ts';
import * as parcelSubscription from '../../../server/src/parcel-subscription.ts';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import {
  createTestClient,
  createTestServer,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

export const ORIGINAL = '# Original page\n\nOld body.\n';
export const RECREATED = '# Recreated page\n\nNew body with [target](target.md).\n';
export type DeletionHold = 'raw' | 'classified' | 'index' | 'none';

export async function startDeletionScenario(
  hold: DeletionHold,
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  resetMetrics();
  const docName = `deletion-${randomUUID()}`;
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-delete-')));
  const filePath = join(contentDir, `${docName}.md`);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const followers = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const clients = new Set<TestClient>();
  const admittedDocuments = new WeakMap<TestClient, Document | undefined>();
  const closedClients = new WeakSet<TestClient>();
  const commentDeletes = new Set<Promise<number>>();
  let server: TestServer | undefined;
  let rawTail = Promise.resolve();
  let sawDelete = false;
  let held = false;
  const pause = async () => {
    if (held) return;
    held = true;
    reached.resolve();
    await release.promise;
  };

  const subscribe = parcelSubscription.subscribeParcel;
  const subscriptionSpy = vi
    .spyOn(parcelSubscription, 'subscribeParcel')
    .mockImplementation((parcel, dir, onEvents, options, platform) =>
      subscribe(
        parcel,
        dir,
        (error, events) => {
          if (dir !== contentDir) return onEvents(error, events);
          const selected =
            !sawDelete &&
            events.some((event) => event.type === 'delete' && event.path === filePath);
          const follower = sawDelete;
          if (selected) sawDelete = true;
          const work = rawTail.then(async () => {
            if (selected && hold === 'raw') await pause();
            if (follower) await followers.promise;
            await onEvents(error, events);
            if (selected) completed.resolve();
          });
          rawTail = work;
          return work;
        },
        options,
        platform,
      ),
    );

  const startWatcher = fileWatcher.startWatcher;
  const watcherSpy = vi
    .spyOn(fileWatcher, 'startWatcher')
    .mockImplementation((root, onDiskEvent, contentFilter, options) =>
      startWatcher(
        root,
        async (event) => {
          if (hold === 'classified' && event.kind === 'delete' && event.docName === docName)
            await pause();
          await onDiskEvent(event);
        },
        contentFilter,
        { ...options, forceBackend: 'parcel' },
      ),
    );

  const deleteIndex = DerivedDocumentIndex.prototype.recordDiskDelete;
  const indexSpy = vi
    .spyOn(DerivedDocumentIndex.prototype, 'recordDiskDelete')
    .mockImplementation(async function (this: DerivedDocumentIndex, name) {
      await deleteIndex.call(this, name);
      if (hold === 'index' && name === docName) await pause();
    });

  const deleteComments = CommentService.prototype.deleteDoc;
  const commentsSpy = vi.spyOn(CommentService.prototype, 'deleteDoc').mockImplementation(function (
    this: CommentService,
    name,
  ) {
    const work = deleteComments.call(this, name);
    commentDeletes.add(work);
    void work.then(
      () => commentDeletes.delete(work),
      () => commentDeletes.delete(work),
    );
    return work;
  });

  registerCleanup(async () => {
    release.resolve();
    followers.resolve();
    await runTeardownPhases(
      () => rawTail,
      ...Array.from(clients, (client) => () => client.cleanup()),
      async () => {
        await server?.cleanup();
      },
      () => {
        commentsSpy.mockRestore();
        indexSpy.mockRestore();
        watcherSpy.mockRestore();
        subscriptionSpy.mockRestore();
      },
      () => rmSync(contentDir, { recursive: true, force: true }),
    );
  });

  writeFileSync(filePath, ORIGINAL, { flag: 'wx' });
  writeFileSync(join(contentDir, 'target.md'), '# Target\n', { flag: 'wx' });
  server = await createTestServer({ contentDir });
  const running = server;

  const post = (route: string, body: unknown) =>
    fetch(`${running.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const open = async () => {
    const client = await createTestClient(running.port, docName, { resetOnCleanup: false });
    clients.add(client);
    admittedDocuments.set(client, running.instance.hocuspocus.documents.get(docName));
    client.provider.on('close', () => closedClients.add(client));
    return client;
  };

  const close = async (client: TestClient) => {
    await client.cleanup();
    clients.delete(client);
  };

  const comment = async (quote: string) => {
    const response = await post('/api/comments', { docName, quote, body: quote });
    expect(response.status).toBe(201);
    return CommentThreadMetaSchema.parse(await response.json());
  };

  const create = async () => {
    expect((await post('/api/create-page', { path: `${docName}.md` })).status).toBe(200);
    const client = await open();
    const response = await post('/api/agent-write-md', {
      docName,
      markdown: RECREATED,
      position: 'replace',
      agentId: 'deletion-test',
    });
    expect(response.status).toBe(200);
    await expect.poll(() => client.ytext.toString()).toBe(RECREATED);
    return client;
  };

  const finishDeletion = async () => {
    release.resolve();
    await completed.promise;
    await Promise.all(commentDeletes);
  };

  const snapshot = async (client?: TestClient) => {
    const resident = running.instance.hocuspocus.documents.get(docName);
    const pagesResponse = await fetch(`${running.baseUrl}/api/pages`);
    const metricsResponse = await fetch(`${running.baseUrl}/api/metrics/reconciliation`);
    const commentsResponse = await fetch(
      `${running.baseUrl}/api/comments?doc=${encodeURIComponent(docName)}`,
    );
    const linksResponse = await fetch(
      `${running.baseUrl}/api/forward-links?docName=${encodeURIComponent(docName)}`,
    );
    expect([
      pagesResponse.status,
      metricsResponse.status,
      commentsResponse.status,
      linksResponse.status,
    ]).toEqual([200, 200, 200, 200]);
    const pages = PagesSuccessSchema.parse(await pagesResponse.json());
    const metrics = MetricsReconciliationSuccessSchema.parse(await metricsResponse.json());
    const comments = ThreadListSuccessSchema.parse(await commentsResponse.json());
    const links = ForwardLinksSuccessSchema.parse(await linksResponse.json());
    return {
      disk: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
      residentPresent:
        resident !== undefined &&
        (client === undefined || resident === admittedDocuments.get(client)),
      residentContent: resident?.getText('source').toString() ?? null,
      lifecycleStatus: resident?.getMap('lifecycle').get('status') ?? null,
      clientContent: client?.ytext.toString() ?? null,
      clientLifecycleStatus: client?.doc.getMap('lifecycle').get('status') ?? null,
      clientClosed: client !== undefined && closedClients.has(client),
      removedCount: metrics.recentlyRemovedDocsSize,
      listed: pages.pages.some((page) => page.docName === docName),
      threads: comments.threads.map((thread) => thread.threadId),
      forwardLinks: links.forwardLinks.flatMap((link) =>
        link.kind === 'doc' ? [link.docName] : [],
      ),
    };
  };

  return {
    server: running,
    docName,
    open,
    close,
    comment,
    create,
    snapshot,
    waitUntilHeld: () => reached.promise,
    finishDeletion,
    releaseFollowers: followers.resolve,
    async deleteThroughApi() {
      expect((await post('/api/delete-path', { kind: 'file', path: docName })).status).toBe(200);
    },
    deleteExternally: () => unlinkSync(filePath),
    async readDocument() {
      const response = await fetch(
        `${running.baseUrl}/api/document?docName=${encodeURIComponent(docName)}`,
      );
      expect(response.status).toBe(200);
      return DocumentReadSuccessSchema.parse(await response.json());
    },
  };
}
