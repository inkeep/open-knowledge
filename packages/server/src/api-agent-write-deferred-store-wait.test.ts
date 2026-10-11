import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentSessionManager } from './agent-sessions.ts';
import {
  createApiExtension,
  createDerivedDocumentIndexApiPortStub,
} from './api-extension.test-helper.ts';
import { DocumentDurabilityState, WRITE_WAIT_BUDGET_MS } from './document-durability-state.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

function makeJsonPostReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
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

let projectDir: string;
let contentDir: string;
let hocuspocus: Hocuspocus;
let sessionManager: AgentSessionManager;
let durabilityState: DocumentDurabilityState;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-deferred-store-wait-'));
  contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  hocuspocus = new Hocuspocus({ quiet: true });
  sessionManager = new AgentSessionManager(hocuspocus);
  durabilityState = new DocumentDurabilityState();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await sessionManager.closeAll();
  rmSync(projectDir, { recursive: true, force: true });
});

async function postAgentWrite(docName: string): Promise<CapturedResponse> {
  return post('/api/agent-write', {
    docName,
    content: 'Edited during the switch.',
    agentId: 'claude-1',
    agentName: 'Claude',
  });
}

async function postAgentWriteBatch(docNames: string[]): Promise<CapturedResponse> {
  return post('/api/agent-write-batch', {
    docs: docNames.map((docName) => ({
      docName,
      markdown: '# Edited during the switch\n',
      position: 'replace',
    })),
    agentId: 'claude-1',
    agentName: 'Claude',
  });
}

async function post(url: string, body: unknown): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus,
    durabilityState,
    sessionManager,
    contentDir,
    serverInstanceId: 'test-instance',
    getFileIndex: () => new Map(),
    derivedDocumentIndex: createDerivedDocumentIndexApiPortStub(),
  });
  const req = makeJsonPostReq(url, body);
  const { res, captured } = makeRes();
  await (
    ext as unknown as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

function whenFlushStartsWaiting(): Promise<void> {
  const started = Promise.withResolvers<void>();
  const awaitOutcome = durabilityState.awaitDeferredStoreOutcome.bind(durabilityState);
  vi.spyOn(durabilityState, 'awaitDeferredStoreOutcome').mockImplementation(
    (docName, timeoutMs) => {
      const outcome = awaitOutcome(docName, timeoutMs);
      started.resolve();
      return outcome;
    },
  );
  return started.promise;
}

function unsettledEvents(warn: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return warn.mock.calls.flatMap(([line]) => {
    if (typeof line !== 'string' || !line.startsWith('{')) return [];
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed.event === 'agent-write-deferred-store-unsettled' ? [parsed] : [];
  });
}

describe('agent-write flush: bounded wait for a deferred store', () => {
  test('acknowledges once the bound elapses with the store still deferred, and reports it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const docName = 'held-store';
    durabilityState.holdWriteAdmission();
    durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    let answered = false;
    const responding = postAgentWrite(docName).then((response) => {
      answered = true;
      return response;
    });
    await flushWaiting;
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
    expect(answered).toBe(false);
    expect(unsettledEvents(warn)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responding;

    expect(response.status).toBe(200);
    expect(unsettledEvents(warn)).toEqual([
      expect.objectContaining({
        event: 'agent-write-deferred-store-unsettled',
        'doc.name': docName,
      }),
    ]);
  });

  test('answers a batch write within one budget when a branch switch outlives it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sessionManager.closeAll();
    sessionManager = new AgentSessionManager(hocuspocus, {
      awaitWriteAdmission: () => durabilityState.whenWriteAdmitted(),
    });
    durabilityState.holdWriteAdmission();
    const docNames = ['held-a', 'held-b', 'held-c'];
    for (const docName of docNames) durabilityState.openDeferredStore(docName);

    let answered = false;
    const responding = postAgentWriteBatch(docNames).then((response) => {
      answered = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
    expect(answered).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responding;

    expect(response.status).toBe(200);
    const { results } = JSON.parse(response.body) as { results: Array<{ status: string }> };
    expect(results.map((result) => result.status)).toEqual(['written', 'written', 'written']);
  });

  test('answers a native-route write within one budget when a branch switch outlives it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sessionManager.closeAll();
    sessionManager = new AgentSessionManager(hocuspocus, {
      awaitWriteAdmission: () => durabilityState.whenWriteAdmitted(),
    });
    durabilityState.holdWriteAdmission();
    const docName = 'held-native';
    durabilityState.openDeferredStore(docName);

    let answered = false;
    const responding = post('/api/agent-write-md', {
      docName,
      markdown: '# Edited during the switch\n',
      position: 'replace',
      agentId: 'claude-1',
    }).then((response) => {
      answered = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
    expect(answered).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responding;

    expect(response.status).toBe(200);
  });

  test('does not hold a write behind a Git operation that cannot discard it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sessionManager.closeAll();
    sessionManager = new AgentSessionManager(hocuspocus, {
      awaitWriteAdmission: () => durabilityState.whenWriteAdmitted(),
    });
    const docName = 'synced-store';
    durabilityState.setBatchInProgress(true);
    durabilityState.openDeferredStore(docName);

    const response = await postAgentWrite(docName);

    expect(response.status).toBe(200);
    expect(unsettledEvents(warn)).toEqual([]);
  });

  test('reports a deferred store that failed instead of acknowledging it', async () => {
    const docName = 'failed-store';
    durabilityState.holdWriteAdmission();
    const deferral = durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    const responding = postAgentWrite(docName);
    await flushWaiting;
    deferral.settle({ kind: 'failed', failure: { code: 'EACCES', message: 'permission denied' } });
    const response = await responding;

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).toContain('failed to persist to disk (EACCES): permission denied');
  });

  test('still refuses with branch-switched when the discard lands within the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const docName = 'discarded-store';
    durabilityState.holdWriteAdmission();
    const deferral = durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    const responding = postAgentWrite(docName);
    await flushWaiting;
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
    deferral.settle({ kind: 'discarded' });
    const response = await responding;

    expect(response.status).toBe(409);
    expect((JSON.parse(response.body) as { type: string }).type).toBe(
      'urn:ok:error:branch-switched',
    );
    expect(unsettledEvents(warn)).toEqual([]);
  });
});
