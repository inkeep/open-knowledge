/**
 * Toast presentation for background bug-report sends.
 *
 * The send manager owns the send; this module owns nothing but the toast that
 * describes it. It watches the manager, mints one toast per operation, and
 * turns the toast's action callbacks into bridge calls — so the toast body
 * itself never reaches for the desktop bridge.
 *
 * Two sonner mechanics shape the whole design:
 *
 *   - `toast.custom` invokes its render function exactly once and stores the
 *     element it returned. Content updates therefore come from the body's own
 *     subscription, not from here; re-minting on every progress tick would
 *     replace that element five times a second for nothing visible.
 *   - Sonner measures a toast's height in a layout effect keyed on props a
 *     body's internal re-render never touches. A layout that grows taller
 *     without a fresh element keeps its old measurement, so the toasts stacked
 *     beneath it overlap and the expanded toaster clips it.
 *
 * Hence the rule below: never re-mint on progress, always re-mint on a layout
 * change. Sonner treats a create at an existing id as an update — same React
 * key, so the body stays mounted with its subscription intact — and clears
 * that id from its dismissed set, which is also what brings back a toast the
 * reporter dismissed before pressing Retry.
 *
 * Installed from `main.tsx` module init alongside the other desktop listeners.
 */

import { createElement } from 'react';
import { toast } from 'sonner';
import {
  BugReportSendToast,
  type BugReportSendToastActions,
} from '@/components/BugReportSendToast';
import {
  type BugReportSendManager,
  type BugReportSendOperation,
  bugReportSendManager,
} from '@/lib/bug-report-send-manager';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';

/**
 * Long enough to read a reference and copy it, short enough that a finished
 * send stops occupying the corner. Nothing is lost when it closes — the
 * reference stays on the report's history row.
 */
const RESOLVED_AUTO_DISMISS_MS = 8_000;

function durationFor(status: BugReportSendOperation['status']): number {
  switch (status) {
    case 'sent':
    case 'already-sending':
      // Neither asks the reporter for anything, so neither has to wait to be
      // read: the reference lives on the history row, and a send already in
      // flight resolves on its own.
      return RESOLVED_AUTO_DISMISS_MS;
    case 'sending':
    case 'email-draft':
    case 'failed':
      // Progress holds until it resolves; the two outcomes that hold each
      // carry an action nobody can take once the toast has closed itself.
      return Number.POSITIVE_INFINITY;
  }
}

/** What the toast on screen is showing, so a layout change is distinguishable from a progress tick. */
interface RenderedLayout {
  readonly status: BugReportSendOperation['status'];
  readonly requestSeq: number;
}

export interface InstallBugReportSendToastsOptions {
  /** Defaults to the module singleton every send surface starts its operation on. */
  readonly manager?: BugReportSendManager;
  /** Desktop bridge behind the toast's actions. Absent in web / CLI distribution. */
  readonly bridge?: OkDesktopBridge;
}

/** Returns the unsubscribe, so a test can detach the adapter it installed. */
/**
 * Guards the SINGLETON path only. `main.tsx` is re-evaluated on HMR, and a
 * second subscriber against the same manager would mint every toast twice.
 * Tests inject their own manager and legitimately install more than once, so
 * the flag is keyed on identity rather than set unconditionally — matching the
 * `attached` guard in `crash-invite-store.ts` without breaking injection.
 */
let attachedToSingleton = false;

export function installBugReportSendToasts(
  options: InstallBugReportSendToastsOptions = {},
): () => void {
  const manager = options.manager ?? bugReportSendManager;
  if (manager === bugReportSendManager) {
    if (attachedToSingleton) return () => {};
    attachedToSingleton = true;
  }
  const bridge = options.bridge;
  const rendered = new Map<string, RenderedLayout>();

  function actionsFor(operationId: string): BugReportSendToastActions {
    return {
      dismiss: () => {
        toast.dismiss(operationId);
      },
      retry: () => {
        manager.retryBugReportSend(operationId);
      },
      openExternal: (url) => {
        void bridge?.shell.openExternal(url);
      },
      revealInFileManager: (zipPath) => {
        void bridge?.shell.showItemInFolder(zipPath);
      },
      writeToClipboard: scheduleClipboardWrite,
    };
  }

  function mint(operation: BugReportSendOperation): void {
    const { operationId, status, requestSeq } = operation;
    // The operation id doubles as the toast id: sonner's own ids are numbers
    // from an internal counter, so a zip basename cannot collide with one, and
    // sharing the id is what makes an update-in-place possible.
    toast.custom(
      () =>
        createElement(BugReportSendToast, {
          operationId,
          manager,
          actions: actionsFor(operationId),
          platform: bridge?.platform,
        }),
      { id: operationId, duration: durationFor(status) },
    );
    rendered.set(operationId, { status, requestSeq });
  }

  const unsubscribe = manager.subscribe(() => {
    for (const operation of manager.getSnapshot()) {
      const shown = rendered.get(operation.operationId);
      if (
        shown !== undefined &&
        shown.status === operation.status &&
        shown.requestSeq === operation.requestSeq
      ) {
        continue;
      }
      mint(operation);
    }
  });

  return () => {
    unsubscribe();
    if (manager === bugReportSendManager) attachedToSingleton = false;
  };
}
