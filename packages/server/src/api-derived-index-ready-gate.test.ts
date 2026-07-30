import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import {
  createApiExtension,
  createDerivedDocumentIndexApiPortStub,
} from './api-extension.test-helper.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { createContentFilter } from './content-filter.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';

interface PendingRoute {
  captured: { status: number; body: string };
  done: Promise<void>;
}

function startRoute(
  extension: ReturnType<typeof createApiExtension>,
  url: string,
  method = 'GET',
  body?: unknown,
): PendingRoute {
  const request = Readable.from(
    Buffer.from(body === undefined ? '' : JSON.stringify(body)),
  ) as unknown as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = { host: 'localhost' };
  const captured = { status: 0, body: '' };
  const response = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {},
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  const done = (
    extension as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request, response });
  return { captured, done };
}

describe('derived-index API readiness gate', () => {
  test('backlink and tag queries wait for post-watcher startup settlement', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-derived-ready-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, 'source.md'), 'See [[target]]. #startup\n');
    const index = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter: createContentFilter({ projectDir, contentDir }),
      getGlobalSkillRoots: () => [],
      signalChannel: () => {},
    });

    try {
      const startup = index.beginStartup('main');
      const extension = createApiExtension({
        hocuspocus: {} as never,
        sessionManager: {} as never,
        contentDir,
        getFileIndex: () => new Map(),
        derivedDocumentIndex: index,
      });
      const backlinksRoute = startRoute(extension, '/api/backlinks?docName=target');
      const tagsRoute = startRoute(extension, '/api/tags/startup');

      await startup.backlinksReady;
      await Promise.resolve();
      expect(backlinksRoute.captured.status).toBe(0);
      expect(tagsRoute.captured.status).toBe(0);

      await index.settleStartupAfterWatcherSeed();
      await Promise.all([backlinksRoute.done, tagsRoute.done]);

      expect(backlinksRoute.captured.status).toBe(200);
      expect(JSON.parse(backlinksRoute.captured.body)).toMatchObject({
        docName: 'target',
        backlinks: [{ source: 'source' }],
      });
      expect(tagsRoute.captured.status).toBe(200);
      expect(JSON.parse(tagsRoute.captured.body)).toMatchObject({
        name: 'startup',
        docs: [{ docName: 'source', matchingTags: ['startup'] }],
      });
    } finally {
      await index.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('test rescan retains the route-level 500 boundary for coordinator failures', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-derived-rescan-error-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const index = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter: createContentFilter({ projectDir, contentDir }),
      getGlobalSkillRoots: () => [],
      signalChannel: () => {},
    });

    try {
      const startup = index.beginStartup('main');
      await startup.backlinksReady;
      await index.settleStartupAfterWatcherSeed();
      vi.spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles').mockRejectedValueOnce(
        new Error('global rescan failure'),
      );
      const extension = createApiExtension({
        hocuspocus: {} as never,
        sessionManager: {} as never,
        contentDir,
        getFileIndex: () => new Map(),
        derivedDocumentIndex: index,
        enableTestRoutes: true,
      });

      const route = startRoute(extension, '/api/test-rescan-backlinks', 'POST');
      await route.done;

      expect(route.captured.status).toBe(500);
      expect(JSON.parse(route.captured.body)).toMatchObject({
        type: 'urn:ok:error:internal-server-error',
      });
    } finally {
      vi.restoreAllMocks();
      await index.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('project skill move waits for derived-index projection before responding', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-derived-skill-move-'));
    const sourceSkillDir = join(contentDir, '.ok', 'skills', 'old-skill');
    mkdirSync(sourceSkillDir, { recursive: true });
    writeFileSync(
      join(sourceSkillDir, 'SKILL.md'),
      '---\nname: old-skill\ndescription: Use when testing moves.\n---\n\n# Old skill\n',
    );
    let releaseProjection!: () => void;
    const projectionBarrier = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let projectionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      projectionStarted = resolve;
    });
    const recordDirectMutations = vi.fn(async () => {
      projectionStarted();
      await projectionBarrier;
    });
    const extension = createApiExtension({
      hocuspocus: {
        documents: new Map(),
        closeConnections() {},
        unloadDocument: async () => {},
      } as never,
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as never,
      contentDir,
      getFileIndex: () => new Map(),
      derivedDocumentIndex: createDerivedDocumentIndexApiPortStub({
        recordDirectMutations,
      }),
    });

    try {
      const route = startRoute(extension, '/api/skill', 'POST', {
        scope: 'project',
        fromName: 'old-skill',
        toName: 'new-skill',
      });

      await started;
      await Promise.resolve();
      expect(route.captured.status).toBe(0);

      releaseProjection();
      await route.done;

      expect(recordDirectMutations).toHaveBeenCalledTimes(1);
      expect(route.captured.status).toBe(200);
      expect(JSON.parse(route.captured.body)).toMatchObject({
        from: '.ok/skills/old-skill',
        to: '.ok/skills/new-skill',
      });
    } finally {
      releaseProjection();
      rmSync(contentDir, { recursive: true, force: true });
    }
  });
});
