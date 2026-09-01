import { useEffect, useState } from 'react';
import { CreateProjectDialog } from '@/components/CreateProjectDialog';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';

export function CreateProjectMenuTrigger({ bridge }: { bridge: OkDesktopBridge }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'new-project') setOpen(true);
    });
  }, []);

  return <CreateProjectDialog open={open} onOpenChange={setOpen} bridge={bridge} />;
}
