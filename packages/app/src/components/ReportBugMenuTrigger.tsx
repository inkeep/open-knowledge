import { useEffect, useState } from 'react';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import type { OkMenuActionOrigin } from '@/lib/desktop-bridge-types';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';

interface ReportBugMenuTriggerProps {
  readonly systemWide?: boolean;
}

export function ReportBugMenuTrigger({ systemWide }: ReportBugMenuTriggerProps) {
  const [origin, setOrigin] = useState<OkMenuActionOrigin | null>(null);

  useEffect(() => {
    return subscribeLocalMenuAction((action, dispatchOrigin) => {
      if (action !== 'report-bug') return;
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
