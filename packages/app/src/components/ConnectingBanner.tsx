// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * "Connecting — waiting for collab server" banner.
 *
 * Three modes (see `computeBannerMode`):
 *   (1) **Hidden** — either `collabUrl` resolved, or we're still inside the
 *       grace window on a fresh mount. The grace window prevents a banner
 *       flash on healthy page loads: `/api/config` resolves in ~50ms under
 *       both `ok ui` and `bun run dev` — showing "Connecting…" for 50ms is
 *       pure noise.
 *   (2) **Retrying** — `useCollabUrl()` has not yet resolved after the grace
 *       period; the hook is polling `/api/config` with bounded exponential
 *       backoff. Amber banner.
 *   (3) **Terminal** — the hook gave up after ~30s of continuous failure.
 *       Red banner with (a) the underlying error classification and
 *       (b) a manual "Retry" button that resets the backoff window. Shown
 *       immediately regardless of grace — the user has already waited 30s.
 *
 * A silent-forever banner is itself a form of ceremony — users hit-refresh
 * or kill the tab. The terminal state surfaces an actionable diagnostic
 * (pointer at `ok status` / `last-spawn-error.log`) so the user can fix
 * the misconfig rather than guess at it.
 */
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';
import { restartCollabServer } from '@/lib/restart-collab-server';

/**
 * Grace-period length before the amber retrying banner surfaces. 500 ms
 * covers the normal fetch-resolution window (same-origin localhost typically
 * resolves in <100 ms) and matches the common Suspense-fallback debounce
 * guidance — long enough to hide fast resolutions, short enough that a
 * genuinely slow boot is flagged before the user loses attention. Terminal
 * state ignores this; retry-after-terminal re-enters the grace window so a
 * fast successful retry stays silent.
 */
const GRACE_PERIOD_MS = 500;

type BannerMode = 'hidden' | 'retrying' | 'terminal';

/**
 * Pure decision: what should the banner show right now? Exported for unit
 * tests so the branching logic is verifiable without a DOM — the React
 * wrapper below adds state + effect for the grace timer only.
 */
export function computeBannerMode(
  collabUrl: string | null,
  collabTerminal: boolean,
  graceElapsed: boolean,
): BannerMode {
  if (collabTerminal) return 'terminal';
  if (collabUrl !== null) return 'hidden';
  return graceElapsed ? 'retrying' : 'hidden';
}

/**
 * Collab-resolution error shape carried on the document context. `null-collab`
 * means `ok ui` answered `/api/config` but `server.lock` had no port — i.e. a
 * UI with no collab server, which (once terminal) is the worktree-no-brain case.
 */
type CollabError =
  | { kind: 'error'; code: number | 'network' | 'invalid-body' }
  | { kind: 'null-collab' }
  | null;

/**
 * Is the terminal failure specifically "this folder has a UI but no collab
 * server" (the worktree case)? `null-collab` is exactly that signal — `ok ui`
 * responded, the lock has no port. A transient boot-race `null-collab` clears
 * well inside the ~30s grace+retry window, so reaching terminal with it means
 * the folder genuinely has no collab server. Pure + exported so the message
 * branch is unit-testable without a DOM (matches `computeBannerMode`).
 */
export function isNoCollabServerError(err: CollabError): boolean {
  return err?.kind === 'null-collab';
}

export function describeError(err: CollabError): string {
  if (err === null) return t`no response`;
  if (err.kind === 'null-collab') return t`ok ui responded but server.lock has no port yet`;
  if (err.code === 'network') return t`network error (is \`ok ui\` running?)`;
  if (err.code === 'invalid-body') return t`/api/config returned a malformed body`;
  const code = err.code;
  return t`/api/config returned HTTP ${code}`;
}

