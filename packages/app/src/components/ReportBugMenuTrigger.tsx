/**
 * Mounts `ReportBugDialog` and opens it when main fires the `report-bug`
 * menu action (Help → Report a bug…). App-root mount so the Help-menu entry
 * works regardless of sidebar/editor state — mirroring the self-contained
 * trigger pattern of `CreateProjectMenuTrigger`.
 *
 * Desktop-only: App.tsx renders it only when the desktop bridge is present
 * (the `report-bug` menu action never fires in the web host). The Navigator
 * window subscribes separately in `NavigatorApp` with a system-wide scope.
 *
 * Every window root that can hold focus needs one of these. Main dispatches a
 * menu action to the focused window and nothing else, and an unhandled
 * dispatch is silent, so a root without a subscriber makes the Help item and
 * its accelerator do nothing at all from that window.
 */

import { useEffect, useState } from 'react';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import type { OkMenuActionOrigin } from '@/lib/desktop-bridge-types';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';

interface ReportBugMenuTriggerProps {
  /**
   * No project is open in this window, so the report carries app logs only.
   * Set by the terminal window when it was opened without one; the editor
   * window always has a project and the Navigator uses its own mount.
   */
  readonly systemWide?: boolean;
}

export function ReportBugMenuTrigger({ systemWide }: ReportBugMenuTriggerProps) {
  // The dispatch's origin IS the open state. Several surfaces land on this one
  // mount — the native Help menu, the in-app menubar — and only some of them
  // are a transient overlay the screenshot has to wait out, so the bit cannot
  // be a constant on the mount.
  const [origin, setOrigin] = useState<OkMenuActionOrigin | null>(null);

  useEffect(() => {
    return subscribeLocalMenuAction((action, dispatchOrigin) => {
      if (action !== 'report-bug') return;
      // A second dispatch while the dialog is already open keeps the first
      // origin: the capture it describes has already been taken.
      setOrigin((current) => current ?? dispatchOrigin);
    });
  }, []);

  return (
    <ReportBugDialog
      open={origin !== null}
      onOpenChange={(next) => {
        if (!next) setOrigin(null);
      }}
      launcherBorne={origin?.launcherBorne === true}
      systemWide={systemWide}
    />
  );
}
