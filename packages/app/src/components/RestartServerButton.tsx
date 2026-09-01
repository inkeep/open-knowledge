import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import '@/lib/desktop-bridge-types';
import { restartCollabServer } from '@/lib/restart-collab-server';

export function RestartServerButton({ className }: { className?: string }) {
  const [restarting, setRestarting] = useState(false);
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (!bridge) return null;

  return (
    <Button
      variant="outline-mono"
      size="sm"
      className={className}
      disabled={restarting}
      onClick={() => {
        setRestarting(true);
        restartCollabServer(bridge)
          .then((result) => {
            if (!result.ok) {
              toast.error(result.message, { id: 'server-restart-error', duration: Infinity });
            }
          })
          .catch(() => {})
          .finally(() => setRestarting(false));
      }}
    >
      <Trans>Restart server</Trans>
    </Button>
  );
}