export function ConnectingBanner() {
  const { collabUrl, collabTerminal, collabLastError, retryCollab } = useDocumentContext();
  const [graceElapsed, setGraceElapsed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Desktop-only: `restartServer` lives on the Electron bridge. In `ok ui`
  // (browser) mode there is no owned process to restart, so only Retry shows.
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;

  useEffect(() => {
    // Resolved or terminal → no grace timer needed. Reset the flag so a
    // future retry-after-terminal re-enters the grace window and hides the
    // banner again if the retry resolves quickly.
    if (collabUrl !== null || collabTerminal) {
      setGraceElapsed(false);
      return;
    }
    const timer = setTimeout(() => setGraceElapsed(true), GRACE_PERIOD_MS);
    return () => clearTimeout(timer);
  }, [collabUrl, collabTerminal]);

  const mode = computeBannerMode(collabUrl, collabTerminal, graceElapsed);

  if (mode === 'hidden') return null;

  if (mode === 'terminal') {
    // Distinguish "no collab server for this folder" (the worktree case —
    // `ok ui` is up and answering `/api/config`, but `server.lock` never
    // appeared, so `collabUrl` stays null) from a genuine transport failure.
    // `null-collab` is precisely that signal: the UI responded, the lock has
    // no port. A transient boot-race `null-collab` resolves well inside the
    // ~30s grace+retry window, so reaching terminal with it means the folder
    // genuinely has no collab server — point the user at the explicit fix
    // (`ok start` here, or reopen the project) instead of leaving them on an
    // indefinite "Connecting".
    const isNoCollabServer = isNoCollabServerError(collabLastError);
    const errorDetail = describeError(collabLastError);
    // Retry only re-attempts the SAME server — futile once it has exited (e.g.
    // idle-shutdown). In the desktop app we can spawn a fresh one; `restartServer`
    // reads the (now absent) lock and boots a new server + window.
    const handleRestart = async () => {
      if (!bridge) return;
      setRestartError(null);
      setRestarting(true);
      try {
        const result = await restartCollabServer(bridge);
        // Success: main tears this window down and recreates it, so this
        // component is unmounting — nothing to reset. Only a resolved failure
        // needs surfacing.
        if (!result.ok) {
          setRestartError(result.message);
          setRestarting(false);
        }
      } catch {
        // The invoke rejects when main destroys this window mid-call (the
        // success path) — but an unexpected IPC failure lands here too. Re-enable
        // the button so it can't stick on "Restarting"; on the success path the
        // component is unmounting, so the state update is a harmless no-op.
        setRestarting(false);
      }
    };
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed top-0 inset-x-0 z-50 bg-red-500/95 text-red-950 text-sm text-center py-2 px-4 pl-[var(--ok-titlebar-reserve-left,1rem)] shadow-md flex items-center justify-center gap-3 flex-wrap"
      >
        <span>
          {isNoCollabServer ? (
            <Trans>
              No collab server for this worktree — run{' '}
              <code className="bg-red-100/60 px-1 rounded">ok start</code> here, or reopen the
              project.
            </Trans>
          ) : (
            <Trans>
              Couldn't reach collab server — {errorDetail}. Try{' '}
              <code className="bg-red-100/60 px-1 rounded">ok status</code> or check{' '}
              <code className="bg-red-100/60 px-1 rounded">.ok/local/last-spawn-error.log</code>.
            </Trans>
          )}
        </span>
        <button
          type="button"
          onClick={() => {
            // Clear any prior restart-failure message so a fresh Retry doesn't
            // read as if the retry itself produced the stale error.
            setRestartError(null);
            retryCollab();
          }}
          disabled={restarting}
          className="bg-red-950 text-red-50 px-2 py-0.5 rounded text-xs font-medium hover:bg-red-900 disabled:opacity-60"
        >
          <Trans>Retry</Trans>
        </button>
        {bridge ? (
          <button
            type="button"
            onClick={handleRestart}
            disabled={restarting}
            className="bg-red-950 text-red-50 px-2 py-0.5 rounded text-xs font-medium hover:bg-red-900 disabled:opacity-60"
          >
            {restarting ? <Trans>Restarting</Trans> : <Trans>Restart server</Trans>}
          </button>
        ) : null}
        {restartError !== null ? (
          <span className="w-full text-red-950 text-xs">{restartError}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 inset-x-0 z-50 bg-amber-500/95 text-amber-950 text-sm text-center py-2 px-4 pl-[var(--ok-titlebar-reserve-left,1rem)] shadow-md"
    >
      <Trans>Connecting — waiting for collab server</Trans>
    </div>
  );
}
