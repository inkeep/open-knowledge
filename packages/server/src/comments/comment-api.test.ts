import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Principal } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { createCommentApi } from './comment-api.ts';
import { CommentIndex } from './comment-index.ts';
import { CommentService } from './comment-service.ts';
import { CommentThreadStore } from './thread-store.ts';

const log = getLogger('comment-api-test');
const ORIGINAL = 'The rollout is scheduled for Q3. We expect minimal downtime.';
const PRINCIPAL = { id: 'principal-1', display_name: 'Dev', display_email: 'd@x.dev' } as Principal;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

class MockRes {
  statusCode = 0;
  body = '';
  headers: Record<string, string> = {};
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(chunk?: unknown): this {
    if (chunk) this.body += String(chunk);
    this.writableEnded = true;
    return this;
  }
  setHeader(): void {}
  get json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

function getReq(url: string): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
}
function postReq(url: string, body: unknown): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (r as unknown as { url: string }).url = url;
  (r as unknown as { method: string }).method = 'POST';
  (r as unknown as { headers: unknown }).headers = {};
  return r;
}

let api: ReturnType<typeof createCommentApi>;
let bodies: Map<string, string>;
let changed: number;
/** The store's parent — `comments/` lives under it, and so does `threads/`. */
let localDir: string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comment-api-test-'));
  dirs.push(dir);
  localDir = dir;
  const store = new CommentThreadStore(dir, log);
  await store.init();
  bodies = new Map([['notes/rollout', ORIGINAL]]);
  const service = new CommentService({
    store,
    index: new CommentIndex(),
    getDocBody: (doc) => bodies.get(doc) ?? null,
  });
  changed = 0;
  api = createCommentApi({
    service,
    getPrincipal: () => PRINCIPAL,
    onChanged: () => {
      changed += 1;
    },
  });
});

async function createThread(): Promise<string> {
  const res = new MockRes();
  const start = ORIGINAL.indexOf('minimal downtime');
  await api.create(
    postReq('/api/comments', {
      docName: 'notes/rollout',
      start,
      end: start + 'minimal downtime'.length,
      body: 'still accurate?',
    }),
    res as unknown as ServerResponse,
  );
  expect(res.statusCode).toBe(201);
  return res.json.threadId as string;
}

