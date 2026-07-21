/**
 * Binds the resolved collab URL onto the module-scope agent-thread client (swapping
 * `/collab` → `/collab/thread`). Mounted once in EditorPane so the client connects,
 * lists, and replays regardless of whether the sessions dock is open — thread
 * liveness is independent of the dock's visibility.
 *
 * Lifted out of the retired `AgentThreadRegion`, which used to own this binding
 * alongside the standalone agent dock. Renders nothing.
 */

import { useEffect } from 'react';
import { getAgentThreadClient, threadUrlFromCollabUrl } from '@/lib/acp/thread-client';
import { useCollabUrl } from '@/lib/use-collab-url';

export function AgentThreadClientBinder(): null {
  const { collabUrl } = useCollabUrl();

  // The client reconnects when the URL changes and replays any missed events per
  // thread, so a mid-session project switch (Electron) or a reconnect is transparent.
  useEffect(() => {
    getAgentThreadClient().setUrl(threadUrlFromCollabUrl(collabUrl));
  }, [collabUrl]);

  return null;
}
