import { useEffect } from 'react';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { useBugReport } from '@/lib/bug-report-capture';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';

interface ReportBugMenuTriggerProps {
  readonly systemWide?: boolean;
}

export function ReportBugMenuTrigger({ systemWide }: ReportBugMenuTriggerProps) {
  const bugReport = useBugReport();

  useEffect(() => {
    return subscribeLocalMenuAction((action, origin) => {
      if (action === 'report-bug') bugReport.start(origin);
    });
  }, [bugReport.start]);

  return (
    <ReportBugDialog
      capture={bugReport.capture}
      onClose={bugReport.close}
      systemWide={systemWide}
    />
  );
}
