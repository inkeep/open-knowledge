/**
 * Report-a-bug dialog — thin lazy-loading gate + screenshot capture-before-show.
 *
 * The ~700-line dialog body (phase machine, zip preview, screenshot preview)
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
import { getLastPointerPosition } from '@/lib/pointer-position';
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
 * The overlay shapes a launcher can take: the ⌘K command palette (a cmdk root)
 * or a help popover/menu (a Radix popper). Consulted only for a trigger that
 * declared itself launcher-borne — the surface it was reached from is still
 * animating out and would leak into a shot taken too soon.
 *
 * It deliberately cannot tell that launcher apart from an overlay the user was
 * genuinely in, which is why the wait is opt-in rather than selector-driven: an
 * overlay on screen when a report is started is usually the thing being
 * reported, and waiting for it to unmount photographs the app after the defect
 * went away.
 */
const LAUNCHER_SELECTOR = '[cmdk-root],[data-radix-popper-content-wrapper]';

/**
 * Ceiling on how long the capture waits for a launcher to clear before shooting
 * anyway, so a launcher that never unmounts (or a missing animation event) still
 * can't stall the shot.
 *
 * Every surface `LAUNCHER_SELECTOR` matches exits in 100ms — measured, not
 * assumed:
 *   grep -ho "duration-[0-9]*" src/components/ui/{popover,dropdown-menu,menubar,command}.tsx
 * yields only `duration-100` and `duration-0`. 500ms is 5x that, which is the
 * headroom the deadline is buying; re-run the grep if a launcher surface ever
 * animates slower.
 */
const CAPTURE_SETTLE_DEADLINE_MS = 500;

/**
 * Put the pointer in the picture, and hand back the eraser.
 *
 * `capturePage()` never includes the cursor, so a report about a hover state
 * would otherwise arrive as a highlighted row with nothing to explain what
 * highlighted it. The ring is drawn into the DOM a frame before the shot
 * rather than composited into the PNG afterwards, because the gate already
 * owns the frame the shot is taken on while main holds raw PNG bytes and no
 * drawing primitive — and because whatever is in the viewport lands in the
 * full-resolution image, not just the preview.
 *
 * Draws nothing when the pointer has not moved since the page loaded or has
 * since left the window: a ring in a position nobody is pointing at is worse
 * than no ring.
 */
function markPointerPosition(): (() => void) | null {
  const position = getLastPointerPosition();
  if (position === null) return null;
  const marker = document.createElement('div');
  marker.className = 'ok-pointer-marker';
  marker.setAttribute('aria-hidden', 'true');
  // Centred on these by the class's own transform, so they are the pointer's
  // viewport coordinates rather than a corner.
  marker.style.left = `${position.x}px`;
  marker.style.top = `${position.y}px`;
  document.body.append(marker);
  return () => marker.remove();
}

interface ReportBugDialogGateProps extends ReportBugDialogProps {
  /**
   * The surface that opened this dialog is a transient launcher the user went
   * through only to REACH it (the ⌘K palette, a help popover, the in-app
   * menubar), so the screenshot must wait for it to unmount. Default off: most
   * triggers are launcher-free, and for them the overlay on screen is the
   * report's subject rather than an artifact of filing it.
   *
   * Not derivable from the DOM — three surfaces share one mount point and only
   * some of them are launcher-borne, so the opener has to say.
   *
   * Must stay constant for the lifetime of an open cycle. The capture effect
   * keys on it, so a flip while `open` stays true re-runs the whole capture
   * without resetting `ready` — over an already-revealed dialog, whose own
   * picture would then replace the one the report is about. Every opener holds
   * it fixed: the two menu-action triggers pin the first origin they see, and
   * the rest pass a literal.
   */
  launcherBorne?: boolean;
}

