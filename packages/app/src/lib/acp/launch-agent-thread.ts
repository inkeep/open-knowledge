/**
 * Fire an agent-thread creation with double-click dedup + user-facing failure
 * toast — the launch path shared by every "Start an agent" surface (the sessions
 * dock's New button, the handoff-menu launch bus, the catalog dialog's own
 * launches route through the client directly).
 *
 * Lifted out of the retired `AgentThreadRegion` so the sessions dock host and the
 * launch bus can both invoke it without re-implementing the in-flight guard.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { getAgentThreadClient, ThreadChannelUnavailableError } from '@/lib/acp/thread-client';

/**
 * One launch per agent may be in flight at a time: creation can take seconds
 * (npx install + handshake) and every extra click would spawn another agent that
 * immediately runs the launch prompt on the customer's account, so impatient
 * double-clicks drop rather than duplicate. Module-scope so it survives the
 * host's re-renders and spans every launch surface in the window.
 */
const inflightLaunches = new Set<string>();

/**
 * Create a thread for a concrete agent. Agent-level failures stream into the dock
 * as thread status events; the catch fires only when no thread was created at all,
 * so a toast is the sole feedback channel there.
 */
export function launchAgentThread(
  agent: { source: 'registry' | 'custom'; id: string },
  prompt: string | null,
  docName: string | null,
  titleHint: string | null,
): void {
  const launchKey = `${agent.source}:${agent.id}`;
  if (inflightLaunches.has(launchKey)) return;
  inflightLaunches.add(launchKey);
  void getAgentThreadClient()
    .createThread({
      agent,
      prompt: prompt ?? undefined,
      docName: docName ?? undefined,
      titleHint: titleHint ?? undefined,
    })
    .catch((err) => {
      console.error('[agent-threads] launch failed:', err);
      toast.error(
        err instanceof ThreadChannelUnavailableError
          ? t`Couldn't connect to the agent service. Make sure the OpenKnowledge server is running and up to date (restart it if it was already running), then try again.`
          : t`Couldn't start the agent thread — please try again.`,
      );
    })
    .finally(() => {
      inflightLaunches.delete(launchKey);
    });
}
