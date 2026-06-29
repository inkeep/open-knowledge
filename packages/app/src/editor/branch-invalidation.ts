
import { z } from 'zod';
import type { ProviderPool } from './provider-pool';

export const BranchSwitchedClearFailedLogSchema = z.object({
  event: z.literal('ok-branch-switched-clear-failed'),
  branch: z.string(),
  docName: z.string(),
  reason: z.string(),
});
type BranchSwitchedClearFailedLog = z.infer<typeof BranchSwitchedClearFailedLogSchema>;

export async function handleBranchSwitched(pool: ProviderPool, branch: string): Promise<void> {
  const clears: Promise<void>[] = [];
  for (const [docName, entry] of pool.entries) {
    if (entry.kind !== 'active') continue;
    if (entry.persistence === null) continue;
    clears.push(
      entry.persistence.clearData().catch((err: unknown) => {
        const log: BranchSwitchedClearFailedLog = {
          event: 'ok-branch-switched-clear-failed',
          docName,
          branch,
          reason: err instanceof Error ? err.message : String(err),
        };
        console.warn(JSON.stringify(log));
      }),
    );
  }
  await Promise.all(clears);
  pool.clearBufferedUpdates();
  pool.recycleAllEntries();
}
