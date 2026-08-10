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
      // Remount per crash. Main supersedes an invitation the user left
      // unanswered, so a second event can now replace this one while the
      // dialog is still on screen. Reconciling in place would keep the
      // mount-time state of the previous crash (the dump opt-in, the note the
      // user typed, the phase) while the note's context lines recompute from
      // the new event, shipping one crash's account stamped with the other's
      // id. A report that misattributes its own crash is the failure this
      // whole change exists to end, so the dialog restarts for the new event.
      // A bundle already created for the previous crash is not lost: it is
      // persisted to the report history by `onReportGenerated`.
      key={invite.eventId}
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
