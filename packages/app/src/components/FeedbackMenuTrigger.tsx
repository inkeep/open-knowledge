/**
 * Mounts `FeedbackFormDialog` and opens it when main fires the
 * `send-feedback` menu action (Help → Send feedback…). App-root mount so
 * the Help-menu entry works regardless of sidebar/editor state — sibling of
 * `ReportBugMenuTrigger`.
 *
 * Desktop-only: App.tsx renders it only when the desktop bridge is present (the
 * menu action never fires in the web host, which reaches the same form through
 * the Resources menu and Cmd+K). The Navigator window subscribes separately in
 * `NavigatorApp`.
 */

import { useEffect, useState } from 'react';
import { FeedbackFormDialog } from '@/components/FeedbackFormDialog';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';

export function FeedbackMenuTrigger() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'send-feedback') setOpen(true);
    });
  }, []);

  return <FeedbackFormDialog open={open} onOpenChange={setOpen} source="help_menu" />;
}
