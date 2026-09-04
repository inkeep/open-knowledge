import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { getAgentThreadClient, ThreadChannelUnavailableError } from '@/lib/acp/thread-client';
import { stageThreadDraft } from '@/lib/acp/thread-draft-staging';

const inflightLaunches = new Set<string>();

export type ThreadLaunchOutcome = 'started' | 'deduped' | 'failed';

export function launchAgentThread(
  agent: { source: 'registry' | 'custom'; id: string },
  prompt: string | null,
  docName: string | null,
  titleHint: string | null,
  stageDraft?: string | null,
  attachments?: readonly AttachmentPart[],
): Promise<ThreadLaunchOutcome> {
  const launchKey = `${agent.source}:${agent.id}`;
  if (inflightLaunches.has(launchKey)) return Promise.resolve('deduped');
  inflightLaunches.add(launchKey);
  return getAgentThreadClient()
    .createThread({
      agent,
      prompt: prompt ?? undefined,
      docName: docName ?? undefined,
      titleHint: titleHint ?? undefined,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    })
    .then((info) => {
      if (stageDraft != null) {
        try {
          stageThreadDraft(info.threadId, stageDraft);
        } catch (err) {
          console.error('[agent-threads] draft staging failed for', info.threadId, err);
        }
      }
      return 'started' as const;
    })
    .catch((err) => {
      console.error('[agent-threads] launch failed:', err);
      toast.error(
        err instanceof ThreadChannelUnavailableError
          ? t`Couldn't connect to the agent service. Make sure the OpenKnowledge server is running and up to date (restart it if it was already running), then try again.`
          : t`Couldn't start the agent thread — please try again.`,
      );
      return 'failed' as const;
    })
    .finally(() => {
      inflightLaunches.delete(launchKey);
    });
}

export function hasInflightThreadLaunch(): boolean {
  return inflightLaunches.size > 0;
}
