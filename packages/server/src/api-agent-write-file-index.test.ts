/**
 * the agent write/edit/frontmatter-patch handlers register
 * the doc they just persisted into the file index synchronously, instead of
 * relying solely on the file-watcher (whose create FSEvent can be permanently
 * dropped for a file written into a freshly-created subdir — see file-watcher.ts).
 *
 * These drive the lightweight bare-Hocuspocus + `createApiExtension` harness
 * (no persistence extension, no watcher) and spy on `mutateFileIndex`, so what
 * they observe is the handler's own registration, not the watcher's.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';
import { createContentFilter } from './content-filter.ts';
import type { DiskEvent, FileIndexEntry } from './file-watcher.ts';

function makeJsonPostReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function post(
  ext: {
    onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
  },
  url: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const req = makeJsonPostReq(url, body);
  const { res, captured } = makeRes();
  await ext.onRequest({ request: req, response: res });
  return captured;
}

describe('agent write self-registers the file index (PRD-7201)', () => {
  test('agent-write-md registers the just-written doc into the file index', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-write-file-index-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const events: DiskEvent[] = [];

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        mutateFileIndex: (event) => events.push(event),
      }) as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      };

      const captured = await post(ext, '/api/agent-write-md', {
        docName: 'evidence/new-target',
        markdown: '# New Target\n',
        position: 'replace',
      });

      expect(captured.status).toBe(200);
      // The handler registered the doc into the file index without any watcher
      // event — closing the dropped-FSEvent gap at the write source.
      const docEvents = events.filter(
        (e) => 'docName' in e && (e as { docName?: string }).docName === 'evidence/new-target',
      );
      expect(docEvents).toHaveLength(1);
      expect(docEvents[0].kind).toBe('create');
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a write to a doc already in the file index registers as kind:update', async () => {
    // The other tests wire an empty file index, so they only exercise the
    // `kind: 'create'` branch. Pre-seed the doc so the upsert takes the
    // `kind: 'update'` branch (the watcher dropped a later event for a doc it
    // had already indexed — re-registration must not flip it to a create).
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-write-file-index-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const events: DiskEvent[] = [];
    const fileIndex = new Map<string, FileIndexEntry>([
      [
        'notes',
        {
          size: 1,
          modified: new Date(0).toISOString(),
          canonicalPath: '',
          inode: 0,
          aliases: [],
          kind: 'markdown',
        },
      ],
    ]);

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => fileIndex,
        mutateFileIndex: (event) => events.push(event),
      }) as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      };

      const captured = await post(ext, '/api/agent-write-md', {
        docName: 'notes',
        markdown: '# Notes\n',
        position: 'replace',
      });

      expect(captured.status).toBe(200);
      const docEvents = events.filter(
        (e) => 'docName' in e && (e as { docName?: string }).docName === 'notes',
      );
      expect(docEvents).toHaveLength(1);
      expect(docEvents[0].kind).toBe('update');
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('agent-patch registers the just-edited doc into the file index', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-write-file-index-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const events: DiskEvent[] = [];

    try {
      const session = await sessionManager.getSession('notes');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nalpha\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        mutateFileIndex: (event) => events.push(event),
      }) as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      };

      const captured = await post(ext, '/api/agent-patch', {
        docName: 'notes',
        find: 'alpha',
        replace: 'beta',
      });

      expect(captured.status).toBe(200);
      const docEvents = events.filter(
        (e) => 'docName' in e && (e as { docName?: string }).docName === 'notes',
      );
      expect(docEvents).toHaveLength(1);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('frontmatter-patch registers the patched doc into the file index', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-write-file-index-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const events: DiskEvent[] = [];

    try {
      const session = await sessionManager.getSession('notes');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nbody text\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        mutateFileIndex: (event) => events.push(event),
      }) as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      };

      const captured = await post(ext, '/api/frontmatter-patch', {
        docName: 'notes',
        patch: { addedkey: 'v1' },
      });

      expect(captured.status).toBe(200);
      const docEvents = events.filter(
        (e) => 'docName' in e && (e as { docName?: string }).docName === 'notes',
      );
      expect(docEvents).toHaveLength(1);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('does NOT register a content-scope-excluded doc (mirrors the watcher gate)', async () => {
    // The write handlers don't reject okignore'd targets (only reserved system/
    // config names), so an agent CAN write to one. The watcher would never index
    // it; the synchronous registration must skip it the same way, or its on-disk
    // title would leak through the admitted set the link/title endpoints read.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-write-file-index-excluded-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, '.okignore'), 'secret.md\n', 'utf-8');
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const events: DiskEvent[] = [];

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        contentFilter: createContentFilter({ projectDir, contentDir }),
        mutateFileIndex: (event) => events.push(event),
      }) as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      };

      const captured = await post(ext, '/api/agent-write-md', {
        docName: 'secret',
        markdown: '# Top Secret\n',
        position: 'replace',
      });

      // The write itself still succeeds — only the file-index registration is gated.
      expect(captured.status).toBe(200);
      const docEvents = events.filter(
        (e) => 'docName' in e && (e as { docName?: string }).docName === 'secret',
      );
      expect(docEvents).toHaveLength(0);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
