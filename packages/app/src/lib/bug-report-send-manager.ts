/**
 * Background bug-report send operations.
 *
 * A send outlives the surface that started it. The report dialog has seven
 * independent mount points and closes the instant the reporter presses Send, so
 * an in-flight promise owned by any React subtree loses its result the moment
 * that subtree unmounts. This module owns the send instead: a module-level
 * singleton with no React dependency, which the progress toast merely observes
 * through `subscribe` / `get`.
 *
 * Named `-manager`, not `-store`, and the split is deliberate: the peers in
 * this directory (`crash-invite-store`, `update-notices-store`,
 * `subscribe-card-store`) are passive reactive containers that something else
 * writes into. This one EXECUTES the operation it publishes — it issues the
 * IPC call, owns retry and join semantics, and drives a timer — so calling it
 * a store would misdescribe what it does. Use `-store` for state alone,
 * `-manager` for a command executor that also happens to be observable.
 *
 * Operations are keyed by the zip basename because Electron main derives the
 * report id from the same path the same way, so an operation here and the
 * report's on-disk sidecar name the same thing. `zipBasename` is imported
 * rather than re-spelled for exactly that reason.
 *
 * Nothing here aborts a send — the IPC call has no cancel path. An observer
 * that stops watching (a dismissed toast) only stops watching; the upload
 * continues and its outcome still reaches the report's history row.
 */

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
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/** The one bridge call this module makes. Narrow so a test stub is one function. */
export type BugReportSendBridge = Pick<OkDesktopBridge['bugReport'], 'send'>;

/** Ease toward 90% and let the terminal state deliver the rest. */
const FILL_STEP_MS = 200;
const FILL_TIME_CONSTANT_SECONDS = 3;
const FILL_CEILING = 0.9;

interface BugReportSendOperationBase {
  /** Zip basename — the same string Electron main uses as the report id. */
  readonly operationId: string;
  readonly zipPath: string;
  /** On-disk bundle size: the only measured number the toast is allowed to show. */
  readonly zipSizeBytes: number;
  /**
   * Increments every time a caller asks to send this report — a first send, a
   * join with the send already in flight, or a retry after a terminal state.
   * An observer needs it to tell "the reporter asked for this again" (re-surface
   * the toast, even if it was dismissed) from "the progress bar moved".
   */
  readonly requestSeq: number;
}

/**
 * `already-sending` is not a failure: main refused a duplicate upload because
 * the same bundle is mid-flight, typically from another window holding a stale
 * retryable row. Rendering it as a failure would report a send that is still
 * running as broken.
 */
export type BugReportSendOperation =
  | (BugReportSendOperationBase & {
      readonly status: 'sending';
      /** Eased 0-90; motion only, never a measured fraction of bytes uploaded. */
      readonly fillPercent: number;
    })
  | (BugReportSendOperationBase & { readonly status: 'sent'; readonly reference: string })
  | (BugReportSendOperationBase & { readonly status: 'email-draft'; readonly mailtoUrl: string })
  | (BugReportSendOperationBase & {
      readonly status: 'failed';
      /**
       * Absent when the transport itself threw: main composes the fallback
       * draft as part of its result, so a call that never returned one has no
       * draft to offer.
       */
      readonly mailtoUrl?: string;
    })
  | (BugReportSendOperationBase & { readonly status: 'already-sending' });

/** A bundle `create` just produced, still under review when Send is pressed. */
export interface CreatedBugReport {
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  readonly summary: ReportBundleSummary;
}

/**
 * The two surfaces that start a send hold different things. The dialog holds a
 * freshly created bundle plus the note it composed; history holds a persisted
 * row whose note is the sidecar's copy of that same text — absent for reports
 * generated before it was persisted — and a bundle level that may be
 * unreadable.
 */
export type BugReportSendRequest =
  | {
      readonly kind: 'created-report';
      readonly report: CreatedBugReport;
      /** Already composed from the typed note plus any crash context. */
      readonly note?: string;
      /** Consent read off the reviewed bundle inventory, not off the checkbox. */
      readonly includeScreenshot: boolean;
    }
  | { readonly kind: 'history-row'; readonly row: OkBugReportListRow };

export interface BugReportSendManager {
  /**
   * Start (or join) the send for the request's bundle and return its operation.
   * Never throws and never rejects: every failure mode resolves the operation
   * instead. A request whose report is already sending issues no second IPC
   * call — it bumps `requestSeq` on the running operation and returns it.
   */
  startBugReportSend(request: BugReportSendRequest): BugReportSendOperation;
  /**
   * Send the same bundle again, reusing the request the last caller supplied.
   * The toast that offers **Try again** observes operations, not requests, so
   * an operation id is all it can name. No-op for an id this renderer never
   * started; joins rather than restarts while the send is still running.
   */
  retryBugReportSend(operationId: string): void;
  /** The operation for a zip basename, or undefined if none was ever started. */
  get(operationId: string): BugReportSendOperation | undefined;
  /** Every operation this renderer has started, newest last. */
  getSnapshot(): readonly BugReportSendOperation[];
  subscribe(listener: () => void): () => void;
}

interface SendInput {
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  readonly metadata: OkBugReportSendMetadata;
  readonly includeScreenshot?: boolean;
}