export function ReportBugDialog({ launcherBorne = false, ...props }: ReportBugDialogGateProps) {
  // Pull the heavy chunk only once first opened — a ~1-frame delay on first
  // open is worth keeping it out of first paint for a rarely-used surface.
  // Once opened, the body stays mounted so Radix's close animation and
  // focus-return to the trigger behave exactly as before the split.
  const [everOpened, setEverOpened] = useState(props.open);
  // `ready` gates the Radix overlay so the screenshot is captured BEFORE the
  // dialog paints over the app; `screenshot` is the captured preview (or null).
  const [ready, setReady] = useState(false);
  const [screenshot, setScreenshot] = useState<OkBugReportScreenshot | null>(null);
  // Whether the shot actually carries a pointer ring. False on every
  // launcher-borne open, and on a launcher-free one where the pointer has not
  // moved since load — so the dialog's own description of the image stays true
  // rather than promising a marker the user will not find.
  const [pointerMarked, setPointerMarked] = useState(false);
  // Whether main is holding a crash dump this report could carry. Only asked
  // for a report the user opened themselves — a crash invite already carries
  // main's answer for its own crash on the event.
  const [crashDumpAvailable, setCrashDumpAvailable] = useState(false);
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
    setCrashDumpAvailable(false);
    // Probed alongside the capture rather than gating the reveal on it: the
    // lookup walks the crash-dumps dir and parses dump headers, and a slow or
    // stuck disk must cost the row, never the dialog. The row defaults
    // unchecked, so arriving a beat late only adds an option.
    const availability = window.okDesktop?.bugReport?.crashDumpAvailability;
    if (props.crashInvite === undefined && typeof availability === 'function') {
      availability()
        .then((result) => {
          if (openCycleRef.current !== cycle) return;
          setCrashDumpAvailable(result.available);
        })
        .catch((err: unknown) => {
          // Nothing to offer if main could not answer, but leave a breadcrumb:
          // a probe that keeps failing presents as "no dump on disk", which is
          // the exact symptom this row exists to end.
          console.warn('[bug-report] crash-dump availability probe failed:', err);
        });
    }
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
    // Assigned when the shot is set up, and called by whatever ends the wait —
    // a resolved or rejected capture, the reveal timeout, or teardown. The ring
    // is on screen for the whole round trip main needs to answer, bounded by
    // that timeout, and must not outlive it: once the wait is over it is no
    // longer in a screenshot, it is on the user's screen.
    let removePointerMarker = () => {};
    let marked = false;
    const settle = (shot: OkBugReportScreenshot | null) => {
      if (settled || openCycleRef.current !== cycle) return;
      settled = true;
      removePointerMarker();
      setScreenshot(shot);
      setPointerMarked(shot !== null && marked);
      setReady(true);
    };
    const revealTimer = setTimeout(() => {
      // Nothing to report to main, but leave a breadcrumb: past this point the
      // dialog offers no screenshot, and "we could not get one in time" is
      // otherwise indistinguishable from "we chose not to take one".
      console.warn(
        `[bug-report] screenshot capture did not settle within ${CAPTURE_REVEAL_TIMEOUT_MS}ms; revealing without one`,
      );
      settle(null);
    }, CAPTURE_REVEAL_TIMEOUT_MS);
    // A launcher-borne trigger holds the capture until the surface it was
    // reached from has finished animating out and unmounted, bounded by a
    // deadline so a launcher that never clears can't block the shot. Every
    // other trigger shoots with whatever is on screen still on screen. Either
    // way the shot is taken a frame after the decision, so a removal has
    // painted.
    const startedAt = performance.now();
    let rafId = 0;
    const settleThenCapture = () => {
      // `settled` as well as the cycle: the reveal timeout is a timer and this
      // is a frame, and a window that stops compositing suspends frames while
      // its timers keep firing. A frame that arrives after the wait is over
      // would draw a ring nothing is left to remove, and pay for a capture
      // whose result `settle` drops on arrival.
      if (settled || openCycleRef.current !== cycle) return;
      const pastDeadline = performance.now() - startedAt >= CAPTURE_SETTLE_DEADLINE_MS;
      if (launcherBorne && document.querySelector(LAUNCHER_SELECTOR) !== null && !pastDeadline) {
        rafId = requestAnimationFrame(settleThenCapture);
        return;
      }
      // Only on a launcher-free open. A launcher-borne shot is deliberately
      // taken after the surface the user clicked has unmounted, so the last
      // recorded position is a row that is no longer there — a ring drawn
      // over whatever moved under it claims a hover nobody is making, which
      // is the same thing the tracker refuses to do at the viewport edge.
      if (!launcherBorne) {
        const remove = markPointerPosition();
        if (remove !== null) {
          removePointerMarker = remove;
          marked = true;
        }
      }
      rafId = requestAnimationFrame(() => {
        if (settled || openCycleRef.current !== cycle) return;
        capture()
          .then(settle)
          .catch((err: unknown) => {
            // Same reasoning as the crash-dump probe above: a capture that
            // keeps rejecting presents as "no screenshot offered", which the
            // user cannot tell from "we chose not to take one" and which main
            // has no way to log, because the failure is the IPC round trip.
            console.warn('[bug-report] screenshot capture failed:', err);
            settle(null);
          });
      });
    };
    rafId = requestAnimationFrame(settleThenCapture);
    return () => {
      openCycleRef.current += 1;
      clearTimeout(revealTimer);
      cancelAnimationFrame(rafId);
      // Covers every path that never reaches `settle`: a close between the
      // draw and the shot, and a capture whose cycle has been superseded.
      removePointerMarker();
    };
  }, [props.open, props.crashInvite, launcherBorne]);

  if (!everOpened) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <ReportBugDialogBody
        {...props}
        open={props.open && ready}
        screenshot={screenshot}
        pointerMarked={pointerMarked}
        crashDumpAvailable={crashDumpAvailable}
      />
    </Suspense>
  );
}
