import { useEffect, useState } from 'react';
import { z } from 'zod';
import { parseServerResponse, parseSuccessOrWarn } from '@/lib/parse-server-response';

const GeneratedIndexSettingsStatusSchema = z.object({
  enabled: z.boolean(),
  active: z.boolean(),
  git: z.object({
    state: z.enum(['not-applicable', 'ready', 'missing', 'conflict', 'unavailable']),
    ownership: z.enum(['open-knowledge', 'existing']).optional(),
  }),
  applied: z.boolean().optional(),
  reason: z.enum(['git-conflict', 'git-unavailable', 'config-write']).optional(),
});

export type GeneratedIndexSettingsStatus = z.infer<typeof GeneratedIndexSettingsStatusSchema>;
export type GeneratedIndexSettingsIssue =
  | 'git-conflict'
  | 'git-unavailable'
  | 'config-write'
  | 'connection';

type GeneratedIndexSettingsFeedback = {
  issue: GeneratedIndexSettingsIssue;
  requestedEnabled: boolean | null;
};

async function requestStatus(init?: RequestInit): Promise<{
  status: GeneratedIndexSettingsStatus | null;
  issue: GeneratedIndexSettingsIssue | null;
}> {
  try {
    const response = await fetch('/api/generated-index/settings', init);
    const parsed = await parseServerResponse(
      response,
      'Open Knowledge could not update index generation.',
    );
    if (!parsed.ok) return { status: null, issue: 'connection' };
    const status = parseSuccessOrWarn(
      GeneratedIndexSettingsStatusSchema,
      parsed.body,
      'generated-index-settings',
      null,
    );
    if (!status) return { status: null, issue: 'connection' };
    return {
      status,
      issue: status.applied === false ? (status.reason ?? 'connection') : null,
    };
  } catch {
    return { status: null, issue: 'connection' };
  }
}

export function useGeneratedIndexSettings() {
  const [status, setStatus] = useState<GeneratedIndexSettingsStatus | null>(null);
  const [issue, setIssue] = useState<GeneratedIndexSettingsFeedback | null>(null);
  const [rejectedUpdate, setRejectedUpdate] = useState<GeneratedIndexSettingsFeedback | null>(null);
  const [pending, setPending] = useState(false);

  function refresh(): void {
    void requestStatus().then((result) => {
      if (result.status) {
        setStatus(result.status);
        const { enabled } = result.status;
        setRejectedUpdate((current) => (current?.requestedEnabled === enabled ? null : current));
      }
      setIssue((current) => {
        if (result.issue === null) return null;
        if (result.issue === 'connection' && current?.issue === 'connection') return current;
        return { issue: result.issue, requestedEnabled: null };
      });
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: one mount-owned poller; refresh closes only over stable state setters.
  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(interval);
  }, []);

  async function setEnabled(enabled: boolean): Promise<boolean> {
    setPending(true);
    const result = await requestStatus({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    setPending(false);
    if (result.status) setStatus(result.status);
    setIssue(result.issue ? { issue: result.issue, requestedEnabled: enabled } : null);
    if (result.status?.applied === true) setRejectedUpdate(null);
    else if (result.status?.applied === false && result.status.reason) {
      setRejectedUpdate({ issue: result.status.reason, requestedEnabled: enabled });
    }
    return result.status?.applied === true;
  }

  const shown = issue ?? rejectedUpdate;
  return {
    status,
    issue: shown?.issue ?? null,
    requestedEnabled: shown?.requestedEnabled ?? null,
    pending,
    refresh,
    setEnabled,
  };
}
