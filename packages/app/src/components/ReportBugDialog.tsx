/**
 * Report-a-bug dialog — thin lazy-loading gate. The ~800-line dialog body
 * (phase machine, zip preview, upload-transport UI) is behind `React.lazy()`,
 * so it only enters the bundle graph the first time the dialog is opened —
 * keeping it out of the main app chunk (size-limit budget). Mirrors the
 * `ConsentDialog` / `ConsentDialogBody` split.
 */

import { lazy, Suspense, useState } from 'react';
import type { ReportBugDialogProps } from './ReportBugDialogBody';

const ReportBugDialogBody = lazy(() => import('./ReportBugDialogBody'));

export function ReportBugDialog(props: ReportBugDialogProps) {
  // Pull the heavy chunk only once first opened — a ~1-frame delay on first
  // open is worth keeping it out of first paint for a rarely-used surface.
  // Once opened, the body stays mounted so Radix's close animation and
  // focus-return to the trigger behave exactly as before the split.
  const [everOpened, setEverOpened] = useState(props.open);
  if (props.open && !everOpened) {
    setEverOpened(true);
  }
  if (!everOpened) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <ReportBugDialogBody {...props} />
    </Suspense>
  );
}
