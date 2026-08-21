/**
 * Unit tests for the background bug-report send manager.
 *
 * The stub stands in for the desktop bridge, which is a genuine process
 * boundary — `send` crosses into Electron main over IPC. Everything else here
 * is the real module.
 */

import type { OkBugReportListRow, OkBugReportSendResult } from '@inkeep/open-knowledge-core';
import { propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type BugReportSendBridge,
  type BugReportSendOperation,
  type BugReportSendRequest,
  bugReportSendManager,
  type CreatedBugReport,
  createBugReportSendManager,
} from '@/lib/bug-report-send-manager';

const ZIP_PATH = '/Users/x/Library/ok/reports/ok-report-2026-08-18-120000.zip';
const OPERATION_ID = 'ok-report-2026-08-18-120000.zip';
const OTHER_ZIP_PATH = '/Users/x/Library/ok/reports/ok-report-2026-08-18-130000.zip';
const OTHER_OPERATION_ID = 'ok-report-2026-08-18-130000.zip';

const FAILED_RESULT: OkBugReportSendResult = {
  ok: false,
  reason: 'send-failed',
  fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=failed' },
};

/**
 * A bridge whose `send` resolves only when the test says so, so a test can
 * observe the in-flight operation before its outcome lands.
 */
function createDeferredBridge() {
  const calls: Parameters<BugReportSendBridge['send']>[0][] = [];
  const resolvers: ((result: OkBugReportSendResult) => void)[] = [];
  const bridge: BugReportSendBridge = {
    send(request) {
      calls.push(request);
      return new Promise<OkBugReportSendResult>((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  return {
    bridge,
    calls,
    /** Resolve the nth outstanding send and let the manager's continuation run. */
    async settle(result: OkBugReportSendResult, index = calls.length - 1) {
      resolvers[index]?.(result);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

function createdReport(zipPath = ZIP_PATH): CreatedBugReport {
  return {
    zipPath,
    zipSizeBytes: 2_048,
    summary: {
      level: 'full',
      systemWide: false,
      projectSlug: 'open-knowledge',
      files: ['logs/app.log'],
      redactions: [],
      redactedLineCount: 0,
      generatedAt: '2026-08-18T12:00:00.000Z',
    },
  };
}

function createdReportRequest(zipPath = ZIP_PATH): BugReportSendRequest {
  return {
    kind: 'created-report',
    report: createdReport(zipPath),
    note: 'the editor froze',
    includeScreenshot: true,
  };
}

function historyRow(overrides?: Partial<OkBugReportListRow>): OkBugReportListRow {
  return {
    id: OPERATION_ID,
    createdAt: '2026-08-18T12:00:00.000Z',
    bundleLevel: 'unknown',
    state: 'upload-failed',
    zipBytes: 4_096,
    zipDeleted: false,
    zipExists: true,
    systemWide: true,
    projectSlug: null,
    attemptsCount: 1,
    zipPath: ZIP_PATH,
    retryable: true,
    degraded: true,
    ...overrides,
  };
}

function sendingFill(operation: BugReportSendOperation | undefined): number {
  if (operation?.status !== 'sending') {
    throw new Error(`expected a sending operation, got ${String(operation?.status)}`);
  }
  return operation.fillPercent;
}

describe('bug-report send manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a successful send resolves the operation with its reference', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    const started = manager.startBugReportSend(createdReportRequest());
    expect(started.status).toBe('sending');
    expect(started.operationId).toBe(OPERATION_ID);
    expect(started.zipSizeBytes).toBe(2_048);

    await stub.settle({ ok: true, reference: 'OK-1234' });

    expect(manager.get(OPERATION_ID)).toEqual(
      expect.objectContaining({ status: 'sent', reference: 'OK-1234' }),
    );
  });

  test('the send carries the composed note and the reviewed screenshot consent', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());

    expect(stub.calls).toEqual([
      {
        zipPath: ZIP_PATH,
        metadata: {
          level: 'full',
          systemWide: false,
          projectSlug: 'open-knowledge',
          note: 'the editor froze',
        },
        includeScreenshot: true,
      },
    ]);
    await stub.settle(FAILED_RESULT);
  });

  test('a history row with no note sends no note key, and a readable bundle level', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    const started = manager.startBugReportSend({ kind: 'history-row', row: historyRow() });

    expect(started.zipSizeBytes).toBe(4_096);
    expect(stub.calls[0]).toEqual({
      zipPath: ZIP_PATH,
      metadata: { level: 'standard', systemWide: true, projectSlug: null },
    });
    // `toEqual` treats an explicit `note: undefined` as absent, so the key
    // itself is asserted separately: a row with no note must not send a
    // synthesized stand-in, and must not send an empty slot either.
    expect(stub.calls[0]?.metadata).not.toHaveProperty('note');
    await stub.settle(FAILED_RESULT);
  });

  test('a history retry resends the note persisted with the report', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend({
      kind: 'history-row',
      row: historyRow({ note: 'the editor froze after I pasted a large table' }),
    });

    expect(stub.calls[0]).toEqual({
      zipPath: ZIP_PATH,
      metadata: {
        level: 'standard',
        systemWide: true,
        projectSlug: null,
        note: 'the editor froze after I pasted a large table',
      },
    });
    await stub.settle(FAILED_RESULT);
  });

  test('the no-intake email draft resolves without failure framing', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    await stub.settle({
      ok: false,
      reason: 'email-draft',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=draft' },
    });

    expect(manager.get(OPERATION_ID)).toEqual(
      expect.objectContaining({
        status: 'email-draft',
        mailtoUrl: 'mailto:support@inkeep.com?subject=draft',
      }),
    );
  });

  test('a refused upload resolves to failure with the fallback draft', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    await stub.settle(FAILED_RESULT);

    expect(manager.get(OPERATION_ID)).toEqual(
      expect.objectContaining({
        status: 'failed',
        mailtoUrl: 'mailto:support@inkeep.com?subject=failed',
      }),
    );
  });

  test('a send already in flight elsewhere never resolves as a failure', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend({ kind: 'history-row', row: historyRow() });
    await stub.settle({
      ok: false,
      reason: 'send-in-flight',
      fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=inflight' },
    });

    expect(manager.get(OPERATION_ID)?.status).toBe('already-sending');
  });

  test('retrying a report already sending in this window issues no second send', () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    const first = manager.startBugReportSend(createdReportRequest());
    const joined = manager.startBugReportSend({ kind: 'history-row', row: historyRow() });

    expect(stub.calls).toHaveLength(1);
    expect(joined.status).toBe('sending');
    expect(joined.operationId).toBe(first.operationId);
    // The join has to be observable, or a toast the reporter dismissed mid-send
    // has no event to re-surface on and the retry reads as doing nothing.
    expect(joined.requestSeq).toBe(first.requestSeq + 1);
    expect(manager.getSnapshot()).toHaveLength(1);
  });

  test('retrying after a terminal outcome starts a fresh send on the same operation', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    await stub.settle(FAILED_RESULT);

    const retried = manager.startBugReportSend({ kind: 'history-row', row: historyRow() });

    expect(stub.calls).toHaveLength(2);
    expect(retried).toEqual(
      expect.objectContaining({ status: 'sending', fillPercent: 0, requestSeq: 2 }),
    );
    expect(manager.getSnapshot()).toHaveLength(1);

    await stub.settle({ ok: true, reference: 'OK-9' });
    expect(manager.get(OPERATION_ID)?.status).toBe('sent');
  });

  test('a failed operation retries from the request its last caller supplied', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    await stub.settle(FAILED_RESULT);

    // The toast offering "Try again" knows the operation id and nothing else.
    manager.retryBugReportSend(OPERATION_ID);

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]).toEqual(stub.calls[0]);
    expect(manager.get(OPERATION_ID)).toEqual(
      expect.objectContaining({ status: 'sending', requestSeq: 2 }),
    );

    await stub.settle({ ok: true, reference: 'OK-7' });
    expect(manager.get(OPERATION_ID)?.status).toBe('sent');
  });

  test('retrying a report already sending joins it, and an unknown report does nothing', () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    const started = manager.startBugReportSend(createdReportRequest());
    manager.retryBugReportSend(OPERATION_ID);

    expect(stub.calls).toHaveLength(1);
    expect(manager.get(OPERATION_ID)?.requestSeq).toBe(started.requestSeq + 1);

    manager.retryBugReportSend(OTHER_OPERATION_ID);

    expect(stub.calls).toHaveLength(1);
    expect(manager.get(OTHER_OPERATION_ID)).toBeUndefined();
  });

  test('a transport that throws resolves the operation instead of stranding it', async () => {
    const throwing: BugReportSendBridge = {
      send() {
        throw new Error('IPC channel closed');
      },
    };
    const manager = createBugReportSendManager(() => throwing);

    manager.startBugReportSend(createdReportRequest());
    await vi.advanceTimersByTimeAsync(0);

    // No fallback draft: main composes one as part of its result, and a call
    // that never returned has none to offer.
    expect(manager.get(OPERATION_ID)).toEqual({
      operationId: OPERATION_ID,
      zipPath: ZIP_PATH,
      zipSizeBytes: 2_048,
      requestSeq: 1,
      status: 'failed',
    });
  });

  test('a send with no desktop bridge resolves rather than hanging', async () => {
    const manager = createBugReportSendManager(() => undefined);

    manager.startBugReportSend(createdReportRequest());
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.get(OPERATION_ID)?.status).toBe('failed');
  });

  test('progress eases upward while the send is in flight and never claims completion', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    expect(sendingFill(manager.get(OPERATION_ID))).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendingFill(manager.get(OPERATION_ID))).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendingFill(manager.get(OPERATION_ID))).toBe(90);

    // Once the curve flattens the operation must stop changing identity, or a
    // subscribed toast re-renders five times a second for the rest of a long
    // upload with nothing new to show.
    const saturated = manager.get(OPERATION_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.get(OPERATION_ID)).toBe(saturated);

    await stub.settle({ ok: true, reference: 'OK-1234' });
  });

  test('a resolved operation stops ticking and leaves no timer behind', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);
    let notifications = 0;
    manager.subscribe(() => {
      notifications += 1;
    });

    manager.startBugReportSend(createdReportRequest());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);

    await stub.settle({ ok: true, reference: 'OK-1234' });
    const afterSettle = notifications;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(notifications).toBe(afterSettle);
    expect(manager.get(OPERATION_ID)?.status).toBe('sent');
  });

  test('repeated reads return the same object until the operation changes', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    const first = manager.get(OPERATION_ID);
    expect(manager.get(OPERATION_ID)).toBe(first);
    expect(manager.getSnapshot()).toBe(manager.getSnapshot());

    await stub.settle({ ok: true, reference: 'OK-1234' });

    expect(manager.get(OPERATION_ID)).not.toBe(first);
    const settled = manager.get(OPERATION_ID);
    expect(manager.get(OPERATION_ID)).toBe(settled);
  });

  test('two different reports send as independent operations', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    manager.startBugReportSend(createdReportRequest(OTHER_ZIP_PATH));

    expect(stub.calls.map((call) => call.zipPath)).toEqual([ZIP_PATH, OTHER_ZIP_PATH]);
    expect(manager.getSnapshot()).toHaveLength(2);

    await stub.settle({ ok: true, reference: 'OK-1' }, 0);

    expect(manager.get(OPERATION_ID)?.status).toBe('sent');
    expect(manager.get(OTHER_OPERATION_ID)?.status).toBe('sending');

    await stub.settle(FAILED_RESULT, 1);

    expect(manager.get(OTHER_OPERATION_ID)?.status).toBe('failed');
  });

  test('the factory hands each caller an independent set of operations', () => {
    const manager = createBugReportSendManager(() => undefined);

    manager.startBugReportSend(createdReportRequest());

    expect(manager.get(OPERATION_ID)).toBeDefined();
    expect(bugReportSendManager.get(OPERATION_ID)).toBeUndefined();
  });
});

