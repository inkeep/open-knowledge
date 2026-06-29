import {
  emitPreflightFailureSpan,
  type GitDetected,
  GitNotAvailableError,
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
    readonly warn: (msg: string, obj?: unknown) => void;
  };
}

const BUTTON_OPEN_INSTALL_PAGE = 0;
const BUTTON_RETRY = 1;
const BUTTON_QUIT = 2;

const BUTTON_LABELS = ['Open Install Page', "I've Installed Git — Retry", 'Quit'] as const;

type PreflightAttempt =
  | { kind: 'ok'; detection: GitDetected }
  | { kind: 'typed'; err: GitNotAvailableError | GitTooOldError }
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
      err: dialogErr instanceof Error ? dialogErr.message : String(dialogErr),
    });
  }
}

function tryPreflight(fn: () => GitDetected): PreflightAttempt {
  try {
    return { kind: 'ok', detection: fn() };
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
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
    const title = currentErr instanceof GitTooOldError ? 'Git too old' : 'Git not found';
    const message =
      currentErr instanceof GitTooOldError
        ? `OpenKnowledge requires ${currentErr.guidance.product} ${currentErr.required} or newer.`
        : `OpenKnowledge needs ${currentErr.guidance.product} to track changes to your knowledge base.`;
    const detail =
      failedInstallUrl === null
        ? currentErr.message
        : `${currentErr.message}\n\nCould not open browser automatically. Please visit: ${failedInstallUrl}`;
    const result = await deps.showMessageBox({
      type: 'warning',
      buttons: BUTTON_LABELS,
      defaultId: BUTTON_RETRY,
      cancelId: BUTTON_QUIT,
      title,
      message,
      detail,
    });

    if (result.response === BUTTON_OPEN_INSTALL_PAGE) {
      try {
        await deps.openExternal(currentErr.guidance.url);
        failedInstallUrl = null;
      } catch (err) {
        deps.log?.warn('ensureGitAvailable: openExternal failed', {
          url: currentErr.guidance.url,
          err: err instanceof Error ? err.message : String(err),
        });
        failedInstallUrl = currentErr.guidance.url;
      }
      continue;
    }

    if (result.response === BUTTON_RETRY) {
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

    if (result.response === BUTTON_QUIT) {
      return 'aborted';
    }

    deps.log?.warn('ensureGitAvailable: unexpected dialog response', {
      response: result.response,
    });
    return 'aborted';
  }
}
