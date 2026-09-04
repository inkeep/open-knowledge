import type { OkBugReportScreenshot } from '@inkeep/open-knowledge-core';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { getLastPointerPosition } from '@/lib/pointer-position';
import type { ReportBugDialogProps } from './ReportBugDialogBody';

const ReportBugDialogBody = lazy(() => import('./ReportBugDialogBody'));

const CAPTURE_REVEAL_TIMEOUT_MS = 1200;

const LAUNCHER_SELECTOR = '[cmdk-root],[data-radix-popper-content-wrapper]';

const CAPTURE_SETTLE_DEADLINE_MS = 500;

function markPointerPosition(): (() => void) | null {
  const position = getLastPointerPosition();
  if (position === null) return null;
  const marker = document.createElement('div');
  marker.className = 'ok-pointer-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.style.left = `${position.x}px`;
  marker.style.top = `${position.y}px`;
  document.body.append(marker);
  return () => marker.remove();
}

interface ReportBugDialogGateProps extends ReportBugDialogProps {
  launcherBorne?: boolean;
}

export function ReportBugDialog({ launcherBorne = false, ...props }: ReportBugDialogGateProps) {
  const [everOpened, setEverOpened] = useState(props.open);
  const [ready, setReady] = useState(false);
  const [screenshot, setScreenshot] = useState<OkBugReportScreenshot | null>(null);
  const [pointerMarked, setPointerMarked] = useState(false);
  const [crashDumpAvailable, setCrashDumpAvailable] = useState(false);
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
    const availability = window.okDesktop?.bugReport?.crashDumpAvailability;
    if (props.crashInvite === undefined && typeof availability === 'function') {
      availability()
        .then((result) => {
          if (openCycleRef.current !== cycle) return;
          setCrashDumpAvailable(result.available);
        })
        .catch((err: unknown) => {
          console.warn('[bug-report] crash-dump availability probe failed:', err);
        });
    }
    const capture = window.okDesktop?.bugReport?.captureScreenshot;
    if (typeof capture !== 'function' || props.crashInvite !== undefined) {
      setScreenshot(null);
      setReady(true);
      return;
    }
    setScreenshot(null);
    let settled = false;
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
      console.warn(
        `[bug-report] screenshot capture did not settle within ${CAPTURE_REVEAL_TIMEOUT_MS}ms; revealing without one`,
      );
      settle(null);
    }, CAPTURE_REVEAL_TIMEOUT_MS);
    const startedAt = performance.now();
    let rafId = 0;
    const settleThenCapture = () => {
      if (settled || openCycleRef.current !== cycle) return;
      const pastDeadline = performance.now() - startedAt >= CAPTURE_SETTLE_DEADLINE_MS;
      if (launcherBorne && document.querySelector(LAUNCHER_SELECTOR) !== null && !pastDeadline) {
        rafId = requestAnimationFrame(settleThenCapture);
        return;
      }
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
