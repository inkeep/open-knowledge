/**
 * Mounts `ReportBugDialog` in its crash-invite variant when desktop main
 * pushes a crash-detected event (abnormal renderer/child process death, or
 * boot-time dirty-shutdown/minidump detection). Mounted once per window in
 * `main.tsx` as a sibling of the root app — outside `AppErrorBoundary`, so an
 * invitation still surfaces while the shell fallback is showing, and present
 * in every window mode (main targets whichever live window can take it).
 *
 * The event itself is read from `crash-invite-store`, whose bridge
 * subscription attaches at module init — boot-time invitations arrive on the
 * window's first `did-finish-load` and must not race React's effect flush.
 *
 * Any close of the invitation dialog — "Not now", Escape, the ✕, or Done
 * after a successful send — counts as the user's answer: the crash event is
 * acked so it never re-prompts, across restarts included.
 */

import { useSyncExternalStore } from 'react';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { crashInviteStore } from '@/lib/crash-invite-store';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function ReportBugCrashInviteTrigger({ bridge }: { bridge: OkDesktopBridge }) {
  const invite = useSyncExternalStore(crashInviteStore.subscribe, crashInviteStore.getSnapshot);

  if (invite === null) return null;

  return (
    <ReportBugDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // Fire-and-forget by contract: crash-ack never rejects, and a decline
        // must never surface an error. Worst case (main already tearing down)
        // the un-acked event re-invites on the next boot.
        void bridge.bugReport.crashAck({ eventId: invite.eventId });
        crashInviteStore.dismiss();
      }}
      systemWide={bridge.config.mode === 'navigator'}
      crashInvite={invite}
    />
  );
}
