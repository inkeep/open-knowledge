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
  const [issue, setIssue] = useState<GeneratedIndexSettingsIssue | null>(null);
  const [pending, setPending] = useState(false);

  function refresh(): void {
    void requestStatus().then((result) => {
      if (result.status) setStatus(result.status);
      setIssue(result.issue);
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
    setIssue(result.issue);
    return result.status?.applied === true;
  }

  return { status, issue, pending, refresh, setEnabled };
}