describe('comment-api routes', () => {
  test('POST /api/comments creates a thread attributed to the principal', async () => {
    const id = await createThread();
    expect(id).toBeTruthy();
  });

  test('GET /api/comments?doc lists a doc threads', async () => {
    await createThread();
    const res = new MockRes();
    await api.list(getReq('/api/comments?doc=notes/rollout'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect((res.json.threads as unknown[]).length).toBe(1);
  });

  test('GET /api/comments without doc lists project-wide', async () => {
    await createThread();
    const res = new MockRes();
    await api.list(getReq('/api/comments'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect((res.json.threads as unknown[]).length).toBe(1);
  });

  test('POST /api/comments with queue lands the thread in the queue', async () => {
    const res = new MockRes();
    const start = ORIGINAL.indexOf('minimal downtime');
    await api.create(
      postReq('/api/comments', {
        docName: 'notes/rollout',
        start,
        end: start + 'minimal downtime'.length,
        body: 'batch this one',
        queue: true,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json.queued).toBe(true);
  });

  test('GET /api/comment?id reads one thread', async () => {
    const id = await createThread();
    const res = new MockRes();
    await api.read(getReq(`/api/comment?id=${id}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.json.threadId).toBe(id);
    expect(res.json.latestComment).toBe('still accurate?');
  });

  test('GET /api/comment?id for a missing thread is a 404', async () => {
    const res = new MockRes();
    await api.read(getReq(`/api/comment?id=${randomUUID()}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
  });

  test('POST /api/comment edit / resolve mutate the thread', async () => {
    const id = await createThread();
    const editRes = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'edit', id, body: 'revised ask' }),
      editRes as unknown as ServerResponse,
    );
    expect(editRes.statusCode).toBe(200);

    const resolveRes = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'resolve', id }),
      resolveRes as unknown as ServerResponse,
    );
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json.state).toBe('resolved');
  });

  test('POST /api/comment queue returns queued + orphaned status', async () => {
    const id = await createThread();
    bodies.set('notes/rollout', 'nothing to see here'); // anchor will be lost
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'queue', id }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json.orphaned).toBe(true);
    expect((res.json.meta as { queued: boolean }).queued).toBe(true);
  });

  test('POST /api/comments on a missing doc is a 404', async () => {
    const res = new MockRes();
    await api.create(
      postReq('/api/comments', { docName: 'gone', start: 0, end: 1, body: 'x' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  test('mutations signal clients to refetch; reads do not', async () => {
    const id = await createThread();
    expect(changed).toBe(1); // create signalled

    const listRes = new MockRes();
    await api.list(getReq('/api/comments?doc=notes/rollout'), listRes as unknown as ServerResponse);
    expect(changed).toBe(1); // a read must not signal

    await api.mutate(
      postReq('/api/comment', { action: 'resolve', id }),
      new MockRes() as unknown as ServerResponse,
    );
    expect(changed).toBe(2);
  });

  test('a failed mutation does not signal', async () => {
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'resolve', id: randomUUID() }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    expect(changed).toBe(0);
  });

  test('dispatch-prepare returns the payload the client composes with', async () => {
    const id = await createThread();
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-prepare', id }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    const payload = res.json.payload as {
      docName: string;
      instruction: string;
      passage: unknown;
      anchorLost: boolean;
    };
    expect(payload.docName).toBe('notes/rollout');
    expect(payload.instruction).toBe('still accurate?');
    expect(payload.passage).toMatchObject({ exact: 'minimal downtime' });
    expect(payload.anchorLost).toBe(false);
    expect((res.json.meta as { queued: boolean }).queued).toBe(true);
  });

  test('dispatch-prepare still returns a payload when the anchor is lost', async () => {
    const id = await createThread();
    bodies.set('notes/rollout', 'nothing to see here');
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-prepare', id }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json.payload as { anchorLost: boolean }).anchorLost).toBe(true);
    expect((res.json.meta as { state: string }).state).toBe('orphaned');
  });

  test('dispatch-complete resolves the thread', async () => {
    const id = await createThread();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-prepare', id }),
      new MockRes() as unknown as ServerResponse,
    );
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-complete', id }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json.state).toBe('resolved');
    expect(res.json.queued).toBe(false);
  });

  test('batch prepare + complete dispatches the selected ids in order', async () => {
    const first = await createThread();
    const second = await createThread();

    const prepRes = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-prepare-batch', ids: [second, first] }),
      prepRes as unknown as ServerResponse,
    );
    expect(prepRes.statusCode).toBe(200);
    const prepared = prepRes.json.results as { threadId: string; ok: boolean }[];
    expect(prepared.map((r) => r.threadId)).toEqual([second, first]);

    const doneRes = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-complete-batch', ids: [second, first] }),
      doneRes as unknown as ServerResponse,
    );
    expect(doneRes.statusCode).toBe(200);
    const done = doneRes.json.results as { ok: boolean; meta?: { state: string } }[];
    expect(done.every((r) => r.ok && r.meta?.state === 'resolved')).toBe(true);
  });

  test('batch prepare reports a missing id without failing the batch', async () => {
    const id = await createThread();
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-prepare-batch', ids: [id, randomUUID()] }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    const results = res.json.results as { ok: boolean; error?: string }[];
    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: 'not-found' });
  });

  test('an empty batch is a 400', async () => {
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'dispatch-prepare-batch', ids: [] }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });

  test('DELETE /api/comment removes the thread outright', async () => {
    const id = await createThread();
    const res = new MockRes();
    await api.remove(getReq(`/api/comment?id=${id}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.json.threadId).toBe(id);

    // really gone — not merely unqueued or resolved
    const readRes = new MockRes();
    await api.read(getReq(`/api/comment?id=${id}`), readRes as unknown as ServerResponse);
    expect(readRes.statusCode).toBe(404);

    const listRes = new MockRes();
    await api.list(getReq('/api/comments?doc=notes/rollout'), listRes as unknown as ServerResponse);
    expect(listRes.json.threads).toEqual([]);
  });

  test('DELETE /api/comment refuses an id that walks out of the comments dir', async () => {
    // The ACP thread store is `comments/`'s sibling and names its files with the
    // same two extensions, so a traversing id lands on real agent transcripts.
    const victimId = randomUUID();
    mkdirSync(join(localDir, 'threads'), { recursive: true });
    const transcript = join(localDir, 'threads', `${victimId}.ndjson`);
    const meta = join(localDir, 'threads', `${victimId}.meta.json`);
    writeFileSync(transcript, '{"kind":"user_message"}\n');
    writeFileSync(meta, '{}');

    const res = new MockRes();
    await api.remove(
      getReq(`/api/comment?id=${encodeURIComponent(`../threads/${victimId}`)}`),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect(existsSync(transcript)).toBe(true);
    expect(existsSync(meta)).toBe(true);
  });

  test('GET /api/comment refuses an id that walks out of the comments dir', async () => {
    const res = new MockRes();
    await api.read(
      getReq(`/api/comment?id=${encodeURIComponent('../threads/whatever')}`),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/comment refuses a mutate id that is not a thread UUID', async () => {
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'resolve', id: '../threads/whatever' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });

  test('DELETE /api/comment without an id is a 400', async () => {
    const res = new MockRes();
    await api.remove(getReq('/api/comment'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/comment with an invalid action is a 400', async () => {
    const res = new MockRes();
    await api.mutate(
      postReq('/api/comment', { action: 'explode', id: 'x' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });
});
