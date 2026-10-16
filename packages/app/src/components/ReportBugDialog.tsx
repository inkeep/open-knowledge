import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { BugReportCapture } from '@/lib/bug-report-capture';
import type { ReportBugDialogProps as ReportBugDialogBodyProps } from './ReportBugDialogBody';

const ReportBugDialogBody = lazy(() => import('./ReportBugDialogBody'));

export interface ReportBugDialogGateProps
  extends Omit<
    ReportBugDialogBodyProps,
    'open' | 'onOpenChange' | 'screenshot' | 'pointerMarked' | 'crashDumpAvailable'
  > {
  capture: BugReportCapture | null;
  onClose: () => void;
}

export function ReportBugDialog({ capture, onClose, ...props }: ReportBugDialogGateProps) {
  const open = capture !== null;
  const [everOpened, setEverOpened] = useState(open);
  const [lastCapture, setLastCapture] = useState(capture);
  const [crashDumpAvailable, setCrashDumpAvailable] = useState(false);
  const openCycleRef = useRef(0);

  if (open && !everOpened) {
    setEverOpened(true);
  }
  if (capture !== null && capture !== lastCapture) {
    setLastCapture(capture);
  }
  const shown = capture ?? lastCapture;

  useEffect(() => {
    if (!open) return;
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
    return () => {
      openCycleRef.current += 1;
    };
  }, [open, props.crashInvite]);

  if (!everOpened) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <ReportBugDialogBody
        {...props}
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        screenshot={shown?.screenshot ?? null}
        pointerMarked={shown?.pointerMarked ?? false}
        crashDumpAvailable={crashDumpAvailable}
      />
    </Suspense>
  );
}
