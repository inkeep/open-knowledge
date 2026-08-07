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
import { stageThreadDraft } from '@/lib/acp/thread-draft-staging';

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
 *
 * `stageDraft` seeds the new thread's composer with text the user is meant to
 * review before sending (a ⌘J selection send, a Problems-panel "Ask AI"). It is
 * deliberately separate from `prompt`: a prompt runs on creation, a staged draft
 * waits on the user's send. Passing both is legal but unusual — the prompt runs
 * and the draft sits under it as the follow-up.
 */
export function launchAgentThread(
  agent: { source: 'registry' | 'custom'; id: string },
  prompt: string | null,
  docName: string | null,
  titleHint: string | null,
  stageDraft?: string | null,
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
    .then((info) => {
      // Staged only once the server has minted the id the composer is keyed by.
      // Isolated from the shared catch below: by the time this runs the thread
      // EXISTS, so letting a staging failure fall through would log "launch
      // failed" and tell the user to retry a launch that actually succeeded.
      if (stageDraft != null) {
        try {
          stageThreadDraft(info.threadId, stageDraft);
        } catch (err) {
          console.error('[agent-threads] draft staging failed for', info.threadId, err);
        }
      }
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

/**
 * Whether any agent-thread launch is still mid-flight in this window. `createThread`
 * resolves the new thread into the shared store seconds later, so a caller that
 * auto-creates a conversation on some UI transition (e.g. the sessions dock seeding
 * an empty panel on reveal) would open a duplicate if it fired during that gap.
 * Gate such seeding on this. Because the set clears in the `finally` above on BOTH
 * success and failure, a launch that never lands re-enables seeding rather than
 * disabling it for good.
 */
export function hasInflightThreadLaunch(): boolean {
  return inflightLaunches.size > 0;
}
