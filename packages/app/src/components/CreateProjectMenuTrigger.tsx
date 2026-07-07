/**
 * Mounts `CreateProjectDialog` and opens it when main fires the `new-project`
 * menu action (File → New project…). The dialog is also reachable from
 * the ProjectSwitcher dropdown in the sidebar footer; this App-root mount keeps
 * the File-menu entry working regardless of sidebar visibility — mirroring the
 * self-contained trigger pattern of App.tsx's `InstallInClaudeDesktopTrigger`.
 *
 * Desktop-only: App.tsx renders it only when the desktop bridge is present
 * (the `new-project` menu action never fires in the web host).
 */

import { useEffect, useState } from 'react';
import { CreateProjectDialog } from '@/components/CreateProjectDialog';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function CreateProjectMenuTrigger({ bridge }: { bridge: OkDesktopBridge }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'new-project') setOpen(true);
    });
  }, [bridge]);

  return <CreateProjectDialog open={open} onOpenChange={setOpen} bridge={bridge} />;
}
