import {
  emitPreflightFailureSpan,
  type GitDetected,
  GitNotAvailableError,
  GitProbeTimeoutError,
  GitTooOldError,
} from '@inkeep/open-knowledge-server';

export type EnsureGitOutcome = 'ok' | 'recovered' | 'aborted';

export interface MessageBoxOptions {
  readonly type: 'warning' | 'info' | 'error';
  readonly buttons: readonly string[];
  readonly defaultId?: number;
  readonly cancelId?: number;
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
}

export interface MessageBoxReturnValue {
  readonly response: number;
}

export interface EnsureGitDeps {
  readonly assertGitAvailable: () => GitDetected;
  readonly showMessageBox: (opts: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly log?: {
    readonly warn: (msg: string, obj?: Readonly<Record<string, unknown>>) => void;
    readonly info?: (msg: string, obj?: Readonly<Record<string, unknown>>) => void;
  };
}

type DialogAction = 'open-install-page' | 'retry' | 'quit';

interface DialogButton {
  readonly action: DialogAction;
  readonly label: string;
}

const INSTALL_BUTTONS = [
  { action: 'open-install-page', label: 'Open Install Page' },
  { action: 'retry', label: "I've Installed Git — Retry" },
  { action: 'quit', label: 'Quit' },
] as const satisfies readonly DialogButton[];

const PROBE_TIMEOUT_BUTTONS = [
  { action: 'retry', label: 'Retry' },
  { action: 'quit', label: 'Quit' },
] as const satisfies readonly DialogButton[];

interface PreflightDialog {
  readonly title: string;
  readonly message: string;
  readonly waitingLog: string;
  readonly buttons: readonly DialogButton[];
}

function preflightDialog(
  err: GitNotAvailableError | GitProbeTimeoutError | GitTooOldError,
): PreflightDialog {
  if (err instanceof GitProbeTimeoutError) {
    return {
      title: 'Git probe timed out',
      message: `OpenKnowledge could not verify ${err.guidance.product} because the Git probe timed out.`,
      waitingLog: 'ensureGitAvailable: git probe timed out, startup is waiting on the retry dialog',
      buttons: PROBE_TIMEOUT_BUTTONS,
    };
  }
  if (err instanceof GitTooOldError) {
    return {
      title: 'Git too old',
      message: `OpenKnowledge requires ${err.guidance.product} ${err.required} or newer.`,
      waitingLog: 'ensureGitAvailable: git unavailable, startup is waiting on the install dialog',
      buttons: INSTALL_BUTTONS,
    };
  }
  return {
    title: 'Git not found',
    message: `OpenKnowledge needs ${err.guidance.product} to track changes to your knowledge base.`,
    waitingLog: 'ensureGitAvailable: git unavailable, startup is waiting on the install dialog',
    buttons: INSTALL_BUTTONS,
  };
}

function preflightFailureFields(err: GitNotAvailableError | GitProbeTimeoutError | GitTooOldError) {
  if (err instanceof GitTooOldError) {
    return {
      code: err.code,
      platform: err.platform,
      detected: err.detected,
      required: err.required,
      resolvedPath: err.resolvedPath,
    };
  }
  if (err instanceof GitProbeTimeoutError) {
    return {
      code: err.code,
      platform: err.platform,
      pathProbe: err.probe.path,
      fallbackProbe: err.probe.fallback,
    };
  }
  return {
    code: err.code,
    platform: err.platform,
    pathProbe: err.probe?.path ?? null,
    fallbackProbe: err.probe?.fallback ?? null,
  };
}

type PreflightAttempt =
  | { kind: 'ok'; detection: GitDetected }
  | { kind: 'typed'; err: GitNotAvailableError | GitProbeTimeoutError | GitTooOldError }
  | { kind: 'unknown'; err: Error };

async function showUnknownErrorDialog(deps: EnsureGitDeps, err: Error): Promise<void> {
  try {
    await deps.showMessageBox({
      type: 'error',
      buttons: ['Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'OpenKnowledge could not start',
      message: 'An unexpected error occurred during startup.',
      detail: err.message,
    });
  } catch (dialogErr) {
    deps.log?.warn('ensureGitAvailable: unknown-error dialog failed', {
      err: dialogErr,
    });
  }
}

function tryPreflight(fn: () => GitDetected): PreflightAttempt {
  try {
    return { kind: 'ok', detection: fn() };
  } catch (err) {
    if (
      err instanceof GitNotAvailableError ||
      err instanceof GitProbeTimeoutError ||
      err instanceof GitTooOldError
    ) {
      return { kind: 'typed', err };
    }
    return { kind: 'unknown', err: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function ensureGitAvailable(deps: EnsureGitDeps): Promise<EnsureGitOutcome> {
  const first = tryPreflight(deps.assertGitAvailable);
  if (first.kind === 'ok') return 'ok';
  if (first.kind === 'unknown') {
    deps.log?.warn('ensureGitAvailable: unexpected error from preflight', {
      err: first.err.message,
    });
    await showUnknownErrorDialog(deps, first.err);
    return 'aborted';
  }

  emitPreflightFailureSpan(first.err);
  let currentErr = first.err;
  let failedInstallUrl: string | null = null;
  while (true) {
    const dialog = preflightDialog(currentErr);
    const offersInstallPage = dialog.buttons.some(
      (button) => button.action === 'open-install-page',
    );
    const detail =
      failedInstallUrl === null || !offersInstallPage
        ? currentErr.message
        : `${currentErr.message}\n\nCould not open browser automatically. Please visit: ${failedInstallUrl}`;
    deps.log?.warn(dialog.waitingLog, preflightFailureFields(currentErr));
    const result = await deps.showMessageBox({
      type: 'warning',
      buttons: dialog.buttons.map((button) => button.label),
      defaultId: dialog.buttons.findIndex((button) => button.action === 'retry'),
      cancelId: dialog.buttons.findIndex((button) => button.action === 'quit'),
      title: dialog.title,
      message: dialog.message,
      detail,
    });
    const action = dialog.buttons[result.response]?.action;
    deps.log?.info?.('ensureGitAvailable: install dialog answered', {
      response: action ?? result.response,
    });

    if (action === 'open-install-page') {
      try {
        await deps.openExternal(currentErr.guidance.url);
        failedInstallUrl = null;
      } catch (err) {
        deps.log?.warn('ensureGitAvailable: openExternal failed', {
          url: currentErr.guidance.url,
          err,
        });
        failedInstallUrl = currentErr.guidance.url;
      }
      continue;
    }

    if (action === 'retry') {
      const retry = tryPreflight(deps.assertGitAvailable);
      if (retry.kind === 'ok') return 'recovered';
      if (retry.kind === 'typed') {
        emitPreflightFailureSpan(retry.err);
        currentErr = retry.err;
        continue;
      }
      deps.log?.warn('ensureGitAvailable: unexpected retry error', {
        err: retry.err.message,
      });
      await showUnknownErrorDialog(deps, retry.err);
      return 'aborted';
    }

    if (action === 'quit') {
      return 'aborted';
    }

    deps.log?.warn('ensureGitAvailable: unexpected dialog response', {
      response: result.response,
    });
    return 'aborted';
  }
}
