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

const RESOLVED_AUTO_DISMISS_MS = 8_000;

function durationFor(status: BugReportSendOperation['status']): number {
  switch (status) {
    case 'sent':
    case 'already-sending':
      return RESOLVED_AUTO_DISMISS_MS;
    case 'sending':
    case 'email-draft':
    case 'failed':
      return Number.POSITIVE_INFINITY;
  }
}

interface RenderedLayout {
  readonly status: BugReportSendOperation['status'];
  readonly requestSeq: number;
}

export interface InstallBugReportSendToastsOptions {
  readonly manager?: BugReportSendManager;
  readonly bridge?: OkDesktopBridge;
}

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
