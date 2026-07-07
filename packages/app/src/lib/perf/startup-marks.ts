/**
 * Renderer-side startup marks for the desktop launch waterfall.
 *
 * Two signals define "first usable content" in the editor shell:
 *   - the page list finished its first load (`pageListReady`), and
 *   - the active / initial document's cold-mount sync resolved (`activeDocSynced`).
 *
 * The user perceives "ready" only once BOTH have happened, so first-content is
 * the LATER of the two. Whichever lands second triggers the single report to
 * the desktop main process, which folds these epoch-ms timestamps into the
 * `desktop.startup-timeline` log line.
 *
 * Both inputs are recorded as `Date.now()` epoch milliseconds (not monotonic
 * `performance.now()`): main computes cross-process deltas against the server
 * lock's `startedAt` wall-clock and the renderer's own marks, so a shared
 * epoch clock is required. Skew between processes on the same machine is
 * sub-millisecond and is surfaced separately as `spawnToServerStartMs`.
 *
 * The report is idempotent and fire-and-forget: it fires exactly once (the
 * first time both inputs are present), and is a no-op when `window.okDesktop`
 * is absent (web build) or the desktop bridge lacks the `startup` surface
 * (older host). The OTel side is fed independently via `mark()` so the
 * cold-mount trace carries the same two checkpoints.
 */

import { mark } from './index';

let pageListReadyAt: number | undefined;
let activeDocSyncedAt: number | undefined;
let reported = false;
let firstContentListener: ((firstContentMs: number) => void) | undefined;

/**
 * Register a one-shot listener invoked with the computed first-content epoch
 * (the later of the two checkpoints) when both inputs have landed. Used by the
 * OTel side in `main.tsx` to end the `ok.app-startup` renderer span at the
 * exact first-content moment. If first-content has already been reached, the
 * listener fires immediately with the recorded value.
 */
export function onFirstContent(listener: (firstContentMs: number) => void): void {
  if (reported && pageListReadyAt !== undefined && activeDocSyncedAt !== undefined) {
    listener(Math.max(pageListReadyAt, activeDocSyncedAt));
    return;
  }
  firstContentListener = listener;
}

/**
 * Push the two epoch-ms marks to the desktop main process exactly once, once
 * both inputs are present. No-op on the web build (no `window.okDesktop`), on
 * an older host without the `startup` bridge surface, or after the first send.
 */
function maybeReport(): void {
  if (reported) return;
  if (pageListReadyAt === undefined || activeDocSyncedAt === undefined) return;
  reported = true;

  // First-content = the later of the two checkpoints (the user sees content
  // only once both the list and the active doc have settled).
  const firstContentMs = Math.max(pageListReadyAt, activeDocSyncedAt);
  const reportMarks =
    typeof window !== 'undefined' ? window.okDesktop?.startup?.reportMarks : undefined;
  reportMarks?.({ pageListReadyMs: pageListReadyAt, firstContentMs });
  firstContentListener?.(firstContentMs);
  firstContentListener = undefined;
}

/**
 * Record that the page list finished its first load. Idempotent — only the
 * first call is honored (later refetches on focus / CC1 push must not move the
 * mark). Safe to call before or after {@link activeDocSynced}.
 */
export function pageListReady(): void {
  if (pageListReadyAt !== undefined) return;
  pageListReadyAt = Date.now();
  mark('ok/startup/page-list-ready');
  maybeReport();
}

/**
 * Record that the active / initial document's cold-mount sync resolved — the
 * second of the two first-content inputs. Idempotent — only the first call is
 * honored (subsequent doc syncs in the session are not the launch's first
 * content).
 */
export function firstContent(): void {
  if (activeDocSyncedAt !== undefined) return;
  activeDocSyncedAt = Date.now();
  mark('ok/startup/first-content');
  maybeReport();
}

/** Test-only: clear accumulated marks + the one-shot guard. */
export function __resetStartupMarksForTest(): void {
  pageListReadyAt = undefined;
  activeDocSyncedAt = undefined;
  reported = false;
  firstContentListener = undefined;
}
