import type {
  OkBugReportListRow,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import {
  type BugReportSendSpan,
  beginBugReportSendSpan,
  INERT_SEND_SPAN,
} from '@/lib/bug-report-send-otel';
import { zipBasename } from '@/lib/bug-report-support';
import { type ContactEmailStore, contactEmailStore } from '@/lib/contact-email-store';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export type BugReportSendBridge = Pick<OkDesktopBridge['bugReport'], 'send'>;

const FILL_STEP_MS = 200;
const FILL_TIME_CONSTANT_SECONDS = 3;
const FILL_CEILING = 0.9;

interface BugReportSendOperationBase {
  readonly operationId: string;
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  readonly requestSeq: number;
}

export type BugReportSendOperation =
  | (BugReportSendOperationBase & {
      readonly status: 'sending';
      readonly fillPercent: number;
    })
  | (BugReportSendOperationBase & { readonly status: 'sent'; readonly reference: string })
  | (BugReportSendOperationBase & { readonly status: 'email-draft'; readonly mailtoUrl: string })
  | (BugReportSendOperationBase & {
      readonly status: 'failed';
      readonly mailtoUrl?: string;
    })
  | (BugReportSendOperationBase & { readonly status: 'already-sending' });

export interface CreatedBugReport {
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  readonly summary: ReportBundleSummary;
}

export type BugReportSendRequest =
  | {
      readonly kind: 'created-report';
      readonly report: CreatedBugReport;
      readonly note?: string;
      readonly includeScreenshot: boolean;
      readonly includeAttachments?: boolean;
      readonly email?: string;
    }
  | { readonly kind: 'history-row'; readonly row: OkBugReportListRow };

export interface BugReportSendManager {
  startBugReportSend(request: BugReportSendRequest): BugReportSendOperation;
  retryBugReportSend(operationId: string): void;
  get(operationId: string): BugReportSendOperation | undefined;
  getSnapshot(): readonly BugReportSendOperation[];
  subscribe(listener: () => void): () => void;
}

interface SendInput {
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  readonly metadata: OkBugReportSendMetadata;
  readonly includeScreenshot?: boolean;
  readonly includeAttachments?: boolean;
}

function toSendInput(
  request: BugReportSendRequest,
  store: ContactEmailStore = contactEmailStore,
): SendInput {
  if (request.kind === 'history-row') {
    const { row } = request;
    const remembered = store.getSnapshot().email;
    return {
      zipPath: row.zipPath,
      zipSizeBytes: row.zipBytes,
      metadata: {
        level: row.bundleLevel === 'unknown' ? 'standard' : row.bundleLevel,
        systemWide: row.systemWide,
        projectSlug: row.projectSlug,
        ...(row.note !== undefined ? { note: row.note } : {}),
        ...(remembered !== null ? { email: remembered } : {}),
      },
    };
  }
  const { report, note, includeScreenshot, includeAttachments, email } = request;
  return {
    zipPath: report.zipPath,
    zipSizeBytes: report.zipSizeBytes,
    metadata: {
      level: report.summary.level,
      systemWide: report.summary.systemWide,
      projectSlug: report.summary.projectSlug,
      note,
      ...(email !== undefined ? { email } : {}),
    },
    includeScreenshot,
    ...(includeAttachments !== undefined ? { includeAttachments } : {}),
  };
}

interface OperationRecord {
  readonly operationId: string;
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  requestSeq: number;
  input: SendInput;
  fillTimer: ReturnType<typeof setInterval> | null;
  state: BugReportSendOperation;
  span: BugReportSendSpan;
}

export function createBugReportSendManager(
  getBridge: () => BugReportSendBridge | undefined,
  emailStore: ContactEmailStore = contactEmailStore,
): BugReportSendManager {
  const records = new Map<string, OperationRecord>();
  const listeners = new Set<() => void>();
  let snapshot: readonly BugReportSendOperation[] | null = null;

  function notify(): void {
    for (const l of listeners) {
      try {
        l();
      } catch (err) {
        console.warn('[bug-report-send] subscriber threw:', err);
      }
    }
  }

  function publish(record: OperationRecord, state: BugReportSendOperation): void {
    record.state = state;
    snapshot = null;
    notify();
  }

  function base(record: OperationRecord): BugReportSendOperationBase {
    return {
      operationId: record.operationId,
      zipPath: record.zipPath,
      zipSizeBytes: record.zipSizeBytes,
      requestSeq: record.requestSeq,
    };
  }

  function stopFill(record: OperationRecord): void {
    if (record.fillTimer === null) return;
    clearInterval(record.fillTimer);
    record.fillTimer = null;
  }

  function startFill(record: OperationRecord): void {
    stopFill(record);
    const startedAt = Date.now();
    record.fillTimer = setInterval(() => {
      if (record.state.status !== 'sending') {
        stopFill(record);
        return;
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const eased = Math.min(
        FILL_CEILING,
        1 - Math.exp(-elapsedSeconds / FILL_TIME_CONSTANT_SECONDS),
      );
      const fillPercent = Math.round(eased * 100);
      if (fillPercent === record.state.fillPercent) return;
      publish(record, { ...base(record), status: 'sending', fillPercent });
    }, FILL_STEP_MS);
  }

  function settle(
    record: OperationRecord,
    outcome:
      | { status: 'sent'; reference: string }
      | { status: 'email-draft'; mailtoUrl: string }
      | { status: 'failed'; mailtoUrl?: string }
      | { status: 'already-sending' },
  ): void {
    stopFill(record);
    record.span.end(
      outcome.status === 'email-draft'
        ? 'email-drafted'
        : outcome.status === 'already-sending'
          ? 'joined'
          : outcome.status,
      { 'ok.bug_report.request_seq': record.requestSeq },
    );
    publish(record, { ...base(record), ...outcome });
  }

  function settleFromResult(record: OperationRecord, result: OkBugReportSendResult): void {
    if (result.ok) {
      settle(record, { status: 'sent', reference: result.reference });
      return;
    }
    if (result.reason === 'email-draft') {
      settle(record, { status: 'email-draft', mailtoUrl: result.fallback.mailtoUrl });
      return;
    }
    if (result.reason === 'send-in-flight') {
      settle(record, { status: 'already-sending' });
      return;
    }
    settle(record, { status: 'failed', mailtoUrl: result.fallback.mailtoUrl });
  }

  function beginSend(record: OperationRecord): void {
    record.span = beginBugReportSendSpan({
      'ok.bug_report.zip_bytes': record.input.zipSizeBytes,
      'ok.bug_report.include_screenshot': record.input.includeScreenshot === true,
      'ok.bug_report.attempt': record.requestSeq,
    });
    publish(record, { ...base(record), status: 'sending', fillPercent: 0 });
    startFill(record);
    void dispatch(record, record.input);
  }

  function requestSend(record: OperationRecord): BugReportSendOperation {
    record.requestSeq += 1;
    if (record.state.status === 'sending') {
      publish(record, {
        ...base(record),
        status: 'sending',
        fillPercent: record.state.fillPercent,
      });
      return record.state;
    }
    beginSend(record);
    return record.state;
  }

  async function dispatch(record: OperationRecord, input: SendInput): Promise<void> {
    try {
      const bridge = getBridge();
      if (bridge === undefined) {
        console.warn('[bug-report-send] no desktop bridge; send cannot be dispatched');
        settle(record, { status: 'failed' });
        return;
      }
      const traceparent = record.span.traceparent();
      const result = await bridge.send({
        zipPath: input.zipPath,
        metadata: input.metadata,
        ...(input.includeScreenshot !== undefined
          ? { includeScreenshot: input.includeScreenshot }
          : {}),
        ...(input.includeAttachments !== undefined
          ? { includeAttachments: input.includeAttachments }
          : {}),
        ...(traceparent === undefined ? {} : { traceparent }),
      });
      settleFromResult(record, result);
    } catch (err) {
      console.warn('[bug-report-send] IPC dispatch threw:', err);
      settle(record, { status: 'failed' });
    }
  }

  return {
    startBugReportSend(request): BugReportSendOperation {
      const input = toSendInput(request, emailStore);
      const operationId = zipBasename(input.zipPath);
      const existing = records.get(operationId);

      if (existing !== undefined) {
        existing.input = input;
        return requestSend(existing);
      }

      const firstBase: BugReportSendOperationBase = {
        operationId,
        zipPath: input.zipPath,
        zipSizeBytes: input.zipSizeBytes,
        requestSeq: 1,
      };
      const record: OperationRecord = {
        ...firstBase,
        input,
        fillTimer: null,
        state: { ...firstBase, status: 'sending', fillPercent: 0 },
        span: INERT_SEND_SPAN,
      };
      records.set(operationId, record);
      beginSend(record);
      return record.state;
    },

    retryBugReportSend(operationId): void {
      const record = records.get(operationId);
      if (record === undefined) return;
      requestSend(record);
    },

    get(operationId): BugReportSendOperation | undefined {
      return records.get(operationId)?.state;
    },

    getSnapshot(): readonly BugReportSendOperation[] {
      snapshot ??= [...records.values()].map((record) => record.state);
      return snapshot;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const bugReportSendManager: BugReportSendManager = createBugReportSendManager(
  () => window.okDesktop?.bugReport,
);
