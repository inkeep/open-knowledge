/**
 * Disk-output tests for the explicit `extension` hint on /api/agent-write-md
 * (`write_document({ docName: "x.mdx" })` used to land `x.md`).
 *
 * The handler pre-registers the requested extension before the persistence
 * flush — but only for a brand-new doc. For a doc that already exists under a
 * supported extension the recorded extension wins (switching it would orphan
 * the original file). These assertions read the real filesystem after the
 * write, since "wrong file on disk" is the bug under test — so they drive the
 * production persistence path via `createServer` (the bare-Hocuspocus +
 * `createApiExtension` harness other agent-write tests use has no persistence
 * extension and never lands a file).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import simpleGit from 'simple-git';
import { _resetDocExtensionsForTests, getDocExtension } from './doc-extensions.ts';
import { createServer } from './server-factory.ts';

interface ApiExtensionLike {
  priority?: number;
  onRequest?: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
}

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

/**
 * POST to the production API extension wired into `createServer` (which also
 * wires the persistence extension that writes to disk). The API extension is
 * the `priority: 100` onRequest hook.
 */
async function postAgentWriteMd(
  server: ReturnType<typeof createServer>,
  body: Record<string, unknown>,
): Promise<number> {
  const apiExt = server.hocuspocus.configuration.extensions.find(
    (e): e is ApiExtensionLike =>
      (e as ApiExtensionLike).priority === 100 &&
      typeof (e as ApiExtensionLike).onRequest === 'function',
  );
  if (!apiExt?.onRequest) throw new Error('API extension (priority 100) not found on server');
  const req = makeJsonPostReq('/api/agent-write-md', body);
  const { res, captured } = makeRes();
  await apiExt.onRequest({ request: req, response: res });
  return captured.status;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`File ${filePath} did not appear within ${timeoutMs}ms`);
}

/**
 * Poll until `filePath` contains `needle`. For a doc that already exists on
 * disk, mere existence is satisfied by the pre-created file — only the content
 * proves the new write actually persisted (a 200 with a silently-dropped store
 * would otherwise pass).
 */
async function waitForFileContent(
  filePath: string,
  needle: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath) && readFileSync(filePath, 'utf-8').includes(needle)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`File ${filePath} did not contain "${needle}" within ${timeoutMs}ms`);
}

describe('agent-write-md explicit extension → disk (PRD-6836)', () => {
  let tmpDir: string;
  let contentDir: string;

  async function bootServer(): Promise<ReturnType<typeof createServer>> {
    const server = createServer({
      contentDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
    return server;
  }

  beforeEach(async () => {
    // `docExtensionByName` is a module-global singleton — reset BEFORE the
    // server's watcher scans, so a docName registered by a prior test can't
    // shadow this test's fresh content dir.
    _resetDocExtensionsForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-write-ext-'));
    contentDir = tmpDir;
    const git = simpleGit({ baseDir: tmpDir });
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
  });

  afterEach(() => {
    _resetDocExtensionsForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('extension: ".mdx" on a new doc writes x.mdx (not x.md)', async () => {
    const server = await bootServer();
    try {
      const status = await postAgentWriteMd(server, {
        docName: 'guides/widget',
        markdown: '# Widget\n',
        position: 'replace',
        extension: '.mdx',
      });
      expect(status).toBe(200);
      await waitForFile(join(contentDir, 'guides', 'widget.mdx'));
      expect(existsSync(join(contentDir, 'guides', 'widget.mdx'))).toBe(true);
      expect(existsSync(join(contentDir, 'guides', 'widget.md'))).toBe(false);
      expect(getDocExtension('guides/widget')).toBe('.mdx');
    } finally {
      await server.destroy();
    }
  });

  test('no extension hint on a new doc defaults to x.md', async () => {
    const server = await bootServer();
    try {
      const status = await postAgentWriteMd(server, {
        docName: 'plain',
        markdown: '# Plain\n',
        position: 'replace',
      });
      expect(status).toBe(200);
      await waitForFile(join(contentDir, 'plain.md'));
      expect(existsSync(join(contentDir, 'plain.md'))).toBe(true);
      expect(existsSync(join(contentDir, 'plain.mdx'))).toBe(false);
    } finally {
      await server.destroy();
    }
  });

  test('extension: ".mdx" is ignored when the doc already exists as .md (no orphan sibling)', async () => {
    // Pre-existing on-disk file under .md — the server's watcher registers it
    // on the initial scan, so the new-doc gate sees the doc already exists.
    writeFileSync(join(contentDir, 'existing.md'), '# Existing\n');

    const server = await bootServer();
    try {
      const status = await postAgentWriteMd(server, {
        docName: 'existing',
        markdown: '# Replaced\n',
        position: 'replace',
        extension: '.mdx',
      });
      expect(status).toBe(200);
      // Assert the NEW body landed on the original .md file — not just that the
      // pre-created file still exists (which would pass even if the store was
      // silently dropped).
      await waitForFileContent(join(contentDir, 'existing.md'), '# Replaced');
      // The write stays on the original .md file — no .mdx sibling is spawned.
      expect(existsSync(join(contentDir, 'existing.mdx'))).toBe(false);
      expect(existsSync(join(contentDir, 'existing.md'))).toBe(true);
      expect(getDocExtension('existing')).toBe('.md');
    } finally {
      await server.destroy();
    }
  });
});
