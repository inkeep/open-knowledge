/**
 * Mounts `ReportBugDialog` and opens it when main fires the `report-bug`
 * menu action (Help → Report a Bug…). App-root mount so the Help-menu entry
 * works regardless of sidebar/editor state — mirroring the self-contained
 * trigger pattern of `CreateProjectMenuTrigger`.
 *
 * Desktop-only: App.tsx renders it only when the desktop bridge is present
 * (the `report-bug` menu action never fires in the web host). The Navigator
 * window subscribes separately in `NavigatorApp` with a system-wide scope.
 */

import { useEffect, useState } from 'react';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function ReportBugMenuTrigger({ bridge }: { bridge: OkDesktopBridge }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'report-bug') setOpen(true);
    });
  }, [bridge]);

  return <ReportBugDialog open={open} onOpenChange={setOpen} />;
}