describe('bug-report send manager — subscriber isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('one throwing subscriber does not silence the others', async () => {
    // Both the toast adapter and React's useSyncExternalStore trigger live in
    // this list. If the adapter throws first and the loop is unguarded, the
    // store never re-reads and the toast stays at 'sending' behind an infinite
    // duration - the exact state this module's contract promises to avoid.
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let reachedSecond = 0;
    manager.subscribe(() => {
      throw new Error('adapter blew up');
    });
    manager.subscribe(() => {
      reachedSecond += 1;
    });

    manager.startBugReportSend(createdReportRequest());
    await stub.settle({ ok: true, reference: 'OK-ISO' });

    expect(reachedSecond).toBeGreaterThan(0);
    expect(manager.get(OPERATION_ID)?.status).toBe('sent');
    warn.mockRestore();
  });
});

describe('bug-report send manager — per-attempt tracing', () => {
  /**
   * A real SDK, because the claim is about span LIFETIME across a retry and an
   * inert no-op handle records nothing to check. The manager's other suites run
   * with no provider registered, which is exactly why this defect survived
   * them: every span call was a silent no-op there.
   */
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    // Without a propagator `inject` is a no-op and every traceparent comes back
    // undefined — the encoding under test is the one main parses on the far
    // side of the IPC boundary, so use the real W3C one.
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await provider.shutdown();
    trace.disable();
    propagation.disable();
  });

  test('a failed send that succeeds on retry is not recorded as a failure', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    await stub.settle(FAILED_RESULT);
    manager.retryBugReportSend(OPERATION_ID);
    await stub.settle({ ok: true, reference: 'OK-RETRY' });

    const outcomes = exporter
      .getFinishedSpans()
      .map((sp) => sp.attributes['ok.bug_report.renderer_outcome']);

    // One span per ATTEMPT. Sharing a span across the retry would end it at the
    // failure and silently drop everything after, so the report that actually
    // succeeded would read as failed for ever.
    expect(outcomes).toEqual(['failed', 'sent']);
  });

  test('each attempt injects a traceparent naming its own live span', async () => {
    const stub = createDeferredBridge();
    const manager = createBugReportSendManager(() => stub.bridge);

    manager.startBugReportSend(createdReportRequest());
    await stub.settle(FAILED_RESULT);
    manager.retryBugReportSend(OPERATION_ID);
    await stub.settle({ ok: true, reference: 'OK-RETRY' });

    const sent = stub.calls.map((c) => (c as { traceparent?: string }).traceparent);
    expect(sent[0]).toBeDefined();
    expect(sent[1]).toBeDefined();
    // A reused span would hand main the SAME header twice, parenting the
    // retry's transport work under a span that had already ended.
    expect(sent[0]).not.toBe(sent[1]);
  });
});
