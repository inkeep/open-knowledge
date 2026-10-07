import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BacklinkEntry } from './backlink-index.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import { createServer } from './server-factory.ts';
import { WRITE_ADVISORY_DEADLINE_MS } from './write-advisory-gate.ts';

interface ApiExtensionLike {
  priority?: number;
  onRequest?: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
}

interface CapturedResponse {
  status: number;
  body: string;
}

const BUSY_LINK_CHECK = expect.objectContaining({
  kind: 'link-check-deferred',
  message: expect.stringContaining('busy with other writes'),
});

const RESPONSE_BOUND_MS = WRITE_ADVISORY_DEADLINE_MS + 5_000;

const TEST_TIMEOUT_MS = 3 * RESPONSE_BOUND_MS;

function settleWithin<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
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

describe('agent writes while the derived document index is not answering (PRD-7398)', {
  timeout: TEST_TIMEOUT_MS,
}, () => {
  let tmpDir: string;
  let server: ReturnType<typeof createServer>;
  const releases: Array<() => void> = [];

  function stallIndexQueries(): void {
    let releaseBacklinks!: () => void;
    const backlinks = new Promise<BacklinkEntry[]>((resolve) => {
      releaseBacklinks = () => resolve([]);
    });
    let releaseDocNames!: () => void;
    const docNames = new Promise<string[]>((resolve) => {
      releaseDocNames = () => resolve([]);
    });
    releases.push(releaseBacklinks, releaseDocNames);
    vi.spyOn(DerivedDocumentIndex.prototype, 'getBacklinks').mockReturnValue(backlinks);
    vi.spyOn(DerivedDocumentIndex.prototype, 'getIndexedDocNames').mockReturnValue(docNames);
  }

  beforeEach(async () => {
    _resetDocExtensionsForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-write-advisory-deadline-'));
    const git = simpleGit({ baseDir: tmpDir });
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(tmpDir, 'index.md'), '# Index\n');
    server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    await server.ready;
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    vi.restoreAllMocks();
    await server.destroy();
    _resetDocExtensionsForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a write answers once it is on disk and marks its link check as skipped', async () => {
    const answered = await settleWithin(
      post(server, '/api/agent-write-md', {
        docName: 'answered',
        markdown: '# Answered\n\nSee [[nowhere]].\n',
        position: 'replace',
      }),
      'agent-write-md before the stall',
      RESPONSE_BOUND_MS,
    );
    expect(answered.status).toBe(200);
    const answeredBody = JSON.parse(answered.body);
    expect(answeredBody.brokenLinks).toEqual([
      expect.objectContaining({ href: '[[nowhere]]', reason: 'no-such-doc' }),
    ]);
    expect(answeredBody.hints).toEqual([
      expect.objectContaining({ type: 'orphan', parentCandidates: ['index'] }),
    ]);

    stallIndexQueries();
    const filePath = join(tmpDir, 'stalled.md');

    const write = await settleWithin(
      post(server, '/api/agent-write-md', {
        docName: 'stalled',
        markdown: '# Stalled\n\nSee [[nowhere]].\n',
        position: 'replace',
      }),
      'agent-write-md during the stall',
      RESPONSE_BOUND_MS,
    );

    expect(write.status).toBe(200);
    expect(readFileSync(filePath, 'utf-8')).toBe('# Stalled\n\nSee [[nowhere]].\n');
    const body = JSON.parse(write.body);
    expect(body).toMatchObject({ brokenLinks: [], warnings: [BUSY_LINK_CHECK] });
    expect(body.hints).toBeUndefined();
  });

  test('a write whose link index query fails answers as saved and marks its link check as skipped', async () => {
    const warn = vi.spyOn(getLogger('api'), 'warn');
    const failure = new Error('index query failed');
    vi.spyOn(DerivedDocumentIndex.prototype, 'getIndexedDocNames').mockRejectedValue(failure);

    const write = await post(server, '/api/agent-write-md', {
      docName: 'failed-check',
      markdown: '# Failed check\n\nSee [[nowhere]].\n',
      position: 'replace',
    });

    expect(write.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'failed-check.md'), 'utf-8')).toBe(
      '# Failed check\n\nSee [[nowhere]].\n',
    );
    expect(JSON.parse(write.body)).toMatchObject({ brokenLinks: [], warnings: [BUSY_LINK_CHECK] });

    const batch = await post(server, '/api/agent-write-batch', {
      docs: [{ docName: 'failed-batch', markdown: '# Failed batch\n\nSee [[nowhere]].\n' }],
    });

    expect(batch.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'failed-batch.md'), 'utf-8')).toBe(
      '# Failed batch\n\nSee [[nowhere]].\n',
    );
    expect(JSON.parse(batch.body).results).toEqual([
      expect.objectContaining({ status: 'written', brokenLinks: [], warnings: [BUSY_LINK_CHECK] }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      { err: failure },
      '[link-check] write link advisory failed post-write; skipping link checks',
    );
  });

  test('a batch write answers once its documents are on disk and marks link checks as skipped', async () => {
    stallIndexQueries();

    const batch = await settleWithin(
      post(server, '/api/agent-write-batch', {
        docs: [
          { docName: 'batch-one', markdown: '# One\n\nSee [[nowhere]].\n' },
          { docName: 'batch-two', markdown: '# Two\n' },
        ],
      }),
      'agent-write-batch during the stall',
      RESPONSE_BOUND_MS,
    );

    expect(batch.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'batch-one.md'), 'utf-8')).toBe('# One\n\nSee [[nowhere]].\n');
    expect(readFileSync(join(tmpDir, 'batch-two.md'), 'utf-8')).toBe('# Two\n');
    expect(JSON.parse(batch.body).results).toEqual([
      expect.objectContaining({ status: 'written', brokenLinks: [], warnings: [BUSY_LINK_CHECK] }),
      expect.objectContaining({ status: 'written', brokenLinks: [], warnings: [BUSY_LINK_CHECK] }),
    ]);
  });
});
