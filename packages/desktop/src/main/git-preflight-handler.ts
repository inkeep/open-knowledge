/**
 * Electron main-process git-preflight handler.
 *
 * Runs the server's `assertGitAvailable()` primitive at app boot, BEFORE
 * BrowserWindow creation and BEFORE the detached server child is spawned.
 * On success the caller proceeds to runBootstrap + window/server creation;
 * on the typed preflight errors (GitNotAvailableError / GitTooOldError) the
 * handler shows a recoverable modal dialog (Open Install Page / Retry /
 * Quit) and returns the user's outcome.
 *
 * Defense-in-depth complement: the spawned server child ALSO runs the
 * preflight inside its own `bootServer()` — covers the "user uninstalled
 * git between the main-process preflight and server spawn" race. This
 * handler is the user-facing gate; the child's preflight is the
 * never-bypassable backstop.
 *
 * Pure: no Electron imports — `showMessageBox`, `openExternal`, and
 * `assertGitAvailable` are injected so this module is unit-testable
 * without an Electron runtime. The caller (`main/index.ts`) wires real
 * Electron APIs.
 */

import {
  emitPreflightFailureSpan,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
} from '@inkeep/open-knowledge-server';

/** Outcome the caller acts on. */
export type EnsureGitOutcome = 'ok' | 'recovered' | 'aborted';

/**
 * Subset of `Electron.MessageBoxOptions` the handler actually uses. Keeping
 * a local minimal shape avoids importing Electron's types into this
 * Electron-free module (which would make unit testing pull in the full
 * `electron` package). The production wiring in `main/index.ts` adapts
 * `dialog.showMessageBox` to this shape.
 */
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
  /**
   * The preflight primitive. Production passes `assertGitAvailable` from
   * `@inkeep/open-knowledge-server`. Test injection lets us deterministically
   * exercise the dialog/retry loop without manipulating the test process's
   * PATH or filesystem.
   */
  readonly assertGitAvailable: () => GitDetected;
  /**
   * Show a native modal dialog. Production passes `dialog.showMessageBox`
   * from Electron; tests pass a mock returning a queue of `response`
   * indices that the loop walks through.
   */
  readonly showMessageBox: (opts: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  /**
   * Open a URL in the user's default browser. Production passes
   * `shell.openExternal` from Electron; tests pass a mock.
   */
  readonly openExternal: (url: string) => Promise<void>;
  /** Diagnostic sink — defaults to a no-op. */
  readonly log?: {
    readonly warn: (msg: string, obj?: unknown) => void;
  };
}

// Button positions in the dialog. Returned as the `response` index.
const BUTTON_OPEN_INSTALL_PAGE = 0;
const BUTTON_RETRY = 1;
const BUTTON_QUIT = 2;

// Verbatim labels — treat as the dialog's wire format.
const BUTTON_LABELS = ['Open Install Page', "I've Installed Git — Retry", 'Quit'] as const;

type PreflightAttempt =
  | { kind: 'ok'; detection: GitDetected }
  | { kind: 'typed'; err: GitNotAvailableError | GitTooOldError }
  | { kind: 'unknown'; err: Error };

/**
 * Surface an unknown-error path through a single-button "Quit" dialog so
 * the user sees what went wrong instead of the app vanishing silently.
 *
 * Unknown errors here cover anything that is NOT a typed
 * `GitNotAvailableError` / `GitTooOldError` — permission errors out of
 * `spawnSync`, OOM, an inaccessible `/bin/sh`, or any future failure mode
 * the preflight primitive doesn't normalize. The Retry / Install Page
 * affordances don't apply (we have no install guidance to present), so
 * the dialog is informational: the user must Quit. Best-effort: if even
 * the dialog itself throws (e.g. the renderer crashed), we still return
 * 'aborted' so the caller can app.quit() cleanly.
 */
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

/**
 * Promise-friendly wrapper. Discriminates the three outcomes we branch on
 * (success, typed-preflight-error, unknown-error) so the caller's switch
 * stays flat instead of nesting try/catch + instanceof checks.
 */
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

/**
 * Run the git preflight and, on typed failure, drive a recoverable dialog
 * loop. Returns:
 *   - 'ok'        — preflight succeeded on the first try; no dialog shown.
 *   - 'recovered' — preflight failed initially; the user installed git
 *                   (or restored PATH) and the Retry button observed
 *                   success. Caller proceeds to normal boot.
 *   - 'aborted'   — user clicked Quit, or an unrecoverable non-typed
 *                   error landed. Caller MUST NOT create a BrowserWindow
 *                   or spawn the server child; typically calls `app.quit()`.
 *
 * No programmatic retry cap. Exit is user-driven via Quit.
 */
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

  // Failure-only telemetry. One span per typed-error observation — initial
  // probe + every retry that still fails. No-op when OTEL is off.
  emitPreflightFailureSpan(first.err);
  let currentErr = first.err;
  // When `openExternal` throws (no XDG default browser, sandbox
  // restrictions, etc.), the URL we tried to open is appended to the
  // next dialog's `detail` so the user can copy it manually. Reset
  // each retry so a successful subsequent open doesn't leave a stale
  // copy in view.
  let failedInstallUrl: string | null = null;
  while (true) {
    // Branch on the typed shape so TS narrows the access to `.required`
    // (only present on GitTooOldError). A ternary on a `isTooOld` boolean
    // alias wouldn't preserve the narrowing — the property accesses inside
    // the template literal would still be on the union type.
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

    // Defensive: an out-of-range response (shouldn't happen with a fixed
    // 3-button array; future dialog tooling could surface a synthetic
    // cancel as -1) is treated as Quit. Logging surfaces the divergence so
    // a real bug doesn't silently abort.
    deps.log?.warn('ensureGitAvailable: unexpected dialog response', {
      response: result.response,
    });
    return 'aborted';
  }
}
