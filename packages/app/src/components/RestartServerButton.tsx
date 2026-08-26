/**
 * Recovery affordance for a surface that can no longer reach its collab
 * server.
 *
 * Retrying the same server is futile once it has exited (`ok stop`, an
 * idle-shutdown, a crash) — the only remedy is a fresh process, which only the
 * desktop bridge can spawn. Browser (`ok ui`) mode has no bridge and nothing
 * to restart, so this renders nothing there.
 */

import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
// Side-effect import for the `Window.okDesktop` global augmentation.
import '@/lib/desktop-bridge-types';
import { restartCollabServer } from '@/lib/restart-collab-server';

export function RestartServerButton({ className }: { className?: string }) {
  // A restart spawns a process and tears this window down; the outstanding
  // call is invisible, so an impatient second click would dispatch a second
  // spawn against a project that is already restarting.
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
            // Success: main tears this window down and recreates it. A fixed
            // `id` dedupes repeated failed clicks into one toast; `Infinity`
            // keeps this actionable error up until it is replaced.
            if (!result.ok) {
              toast.error(result.message, { id: 'server-restart-error', duration: Infinity });
            }
          })
          // The invoke can reject when main destroys this window mid-call
          // (the success path) — nothing to surface.
          .catch(() => {})
          .finally(() => setRestarting(false));
      }}
    >
      <Trans>Restart server</Trans>
    </Button>
  );
}
