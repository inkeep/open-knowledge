import { useSyncExternalStore } from 'react';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { crashInviteStore } from '@/lib/crash-invite-store';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function ReportBugCrashInviteTrigger({ bridge }: { bridge: OkDesktopBridge }) {
  const invite = useSyncExternalStore(crashInviteStore.subscribe, crashInviteStore.getSnapshot);

  if (invite === null) return null;

  return (
    <ReportBugDialog
      key={invite.eventId}
      open
      onOpenChange={(open) => {
        if (open) return;
        void bridge.bugReport.crashAck({ eventId: invite.eventId });
        crashInviteStore.dismiss();
      }}
      systemWide={bridge.config.mode === 'navigator'}
      crashInvite={invite}
    />
  );
}
