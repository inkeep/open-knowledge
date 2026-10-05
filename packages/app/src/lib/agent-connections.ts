import type {
  ApplyIntent,
  ApplyReport,
  HostSnapshot,
} from '@inkeep/open-knowledge-core/agent-registry';
import { AgentIntegrationsApplySuccessSchema } from '@inkeep/open-knowledge-core/schemas/api';

export interface ApplyAgentConnectionsResult {
  readonly ok: boolean;
  readonly report: ApplyReport;
  readonly snapshot: HostSnapshot | null;
  readonly error?: string;
  readonly unavailable?: boolean;
  readonly devBuild?: boolean;
}

const EMPTY_REPORT: ApplyReport = { actions: [], conflicts: [], withheld: [] };

function failure(error: string): ApplyAgentConnectionsResult {
  return { ok: false, report: EMPTY_REPORT, snapshot: null, error };
}

function reportSucceeded(report: ApplyReport): boolean {
  return (
    report.conflicts.length === 0 && report.actions.every((action) => action.errorId === undefined)
  );
}

async function requestAgentConnectionIntents(
  intents: readonly ApplyIntent[],
  options?: { readonly webSignal?: AbortSignal },
): Promise<ApplyAgentConnectionsResult> {
  const bridge = globalThis.window?.okDesktop;
  if (bridge !== undefined) {
    try {
      const result = await bridge.agentIntegrations.apply({ intents });
      if (result.ok) return { ok: true, report: result.report, snapshot: result.snapshot };
      return {
        ok: false,
        report: result.report,
        snapshot: result.snapshot,
        error: result.error,
        ...(result.unavailable === true ? { unavailable: true } : {}),
        ...(result.devBuild === true ? { devBuild: true } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        report: EMPTY_REPORT,
        snapshot: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let response: Response;
  try {
    response = await fetch('/api/agent-integrations/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ intents }),
      signal: options?.webSignal,
    });
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }

  if (!response.ok) {
    return failure(`HTTP ${response.status} ${response.statusText}`.trimEnd());
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }

  const parsed = AgentIntegrationsApplySuccessSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join('.'));
    console.warn('[agent-connections] response schema drift', { issues });
    return failure(`Unexpected response shape at ${issues.join(', ')}`);
  }

  const report = {
    actions: parsed.data.actions,
    conflicts: parsed.data.conflicts,
    withheld: parsed.data.withheld,
  } as unknown as ApplyReport;
  return {
    ok: reportSucceeded(report),
    report,
    snapshot: parsed.data.snapshot as unknown as HostSnapshot,
  };
}

const connectionChangeListeners = new Set<(result: ApplyAgentConnectionsResult) => void>();

export function subscribeAgentConnectionChanges(
  listener: (result: ApplyAgentConnectionsResult) => void,
): () => void {
  connectionChangeListeners.add(listener);
  return () => {
    connectionChangeListeners.delete(listener);
  };
}

export async function applyAgentConnectionIntents(
  intents: readonly ApplyIntent[],
  options?: { readonly webSignal?: AbortSignal },
): Promise<ApplyAgentConnectionsResult> {
  const result = await requestAgentConnectionIntents(intents, options);
  if (intents.length > 0) {
    const listeners = [...connectionChangeListeners];
    for (const listener of listeners) {
      try {
        listener(result);
      } catch (err) {
        console.warn('[agent-connections] change listener failed:', err);
      }
    }
  }
  return result;
}
