import { ServerInfoSuccessSchema } from '@inkeep/open-knowledge-core';
import { handleBranchSwitched } from '../editor/branch-invalidation';
import type { ProviderPool } from '../editor/provider-pool';
import { emitBranchChanged } from './documents-events';
import { setServerInstanceId } from './server-instance-store';

export function createSyncedReconnectGate(onReconnect: () => void): () => void {
  let hadFirstSynced = false;
  return () => {
    if (hadFirstSynced) {
      onReconnect();
    } else {
      hadFirstSynced = true;
    }
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function refreshServerInfo(pool: ProviderPool, baseUrl = ''): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/server-info`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return;
  }
  if (!response.ok) return;
  let info: unknown;
  try {
    info = await response.json();
  } catch {
    return;
  }
  const result = ServerInfoSuccessSchema.safeParse(info);
  if (!result.success) {
    console.warn(
      JSON.stringify({ event: 'ok-server-info-schema-mismatch', issues: result.error.issues }),
    );
    return;
  }

  pool.setExpectedServerInstanceId(result.data.serverInstanceId);
  setServerInstanceId(result.data.serverInstanceId);

  if (result.data.currentBranch !== undefined) {
    if (pool.compareAndUpdateObservedBranch(result.data.currentBranch)) {
      void handleBranchSwitched(pool, result.data.currentBranch);
      emitBranchChanged(result.data.currentBranch);
    }
  }

  if (result.data.currentDiskAckSVs !== undefined) {
    const decoded: Record<string, Uint8Array> = {};
    for (const [docName, svBase64] of Object.entries(result.data.currentDiskAckSVs)) {
      try {
        decoded[docName] = base64ToBytes(svBase64);
      } catch {}
    }
    pool.observeDiskAckBatch(decoded);
  }
}
