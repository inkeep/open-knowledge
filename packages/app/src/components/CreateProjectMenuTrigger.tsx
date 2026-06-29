
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
