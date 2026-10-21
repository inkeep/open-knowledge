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
import {
  DocumentDurabilityState,
  OK_DOC_REMOVED,
  type RenameCarryAnswer,
  WRITE_WAIT_BUDGET_MS,
  writtenThroughOf,
} from './document-durability-state.ts';

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
  test('answers projection-held once the bound elapses with the store still deferred, and reports it', async () => {
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

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'urn:ok:error:save-held',
      reason: 'pending-unsettled',
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
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
    const { results } = JSON.parse(response.body) as {
      results: Array<{ status: string; outcome?: string; error?: { reason?: string } }>;
    };
    expect(results.map((result) => [result.status, result.outcome, result.error?.reason])).toEqual(
      docNames.map(() => ['error', 'projection-held', 'pending-unsettled']),
    );
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

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'urn:ok:error:save-held',
      outcome: 'projection-held',
      saved: false,
    });
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
    deferral.settle({ kind: 'discarded', cause: { kind: 'branch-switch' } });
    const response = await responding;

    expect(response.status).toBe(409);
    expect((JSON.parse(response.body) as { type: string }).type).toBe(
      'urn:ok:error:branch-switched',
    );
    expect(unsettledEvents(warn)).toEqual([]);
  });
});

describe('agent-write flush: a document renamed outside the app while the write waits', () => {
  function renameOutsideWithCarry(docName: string, movedTo: string): Promise<RenameCarryAnswer> {
    const carry = durabilityState.beginRenameCarry(docName);
    const document = hocuspocus.documents.get(docName);
    if (!document) throw new Error(`${docName} is not loaded`);
    const carried = writtenThroughOf(document);
    const lifecycle = document.getMap('lifecycle');
    lifecycle.set('status', 'renamed');
    lifecycle.set('newPath', movedTo);
    durabilityState.settleRenameCarry(docName, carried);
    return carry;
  }

  function refusedAsRenamed(docName: string, movedTo: string, carry: Promise<RenameCarryAnswer>) {
    return {
      code: OK_DOC_REMOVED,
      message: `${docName} was renamed to ${movedTo} on disk`,
      removal: { kind: 'renamed' as const, renamedTo: movedTo, carry },
    };
  }

  test('a batch edit the rename carried is reported as moved when an earlier document held the flush', async () => {
    durabilityState.holdStores('held-first');
    const deferral = durabilityState.openDeferredStore('held-first');
    const flushWaiting = whenFlushStartsWaiting();

    const responding = postAgentWriteBatch(['held-first', 'renamed-later']);
    await flushWaiting;
    const carry = renameOutsideWithCarry('renamed-later', 'moved-later');
    durabilityState.recordStoreFailure(
      'renamed-later',
      refusedAsRenamed('renamed-later', 'moved-later', carry),
    );
    deferral.settle({ kind: 'completed' });
    const response = await responding;

    expect(response.status).toBe(200);
    const { results } = JSON.parse(response.body) as {
      results: Array<{
        docName: string;
        status: string;
        error?: { type?: string; detail?: string };
      }>;
    };
    expect(results[0]?.status).toBe('written');
    expect(results[1]?.error?.type).toBe('urn:ok:error:doc-moved');
    expect(results[1]?.error?.detail).toContain('moved-later');
  });

  test('a deferred store refused as renamed reports a carried edit as moved', async () => {
    const docName = 'renamed-deferred';
    durabilityState.holdStores(docName);
    const deferral = durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    const responding = postAgentWrite(docName);
    await flushWaiting;
    const carry = renameOutsideWithCarry(docName, 'moved-deferred');
    deferral.settle({
      kind: 'failed',
      failure: refusedAsRenamed(docName, 'moved-deferred', carry),
    });
    const response = await responding;

    expect(response.status).toBe(409);
    const body = JSON.parse(response.body) as { type: string; detail: string };
    expect(body.type).toBe('urn:ok:error:doc-moved');
    expect(body.detail).not.toContain('re-apply');
  });

  test('an edit made after the carry took its text is asked to be re-applied', async () => {
    const docName = 'renamed-after';
    await postAgentWrite(docName);
    const carry = renameOutsideWithCarry(docName, 'moved-after');
    durabilityState.holdStores(docName);
    const deferral = durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    const responding = postAgentWrite(docName);
    await flushWaiting;
    deferral.settle({ kind: 'failed', failure: refusedAsRenamed(docName, 'moved-after', carry) });
    const response = await responding;

    expect(response.status).toBe(409);
    const body = JSON.parse(response.body) as { type: string; detail: string };
    expect(body.type).toBe('urn:ok:error:doc-removed');
    expect(body.detail).toContain('re-apply your change there');
  });

  test("a carry still running when the write's wait runs out answers projection-held, never re-applied", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const docName = 'renamed-slow';
    durabilityState.holdStores(docName);
    const deferral = durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    let answered = false;
    const responding = postAgentWrite(docName).then((response) => {
      answered = true;
      return response;
    });
    await flushWaiting;
    const carry = durabilityState.beginRenameCarry(docName);
    deferral.settle({ kind: 'failed', failure: refusedAsRenamed(docName, 'moved-slow', carry) });
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
    expect(answered).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responding;

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'urn:ok:error:save-held',
      reason: 'pending-rename',
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
    expect(JSON.parse(response.body).detail).toContain('moved-slow');
  });

  test('a write waiting on a carry when the server stops answers server-stopped at the new name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const docName = 'renamed-at-shutdown';
    durabilityState.holdStores(docName);
    const deferral = durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    const responding = postAgentWrite(docName);
    await flushWaiting;
    const carry = durabilityState.beginRenameCarry(docName);
    deferral.settle({ kind: 'failed', failure: refusedAsRenamed(docName, 'moved-late', carry) });
    durabilityState.endAllRenameCarries();
    const response = await responding;

    expect(response.status).toBe(503);
    const body = JSON.parse(response.body) as { detail?: string };
    expect(body).toMatchObject({
      type: 'urn:ok:error:server-stopped',
      outcome: 'refused',
      saved: false,
      nextStep: 're-read',
    });
    expect(body.detail).toContain('moved-late');
    expect(body.detail).toContain('Do not re-create the document under its old name');
  });
});

describe('a route the app also calls, when the save is still running at the end of the wait', () => {
  test('agent undo keeps its 200 and says projection-held, so the app does not undo twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const docName = 'undo-held';
    expect((await postAgentWrite(docName)).status).toBe(200);
    durabilityState.holdWriteAdmission();
    durabilityState.openDeferredStore(docName);
    const flushWaiting = whenFlushStartsWaiting();

    const responding = post('/api/agent-undo', {
      docName,
      connectionId: 'agent-claude-1',
      scope: 'last',
    });
    await flushWaiting;
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS);
    const response = await responding;

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      undone: true,
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
  });
});
