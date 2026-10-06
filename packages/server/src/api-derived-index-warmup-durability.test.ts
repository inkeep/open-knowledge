import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BacklinkIndex } from './backlink-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import { createServer } from './server-factory.ts';

interface ApiExtensionLike {
  priority?: number;
  onRequest?: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
}

interface CapturedResponse {
  status: number;
  body: string;
}

const DEFERRED = expect.objectContaining({ kind: 'link-check-deferred' });

function settleWithin<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function post(
  server: ReturnType<typeof createServer>,
  url: string,
  body: unknown,
): Promise<CapturedResponse> {
  const apiExt = server.hocuspocus.configuration.extensions.find(
    (e): e is ApiExtensionLike =>
      (e as ApiExtensionLike).priority === 100 &&
      typeof (e as ApiExtensionLike).onRequest === 'function',
  );
  if (!apiExt?.onRequest) throw new Error('API extension (priority 100) not found on server');
  const request = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  request.method = 'POST';
  request.url = url;
  request.headers = { host: 'localhost', 'content-type': 'application/json' };
  const captured: CapturedResponse = { status: 0, body: '' };
  const response = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {},
    end(text?: string) {
      captured.body = text ?? '';
    },
  } as unknown as ServerResponse;
  if (!(await server.nativeApi.dispatch(request, response))) {
    await apiExt.onRequest({ request, response });
  }
  return captured;
}

describe('agent writes while the derived index is still starting (PRD-8839)', () => {
  let tmpDir: string;
  let server: ReturnType<typeof createServer>;
  let releaseStartup: () => void;

  beforeEach(async () => {
    _resetDocExtensionsForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-warmup-durability-'));
    const git = simpleGit({ baseDir: tmpDir });
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    const startupStalled = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const rebuild = vi
      .spyOn(BacklinkIndex.prototype, 'rebuildFromDisk')
      .mockReturnValue(startupStalled);
    server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalled(), { timeout: 10_000 });
  });

  afterEach(async () => {
    releaseStartup();
    await server.ready;
    vi.restoreAllMocks();
    await server.destroy();
    _resetDocExtensionsForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('an edit after a write reaches disk, and both respond without link advisories', async () => {
    const filePath = join(tmpDir, 'warmup-edit.md');

    const write = await settleWithin(
      post(server, '/api/agent-write-md', {
        docName: 'warmup-edit',
        markdown: '# Warm-up\n\nline one. See [[nowhere]].\n',
        position: 'replace',
      }),
      'agent-write-md',
    );
    expect(write.status).toBe(200);
    expect(readFileSync(filePath, 'utf-8')).toBe('# Warm-up\n\nline one. See [[nowhere]].\n');
    expect(JSON.parse(write.body)).toMatchObject({ brokenLinks: [], warnings: [DEFERRED] });

    const edit = await settleWithin(
      post(server, '/api/agent-patch', {
        docName: 'warmup-edit',
        find: 'line one.',
        replace: 'line one, edited.',
      }),
      'agent-patch',
    );
    expect(edit.status).toBe(200);
    expect(readFileSync(filePath, 'utf-8')).toBe(
      '# Warm-up\n\nline one, edited. See [[nowhere]].\n',
    );
    expect(JSON.parse(edit.body)).toMatchObject({ brokenLinks: [], warnings: [DEFERRED] });
  });

  test('frontmatter patches and batch writes mark their link check as deferred', async () => {
    await settleWithin(
      post(server, '/api/agent-write-md', {
        docName: 'warmup-frontmatter',
        markdown: '# Tagged\n\nSee [[nowhere]].\n',
        position: 'replace',
      }),
      'agent-write-md',
    );

    const frontmatter = await settleWithin(
      post(server, '/api/frontmatter-patch', {
        docName: 'warmup-frontmatter',
        patch: { status: 'draft' },
      }),
      'frontmatter-patch',
    );
    expect(frontmatter.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'warmup-frontmatter.md'), 'utf-8')).toContain('status: draft');
    expect(JSON.parse(frontmatter.body)).toMatchObject({ brokenLinks: [], warnings: [DEFERRED] });

    const batch = await settleWithin(
      post(server, '/api/agent-write-batch', {
        docs: [{ docName: 'warmup-batch', markdown: '# Batch\n\nSee [[nowhere]].\n' }],
      }),
      'agent-write-batch',
    );
    expect(batch.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'warmup-batch.md'), 'utf-8')).toBe(
      '# Batch\n\nSee [[nowhere]].\n',
    );
    expect(JSON.parse(batch.body).results).toEqual([
      expect.objectContaining({ status: 'written', brokenLinks: [], warnings: [DEFERRED] }),
    ]);
  });

  test('delete-path removes an open document and responds', async () => {
    const filePath = join(tmpDir, 'warmup-delete.md');
    await settleWithin(
      post(server, '/api/agent-write-md', {
        docName: 'warmup-delete',
        markdown: '# Doomed\n',
        position: 'replace',
      }),
      'agent-write-md',
    );
    expect(existsSync(filePath)).toBe(true);

    const deleted = await settleWithin(
      post(server, '/api/delete-path', { kind: 'file', path: 'warmup-delete.md' }),
      'delete-path',
    );

    expect(deleted.status).toBe(200);
    expect(existsSync(filePath)).toBe(false);
  });

  test('duplicate-path copies a document and responds', async () => {
    await settleWithin(
      post(server, '/api/agent-write-md', {
        docName: 'warmup-original',
        markdown: '# Original\n',
        position: 'replace',
      }),
      'agent-write-md',
    );

    const duplicated = await settleWithin(
      post(server, '/api/duplicate-path', { kind: 'file', path: 'warmup-original.md' }),
      'duplicate-path',
    );

    expect(duplicated.status).toBe(200);
    const { duplicatedDocNames } = JSON.parse(duplicated.body) as { duplicatedDocNames: string[] };
    expect(duplicatedDocNames).toHaveLength(1);
    expect(readFileSync(join(tmpDir, `${duplicatedDocNames[0]}.md`), 'utf-8')).toBe('# Original\n');
  });
});
