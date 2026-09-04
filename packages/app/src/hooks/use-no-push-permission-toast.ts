import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

export function useNoPushPermissionToast(pausedReason: string | undefined): void {
  const { t } = useLingui();
  const firedRef = useRef(false);
  useEffect(() => {
    if (pausedReason === 'no-push-permission' && !firedRef.current) {
      firedRef.current = true;
      toast.info(t`Sync paused — you don't have permission to push to this repo`);
    }
  }, [pausedReason, t]);
}
