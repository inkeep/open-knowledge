/**
 * Report-a-bug dialog — thin lazy-loading gate + screenshot capture-before-show.
 *
 * The ~800-line dialog body (phase machine, zip preview, upload-transport UI)
 * is behind `React.lazy()`, so it only enters the bundle graph the first time
 * the dialog is opened — keeping it out of the main app chunk (size-limit
 * budget). Mirrors the `ConsentDialog` / `ConsentDialogBody` split.
 *
 * The gate is also the single chokepoint where the app screenshot is captured.
 * Every trigger (command palette, help popover, navigator, error boundary,
 * crash invite) flows through here, so capturing on open means one place owns
 * it. The capture must exclude the dialog itself, so the gate holds the Radix
 * overlay closed (`open={props.open && ready}`) until main has captured the
 * page underneath — then reveals the dialog with the preview already in hand.
 * Non-desktop (or an older bridge without `captureScreenshot`) reveals
 * immediately with no screenshot; a hung capture reveals on a timeout.
 */

import type { OkBugReportScreenshot } from '@inkeep/open-knowledge-core';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReportBugDialogProps } from './ReportBugDialogBody';

const ReportBugDialogBody = lazy(() => import('./ReportBugDialogBody'));

/**
 * Ceiling on how long the dialog waits for the screenshot capture before
 * opening anyway. `capturePage()` is normally tens of ms; this only guards a
 * pathologically slow or stuck main so the user is never stranded staring at
 * an un-opened dialog after clicking "Report a bug".
 */
const CAPTURE_REVEAL_TIMEOUT_MS = 1200;

/**
 * A launcher surface opened only to REACH this dialog — the ⌘K command palette
 * (a cmdk root) or a help popover/menu (a Radix popper) — is still animating out
 * when the dialog opens, and would leak into the screenshot if captured too
 * soon. The capture waits for these to unmount; persistent context the user was
 * genuinely in (a Settings dialog, an error-boundary card) is neither a cmdk
 * root nor a popper, so it is captured, not waited on.
 */
const LAUNCHER_SELECTOR = '[cmdk-root],[data-radix-popper-content-wrapper]';

/**
 * Ceiling on how long the capture waits for a launcher to clear before shooting
 * anyway. Comfortably outlasts a Radix exit animation (~150-200ms), so a launcher
 * that never unmounts (or a missing animation event) still can't stall the shot.
 */
const CAPTURE_SETTLE_DEADLINE_MS = 500;

export function ReportBugDialog(props: ReportBugDialogProps) {
  // Pull the heavy chunk only once first opened — a ~1-frame delay on first
  // open is worth keeping it out of first paint for a rarely-used surface.
  // Once opened, the body stays mounted so Radix's close animation and
  // focus-return to the trigger behave exactly as before the split.
  const [everOpened, setEverOpened] = useState(props.open);
  // `ready` gates the Radix overlay so the screenshot is captured BEFORE the
  // dialog paints over the app; `screenshot` is the captured preview (or null).
  const [ready, setReady] = useState(false);
  const [screenshot, setScreenshot] = useState<OkBugReportScreenshot | null>(null);
  // Bumped on every open transition (and on close/unmount cleanup) so a capture
  // that resolves after its open cycle ended drops its result.
  const openCycleRef = useRef(0);

  if (props.open && !everOpened) {
    setEverOpened(true);
  }

  useEffect(() => {
    if (!props.open) {
      setReady(false);
      return;
    }
    const cycle = ++openCycleRef.current;
    const capture = window.okDesktop?.bugReport?.captureScreenshot;
    // Skip the capture-before-show for the crash invite: it opens itself,
    // unprompted, the moment main pushes a crash-detected event, so holding it
    // closed for a capture would delay an already-surprising dialog and race
    // with whatever the user is mid-interaction on (and a post-crash screenshot
    // adds little over the crash dump the invite already offers). Reveal at once
    // with no screenshot, exactly as a build without capture would.
    if (typeof capture !== 'function' || props.crashInvite !== undefined) {
      // Web, or a desktop build predating this method: nothing to capture, so
      // reveal at once and offer no screenshot option.
      setScreenshot(null);
      setReady(true);
      return;
    }
    setScreenshot(null);
    // First of the timeout / capture-resolve to fire reveals the dialog; the
    // other is ignored. Guarded on the cycle so a stale close can't reveal.
    let settled = false;
    const settle = (shot: OkBugReportScreenshot | null) => {
      if (settled || openCycleRef.current !== cycle) return;
      settled = true;
      setScreenshot(shot);
      setReady(true);
    };
    const revealTimer = setTimeout(() => settle(null), CAPTURE_REVEAL_TIMEOUT_MS);
    // Hold the capture until the launcher that was opened to reach this dialog
    // has finished animating out and unmounted, then take the shot one frame
    // later (so the removal has painted). Bounded by a deadline so a launcher
    // that never clears can't block the shot.
    const startedAt = performance.now();
    let rafId = 0;
    const settleThenCapture = () => {
      if (openCycleRef.current !== cycle) return;
      const pastDeadline = performance.now() - startedAt >= CAPTURE_SETTLE_DEADLINE_MS;
      if (document.querySelector(LAUNCHER_SELECTOR) !== null && !pastDeadline) {
        rafId = requestAnimationFrame(settleThenCapture);
        return;
      }
      rafId = requestAnimationFrame(() => {
        if (openCycleRef.current !== cycle) return;
        capture()
          .then(settle)
          .catch(() => settle(null));
      });
    };
    rafId = requestAnimationFrame(settleThenCapture);
    return () => {
      openCycleRef.current += 1;
      clearTimeout(revealTimer);
      cancelAnimationFrame(rafId);
    };
  }, [props.open, props.crashInvite]);

  if (!everOpened) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <ReportBugDialogBody {...props} open={props.open && ready} screenshot={screenshot} />
    </Suspense>
  );
}