function toSendInput(request: BugReportSendRequest): SendInput {
  if (request.kind === 'history-row') {
    const { row } = request;
    return {
      zipPath: row.zipPath,
      zipSizeBytes: row.zipBytes,
      metadata: {
        // A row with no readable sidecar reports 'unknown'. Main needs a real
        // level, and 'standard' is the one that cannot overclaim what the
        // bundle on disk contains.
        level: row.bundleLevel === 'unknown' ? 'standard' : row.bundleLevel,
        systemWide: row.systemWide,
        projectSlug: row.projectSlug,
        // The sidecar's copy, so a retry puts the same words on the wire the
        // original send did. Absence is data: a pre-change row or a CLI bundle
        // has no note and retries without one rather than with a stand-in.
        ...(row.note !== undefined ? { note: row.note } : {}),
      },
    };
  }
  const { report, note, includeScreenshot } = request;
  return {
    zipPath: report.zipPath,
    zipSizeBytes: report.zipSizeBytes,
    metadata: {
      level: report.summary.level,
      systemWide: report.summary.systemWide,
      projectSlug: report.summary.projectSlug,
      note,
    },
    includeScreenshot,
  };
}

/** Private bookkeeping. `state` is the cached object every reader shares. */
interface OperationRecord {
  readonly operationId: string;
  readonly zipPath: string;
  readonly zipSizeBytes: number;
  requestSeq: number;
  /**
   * The most recent caller's request, kept so a retry can re-send from an
   * operation id alone rather than needing a caller that still holds it.
   */
  input: SendInput;
  fillTimer: ReturnType<typeof setInterval> | null;
  state: BugReportSendOperation;
  /**
   * This operation's own span. Held per record rather than looked up, so two
   * sends in flight cannot pick up each other's context when injecting the
   * traceparent main parents under.
   */
  span: BugReportSendSpan;
}

/**
 * Factory so each test gets a fresh manager. Production code uses the
 * `bugReportSendManager` singleton exported below.
 */
export function createBugReportSendManager(
  getBridge: () => BugReportSendBridge | undefined,
): BugReportSendManager {
  const records = new Map<string, OperationRecord>();
  const listeners = new Set<() => void>();
  let snapshot: readonly BugReportSendOperation[] | null = null;

  function notify(): void {
    // One throwing subscriber must not silence the rest. The adapter that
    // mints toasts and React's useSyncExternalStore trigger are both in this
    // list; if the adapter throws first, the store never re-reads and the
    // toast stays stuck at 'sending' behind an infinite duration, which is the
    // one state this module promises callers it will never leave them in.
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
      // Nothing visible changed between two ticks at the same rounded percent,
      // so leave the published object alone and keep its identity stable.
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
    // Deliberately not exhaustive: a reason this build does not recognize comes
    // from a newer main process, and the safe reading of an unknown refusal is
    // that the report did not go out. A new reason that is NOT a failure has to
    // be handled above before it ships.
    settle(record, { status: 'failed', mailtoUrl: result.fallback.mailtoUrl });
  }

  /** Publish the running state, restart the eased fill, and send. */
  function beginSend(record: OperationRecord): void {
    // A fresh span per ATTEMPT, not per operation. `settle` ends the span at
    // every terminal state, including a retryable failure, and `end()` is
    // idempotent — so reusing one span across a retry would silently discard
    // the retry's outcome and hand main a traceparent naming an already-closed
    // span, leaving its transport child starting after its parent ended. A
    // report that failed and then succeeded on Try again would read, for ever,
    // as a failure. Retry is the reason the failure toast exists, so the
    // attempt it starts has to be traceable on its own terms.
    record.span = beginBugReportSendSpan({
      'ok.bug_report.zip_bytes': record.input.zipSizeBytes,
      'ok.bug_report.include_screenshot': record.input.includeScreenshot === true,
      'ok.bug_report.attempt': record.requestSeq,
    });
    publish(record, { ...base(record), status: 'sending', fillPercent: 0 });
    startFill(record);
    void dispatch(record, record.input);
  }

  /**
   * A caller asked for this bundle again. Bump the counter first so an
   * observer can tell "asked again" from "the bar moved" even when the answer
   * is a join — a toast the reporter dismissed has no other event to come back
   * on.
   */
  function requestSend(record: OperationRecord): BugReportSendOperation {
    record.requestSeq += 1;
    if (record.state.status === 'sending') {
      // Joining, not restarting: a second upload of the same bundle is what
      // main's in-flight lock refuses, and refusing it here spares the round
      // trip.
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
      // A renderer paired with a main process that predates the bug-report IPC
      // has no `bugReport` surface, so the typed-required property can be
      // missing at runtime.
      const bridge = getBridge();
      if (bridge === undefined) {
        // Expected on web/CLI builds, alarming on desktop. Distinguishing the
        // two costs one line and is the whole point of this change: without it
        // a missing bridge and a main-process crash below are one identical,
        // silent `failed`.
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
        ...(traceparent === undefined ? {} : { traceparent }),
      });
      settleFromResult(record, result);
    } catch (err) {
      // `send` is contract-bound never to reject, but it crosses into another
      // process: a main that dies mid-call tears the IPC channel down and the
      // pending invoke rejects. Without this the operation would stay 'sending'
      // forever behind an infinite-duration toast.
      //
      // Logged rather than swallowed: this is the one renderer-side failure
      // with no other trace, and it means something considerably worse than a
      // refused upload.
      console.warn('[bug-report-send] IPC dispatch threw:', err);
      settle(record, { status: 'failed' });
    }
  }

  return {
    startBugReportSend(request): BugReportSendOperation {
      const input = toSendInput(request);
      const operationId = zipBasename(input.zipPath);
      const existing = records.get(operationId);

      if (existing !== undefined) {
        // The newest caller can hold fresher metadata for the same bundle — a
        // history retry after a dialog send — so a later retry uses it.
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
        // Replaced immediately by `beginSend`, which opens the real span for
        // every attempt including this first one.
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

/** Module-level singleton — every send surface starts its operation here. */
export const bugReportSendManager: BugReportSendManager = createBugReportSendManager(
  () => window.okDesktop?.bugReport,
);
